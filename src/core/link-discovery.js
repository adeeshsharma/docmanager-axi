import { parse } from "parse5";
import { existsSync, realpathSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";

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
