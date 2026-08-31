import { parse, serialize } from "parse5";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { trackPath } from "./track.js";

// Only a relative link to an existing .html file is in scope - everything
// else (any URL scheme, protocol-relative, site-root-relative, mailto/tel,
// a bare #fragment) is left exactly as it is today. See the design doc's
// section 1 - this is a deliberate boundary, not a partial implementation.
// Site-root-relative ("/x.html") is excluded specifically because this
// project has no "document root" concept to resolve it against - treating
// it as a literal filesystem-absolute path would be exactly the kind of
// unbounded-escape risk linkRoot exists to prevent.
export function resolveHrefTarget(href, sourceRealPath) {
  if (!href) return null;
  if (href.startsWith("#")) return null;
  if (href.startsWith("/")) return null;
  if (href.startsWith("//")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null; // any URL scheme (http:, mailto:, tel:, data:, ...)

  const withoutFragment = href.split("#")[0];
  if (!withoutFragment) return null;

  const candidate = resolve(dirname(sourceRealPath), withoutFragment);
  if (extname(candidate).toLowerCase() !== ".html") return null;
  if (!existsSync(candidate)) return null;
  try {
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

function isWithinRoot(realPath, root) {
  return realPath === root || realPath.startsWith(root + sep);
}

function findAnchorHrefs(node, out) {
  if (node.tagName === "a" && node.attrs) {
    const hrefAttr = node.attrs.find((a) => a.name === "href");
    if (hrefAttr) out.push(hrefAttr.value);
  }
  for (const child of node.childNodes ?? []) findAnchorHrefs(child, out);
}

/**
 * Every real path an in-scope <a href> in `content` resolves to, bounded to
 * `linkRoot` - a link escaping the root, or pointing at a missing/non-.html
 * file, is silently excluded (never an error - design doc section 2).
 * Deduplicated; order is not significant to callers.
 */
export function discoverLinkTargets(content, sourceRealPath, linkRoot) {
  const document = parse(content.toString("utf8"));
  const hrefs = [];
  findAnchorHrefs(document, hrefs);

  const rootReal = existsSync(linkRoot) ? realpathSync(linkRoot) : linkRoot;
  const targets = new Set();
  for (const href of hrefs) {
    const resolved = resolveHrefTarget(href, sourceRealPath);
    if (resolved && isWithinRoot(resolved, rootReal)) targets.add(resolved);
  }
  return [...targets];
}

/**
 * BFS from `startRealPath`'s own links (not `startRealPath` itself - the
 * caller is always the one who tracked the starting document; this only
 * ever tracks what it LINKS TO). Bounded to `linkRoot` throughout, with a
 * visited-real-paths guard so a cycle (A links to B links back to A)
 * terminates instead of looping. An already-tracked target is still
 * enqueued for further crawling (it just doesn't get a new family created)
 * so the WHOLE reachable cluster within linkRoot ends up covered in one
 * call, not just the newly-discovered subset of it.
 */
export async function discoverAndTrackLinkedDocuments(startRealPath, linkRoot) {
  const visited = new Set([startRealPath]);
  const queue = [startRealPath];
  const results = [];

  while (queue.length > 0) {
    const currentRealPath = queue.shift();
    let content;
    try {
      content = readFileSync(currentRealPath);
    } catch {
      continue; // vanished between discovery and read - not fatal to the rest of the crawl
    }

    for (const targetRealPath of discoverLinkTargets(content, currentRealPath, linkRoot)) {
      if (visited.has(targetRealPath)) continue;
      visited.add(targetRealPath);
      try {
        const { family, alreadyTracked } = await trackPath(targetRealPath, { linkRoot });
        results.push({ path: targetRealPath, status: alreadyTracked ? "already-tracked" : "tracked", family });
        queue.push(targetRealPath);
      } catch (err) {
        results.push({ path: targetRealPath, status: "error", error: err.message, code: err.code });
      }
    }
  }

  return { results };
}

function rewriteAnchorHrefs(node, sourceRealPath, resolveHrefHash) {
  let rewroteAny = false;
  if (node.tagName === "a" && node.attrs) {
    const hrefAttr = node.attrs.find((a) => a.name === "href");
    if (hrefAttr) {
      const resolved = resolveHrefTarget(hrefAttr.value, sourceRealPath);
      if (resolved) {
        const hash = resolveHrefHash(resolved);
        if (hash) {
          hrefAttr.value = `/content/${hash}`;
          node.attrs.push({ name: "data-docmanager-hash", value: hash });
          rewroteAny = true;
        }
      }
    }
  }
  for (const child of node.childNodes ?? []) {
    if (rewriteAnchorHrefs(child, sourceRealPath, resolveHrefHash)) rewroteAny = true;
  }
  return rewroteAny;
}

/**
 * Rewrites every in-scope <a href> in `content` to /content/<hash>, where
 * `hash` comes from `resolveHrefHash(realPath)` - called once per in-scope
 * href with the real path it resolves to. Returning a falsy value leaves
 * that href completely untouched (unresolved is never an error). Recomputed
 * fresh on every call by design - no caching, matching diff.js's own
 * normalization, which already recomputes every time: a cached rewrite of A
 * would need invalidating the instant a linked document's head moves, even
 * though A's own hash never changed.
 */
export function rewriteLinks(content, sourceRealPath, resolveHrefHash) {
  const document = parse(content.toString("utf8"));
  const rewroteAny = rewriteAnchorHrefs(document, sourceRealPath, resolveHrefHash);
  return { html: serialize(document), rewroteAny };
}

// Injected into served content only when rewriteLinks actually rewrote at
// least one href (no point adding a listener that will never fire).
// Intercepts a click on a rewritten anchor specifically (identified by the
// data-docmanager-hash rewriteLinks() marks it with, not by re-parsing its
// href) and hands off to the parent page via postMessage instead of letting
// the sandboxed iframe navigate itself - same postMessage-across-a-sandbox
// pattern diff.js's own SCROLL_SYNC_SCRIPT already uses.
export const LINK_CLICK_SCRIPT = `<script>(function(){
  document.addEventListener('click', function(event) {
    var a = event.target.closest ? event.target.closest('a[data-docmanager-hash]') : null;
    if (!a) return;
    event.preventDefault();
    parent.postMessage({ source: 'docmanager-navigate-link', hash: a.getAttribute('data-docmanager-hash') }, '*');
  });
})();</script>`;
