import { parse, serialize } from "parse5";
import { diffLines, diffArrays } from "diff";
import { getFamily, readContent } from "./store.js";
import { prettyForDiff, normalizeHtml } from "./html-normalize.js";

// Per ARCHITECTURE.md section 3.4: the diff shown to the user is computed on
// the normalized form, not the raw bytes - two versions differing only in
// whitespace or attribute order (already treated as the SAME version by
// store.js/reconcile.js) must never show a noisy, meaningless diff. Returns
// the raw structured parts from diffLines() rather than pre-formatted text,
// so the CLI and UI each render it their own way from one shared
// computation instead of duplicating the diff itself.
export function diffVersions(familyId, hashA, hashB) {
  const family = getFamily(familyId);
  if (!family) {
    const err = new Error(`No family with id "${familyId}"`);
    err.code = "FAMILY_NOT_FOUND";
    throw err;
  }
  for (const hash of [hashA, hashB]) {
    if (!family.versions[hash]) {
      const err = new Error(`Family "${familyId}" has no version "${hash}"`);
      err.code = "VERSION_NOT_FOUND";
      throw err;
    }
  }

  const contentA = readContent(hashA);
  const contentB = readContent(hashB);
  const parts = diffLines(prettyForDiff(contentA), prettyForDiff(contentB));

  return {
    family: { id: family.id, syntheticPath: family.syntheticPath },
    from: hashA,
    to: hashB,
    parts,
  };
}

// Tags recognized as "diffable leaf content" - the level of granularity a
// block-level rendered diff highlights at. Deliberately not word-level: a
// word-by-word text-splice-and-reinsert approach can produce broken markup
// when a diffed span crosses element boundaries. Marking whole elements
// that already exist in the tree - never splitting, moving, or
// reconstructing markup - is safe by construction, at the cost of coarser
// highlighting (a paragraph with one changed word highlights as a whole).
const LEAF_BLOCK_TAGS = new Set([
  "p", "li", "h1", "h2", "h3", "h4", "h5", "h6",
  "td", "th", "blockquote", "dt", "dd", "figcaption", "caption", "pre",
]);

function hasBlockDescendant(node) {
  for (const child of node.childNodes ?? []) {
    if (LEAF_BLOCK_TAGS.has(child.tagName) || hasBlockDescendant(child)) return true;
  }
  return false;
}

function collectLeafBlocks(node, out) {
  if (node.tagName && LEAF_BLOCK_TAGS.has(node.tagName) && !hasBlockDescendant(node)) {
    out.push(node);
    return;
  }
  for (const child of node.childNodes ?? []) collectLeafBlocks(child, out);
}

function findBody(node) {
  if (node.tagName === "body") return node;
  for (const child of node.childNodes ?? []) {
    const found = findBody(child);
    if (found) return found;
  }
  return null;
}

// A document with none of the recognized block tags (a bare
// <body>text</body>, or a custom structure built entirely from <div>s)
// would otherwise get zero diff units and no highlighting at all - falling
// back to the direct element children of <body> means there's still
// something meaningful to compare, even if less precise.
function diffUnitsFor(document) {
  const blocks = [];
  collectLeafBlocks(document, blocks);
  if (blocks.length >= 2) return blocks;
  const body = findBody(document);
  return body ? (body.childNodes ?? []).filter((n) => n.tagName) : blocks;
}

// diffArrays(otherStrings, selfStrings) walks parts in order; a part is
// only ever missing from one side (removed = otherStrings-only, added =
// selfStrings-only). Consuming parts where `removed` is not set replays
// selfStrings' own sequence in order, so each value lines up positionally
// with selfBlocks - this is what lets classifications[i] correspond
// directly to selfBlocks[i] without any extra bookkeeping.
function classifySelfBlocks(otherStrings, selfStrings) {
  const parts = diffArrays(otherStrings, selfStrings);
  const classifications = [];
  for (const part of parts) {
    if (part.removed) continue;
    const state = part.added ? "exclusive" : "common";
    for (let i = 0; i < part.value.length; i++) classifications.push(state);
  }
  return classifications;
}

function injectIntoHead(html, headContent) {
  if (html.includes("<head>")) return html.replace("<head>", `<head>${headContent}`);
  if (/<body[^>]*>/.test(html)) return html.replace(/<body([^>]*)>/, `<body$1>${headContent}`);
  return headContent + html;
}

