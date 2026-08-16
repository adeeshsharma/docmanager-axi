import { parse, serialize } from "parse5";

// parse5 is the real WHATWG HTML parsing algorithm (the same one browsers
// use), not a strict XML-style parser - it tolerates real-world, not
// perfectly well-formed HTML the way a stricter parser would refuse to.
// Parsing then re-serializing already canonicalizes structure (fixes up
// malformed markup into what a browser would actually construct); sorting
// each element's attributes on top of that additionally makes attribute
// order insignificant, per ARCHITECTURE.md section 3.4.
function sortAttributesRecursively(node) {
  if (node.attrs) {
    node.attrs = [...node.attrs].sort((a, b) => a.name.localeCompare(b.name));
  }
  if (node.childNodes) {
    for (const child of node.childNodes) sortAttributesRecursively(child);
  }
}

// parse5's own parse -> serialize round trip preserves whitespace exactly -
// it fixes up malformed structure, but a newline and indentation inserted
// purely for source formatting between tags survives untouched. A
// purely-whitespace text node is never meaningfully rendered content, so
// it's always safe to drop. A text node WITH real content keeps its
// leading/trailing whitespace (that can be adjacency-significant next to
// inline siblings) but has internal whitespace RUNS collapsed to one space,
// matching how a browser collapses runs of source whitespace when
// rendering.
function normalizeWhitespaceRecursively(node) {
  if (!node.childNodes) return;
  node.childNodes = node.childNodes.filter(
    (child) => !(child.nodeName === "#text" && /^\s*$/.test(child.value)),
  );
  for (const child of node.childNodes) {
    if (child.nodeName === "#text") {
      child.value = child.value.replace(/[ \t\n\r\f]+/g, " ");
    } else {
      normalizeWhitespaceRecursively(child);
    }
  }
}

export function normalizeHtml(buffer) {
  const text = buffer.toString("utf8");
  const document = parse(text);
  sortAttributesRecursively(document);
  normalizeWhitespaceRecursively(document);
  return serialize(document);
}

export function isSameNormalizedHtml(bufferA, bufferB) {
  return normalizeHtml(bufferA) === normalizeHtml(bufferB);
}

function findFirstText(node, tagName) {
  if (node.tagName === tagName) {
    return (node.childNodes ?? [])
      .map((c) => c.value ?? "")
      .join("")
      .trim();
  }
  for (const child of node.childNodes ?? []) {
    const found = findFirstText(child, tagName);
    if (found) return found;
  }
  return null;
}

// A document's own <title>, falling back to its first <h1> when there's no
// <title> - both are real, common signals of "what is this document called"
// independent of the synthetic path the user happened to track it under.
// Shared by suggest.js's duplicate-suggestion heuristic and index.js's
// search indexing, so there is exactly one implementation to keep correct.
export function extractTitle(buffer) {
  const document = parse(buffer.toString("utf8"));
  return findFirstText(document, "title") || findFirstText(document, "h1") || null;
}

// Nothing under <head> (title, meta, link, script, style...) is ever
// rendered as visible page content, and <script>/<style> anywhere else
// aren't something a user would search for by the words inside them - the
// document's own <title> is already indexed as its own separate, deliberate
// signal (see extractTitle()), so this stays genuinely body-only.
const NON_VISIBLE_TAGS = new Set(["head", "script", "style"]);

function collectText(node, out) {
  if (node.nodeName === "#text") {
    out.push(node.value);
    return;
  }
  if (NON_VISIBLE_TAGS.has(node.tagName)) return;
  for (const child of node.childNodes ?? []) collectText(child, out);
}

// The document's visible text, stripped of all markup - for search
// indexing specifically, not for diffing or equality (normalizeHtml()
// already covers those, and is deliberately left untouched by this).
export function extractPlainText(buffer) {
  const document = parse(buffer.toString("utf8"));
  const parts = [];
  collectText(document, parts);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// Display-only, for diffing - kept entirely separate from normalizeHtml()
// itself so nothing about the existing equality-comparison behavior changes.
// normalizeHtml()'s own output isn't line-shaped (whitespace-only text nodes
// are dropped, so tags end up butted directly against each other), which is
// exactly right for an equality check but unreadable as a line diff. Insert
// a newline before every tag so each open/close tag (with any inline text
// attached) becomes its own line - a common, readable HTML-diff granularity.
export function prettyForDiff(buffer) {
  return normalizeHtml(buffer)
    .replace(/(?=<)/g, "\n")
    .split("\n")
    .filter((line) => line.length > 0)
    .join("\n");
}