// GitHub's own diff colors (well-known, not invented here): a light tint
// plus a solid-colored left border reads as "changed" clearly without
// needing strikethrough, which real reviewers use for line-level code
// diffs but which makes a whole removed PROSE paragraph noticeably harder
// to read - dropped here for exactly that reason.
//
// Background alone isn't enough for a guaranteed-readable overlay: this is
// injected into an ARBITRARY tracked document whose own CSS is completely
// unknown - it could set its own text color, a dark background, anything.
// Forcing BOTH background and text color together as one matched,
// deliberately-chosen-for-contrast pair is what actually guarantees
// readability regardless of the underlying document's own styling; setting
// only one of the two would leave real cases (e.g. a dark-themed tracked
// document) with light-on-light or dark-on-dark illegible text.
//
// `!important` is a genuine, deliberate exception here, not a habit - this
// project's own stylesheet discipline (see style.css) avoids it for
// internal specificity fights, but this rule is overlaying a diagnostic
// marker on top of arbitrary, unknown third-party CSS with unpredictable
// specificity (even an inline style="color:..." on the element), which
// `!important` is the correct tool for. The `*` descendant rule extends the
// same guarantee to anything nested inside a marked block (a link or
// bold span with its own explicit color) - inheritance alone would lose to
// any such rule, `!important` or not, since a more specific rule on the
// child itself always wins over an inherited value.
const REMOVED_CSS = `
[data-diff="removed"], [data-diff="removed"] * { color:#82071e !important; }
[data-diff="removed"] { background:#ffebe9 !important; box-shadow:inset 3px 0 0 #cf222e; padding-left:0.5em; }
@media (prefers-color-scheme: dark) {
  [data-diff="removed"], [data-diff="removed"] * { color:#ffb3ae !important; }
  [data-diff="removed"] { background:#3c1618 !important; box-shadow:inset 3px 0 0 #f85149; }
}`;
const ADDED_CSS = `
[data-diff="added"], [data-diff="added"] * { color:#116329 !important; }
[data-diff="added"] { background:#e6ffec !important; box-shadow:inset 3px 0 0 #1a7f37; padding-left:0.5em; }
@media (prefers-color-scheme: dark) {
  [data-diff="added"], [data-diff="added"] * { color:#7ee2a8 !important; }
  [data-diff="added"] { background:#0f2e1a !important; box-shadow:inset 3px 0 0 #3fb950; }
}`;

// The UI's two comparison panes are sandboxed (allow-scripts, no
// allow-same-origin - ARCHITECTURE.md section 5), so the parent page has no
// way to read or set either iframe's scroll position directly; postMessage
// is the one channel that still works across that boundary. This script
// reports its own scroll position as a RATIO (not a pixel offset, since the
// two versions are almost never the same length) whenever the reader
// scrolls, and applies an incoming ratio from the other pane the same way.
//
// Two things make this feel smooth rather than jittery, both real fixes for
// real observed stutter, not guesses:
// - Outgoing reports are throttled to once per animation frame (a raw
//   `scroll` event can fire far faster than that during a fast trackpad/wheel
//   gesture) - flooding postMessage at native event frequency is what was
//   actually causing the two panes to visibly lag and catch up rather than
//   move together.
// - The `syncing` guard - which exists to stop a programmatic scroll from
//   re-triggering its own outbound message and ping-ponging the two panes
//   into each other - releases on a short timeout, not requestAnimationFrame.
//   The native "scroll" event a programmatic scrollTo() produces fires
//   asynchronously with no guaranteed ordering against rAF, so releasing on
//   rAF could let that resulting event slip through the guard before it's
//   actually fired, bounce a stale correction back to the sender, and
//   visibly stutter. A ~120ms timeout reliably outlasts it.
const SCROLL_SYNC_SCRIPT = `<script>(function(){
  var syncing = false;
  var syncTimer = null;
  var reportScheduled = false;

  function ratio() {
    var max = document.documentElement.scrollHeight - window.innerHeight;
    return max > 0 ? window.scrollY / max : 0;
  }

  function reportScroll() {
    reportScheduled = false;
    if (syncing) return;
    parent.postMessage({ source: 'docmanager-diff-scroll', ratio: ratio() }, '*');
  }

  window.addEventListener('scroll', function() {
    if (syncing || reportScheduled) return;
    reportScheduled = true;
    requestAnimationFrame(reportScroll);
  }, { passive: true });

  window.addEventListener('message', function(event) {
    var data = event.data;
    if (!data || data.source !== 'docmanager-diff-scroll-to') return;
    syncing = true;
    if (syncTimer) clearTimeout(syncTimer);
    var max = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(0, data.ratio * Math.max(max, 0));
    syncTimer = setTimeout(function() { syncing = false; }, 120);
  });
})();</script>`;

/**
 * Renders ONE version's content with block-level visual highlighting of
 * what differs from another version - for the UI's side-by-side rendered
 * comparison, reading the actual document rather than its source markup.
 * `mode` is "removed" (this content is being compared as the "from" side -
 * its exclusive blocks get struck through in red) or "added" (the "to"
 * side - its exclusive blocks get a green highlight). Purely a labeling
 * choice for the caller; the underlying block-matching logic is identical
 * either way, see classifySelfBlocks().
 */
export function renderHighlightedContent(targetContent, otherContent, mode) {
  const targetDoc = parse(normalizeHtml(targetContent));
  const otherDoc = parse(normalizeHtml(otherContent));

  const targetBlocks = diffUnitsFor(targetDoc);
  const otherBlocks = diffUnitsFor(otherDoc);
  const targetStrings = targetBlocks.map((node) => serialize(node));
  const otherStrings = otherBlocks.map((node) => serialize(node));

  const classifications = classifySelfBlocks(otherStrings, targetStrings);
  targetBlocks.forEach((node, i) => {
    if (classifications[i] === "exclusive") {
      node.attrs = [...(node.attrs ?? []), { name: "data-diff", value: mode }];
    }
  });

  const html = serialize(targetDoc);
  const css = mode === "removed" ? REMOVED_CSS : ADDED_CSS;
  return injectIntoHead(html, `<style>${css}</style>${SCROLL_SYNC_SCRIPT}`);
}
