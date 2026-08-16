import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHighlightedContent } from "../src/core/diff.js";

test("a changed paragraph is marked, an unchanged one is left untouched", () => {
  const a = Buffer.from("<html><body><p>Original text.</p><p>Same both times.</p></body></html>");
  const b = Buffer.from("<html><body><p>Updated text.</p><p>Same both times.</p></body></html>");

  const removedView = renderHighlightedContent(a, b, "removed");
  assert.match(removedView, /<p data-diff="removed">Original text\.<\/p>/);
  assert.match(removedView, /<p>Same both times\.<\/p>/);

  const addedView = renderHighlightedContent(b, a, "added");
  assert.match(addedView, /<p data-diff="added">Updated text\.<\/p>/);
  assert.match(addedView, /<p>Same both times\.<\/p>/);
});

// The injected <style> block's own CSS selector text ("[data-diff=...]")
// legitimately contains the string "data-diff" regardless of whether
// anything was actually marked - assertions have to specifically look for
// the HTML *attribute* form (preceded by whitespace after a tag name), not
// just the bare substring, or they'd always "find" the CSS text itself.
function countMarkedElements(html, mode) {
  return (html.match(new RegExp(` data-diff="${mode}"`, "g")) ?? []).length;
}

test("identical content produces no data-diff markings on either side", () => {
  const a = Buffer.from("<html><body><p>Same content.</p></body></html>");
  const b = Buffer.from("<html><body><p>Same content.</p></body></html>");
  assert.equal(countMarkedElements(renderHighlightedContent(a, b, "removed"), "removed"), 0);
  assert.equal(countMarkedElements(renderHighlightedContent(b, a, "added"), "added"), 0);
});

test("multiple changed blocks are each marked, not just the first", () => {
  const a = Buffer.from("<html><body><p>First old.</p><p>Middle same.</p><p>Third old.</p></body></html>");
  const b = Buffer.from("<html><body><p>First new.</p><p>Middle same.</p><p>Third new.</p></body></html>");
  const view = renderHighlightedContent(a, b, "removed");
  assert.equal(countMarkedElements(view, "removed"), 2);
  assert.match(view, /<p>Middle same\.<\/p>/, "the unchanged middle block must stay unmarked");
});

test("falls back to direct body children when no recognized block tags exist", () => {
  const a = Buffer.from("<html><body><div>Alpha</div><div>Beta</div></body></html>");
  const b = Buffer.from("<html><body><div>Alpha changed</div><div>Beta</div></body></html>");
  const view = renderHighlightedContent(a, b, "removed");
  assert.match(view, /<div data-diff="removed">Alpha<\/div>/);
  assert.match(view, /<div>Beta<\/div>/);
});

test("injects a style block scoped to the requested mode, forcing both background AND text color for readability", () => {
  const a = Buffer.from("<html><body><p>x</p></body></html>");
  const b = Buffer.from("<html><body><p>y</p></body></html>");
  const removedView = renderHighlightedContent(a, b, "removed");
  assert.match(removedView, /\[data-diff="removed"\][^}]*\{[^}]*background:#ffebe9/);
  assert.match(removedView, /\[data-diff="removed"\][^}]*color:#82071e/);
  // Never strikethrough a whole removed prose block - a real, deliberate
  // choice, not an oversight (see the code comment in diff.js).
  assert.doesNotMatch(removedView, /line-through/);

  const addedView = renderHighlightedContent(b, a, "added");
  assert.match(addedView, /\[data-diff="added"\][^}]*\{[^}]*background:#e6ffec/);
  assert.match(addedView, /\[data-diff="added"\][^}]*color:#116329/);
});

test("also forces a readable text color on descendants of a marked block, not just the block itself", () => {
  const a = Buffer.from("<html><body><p>old</p></body></html>");
  const b = Buffer.from("<html><body><p>new</p></body></html>");
  const view = renderHighlightedContent(a, b, "removed");
  assert.match(view, /\[data-diff="removed"\] \*[^}]*color:#82071e/);
});

test("includes a dark-mode variant so the highlight stays readable against a dark tracked document too", () => {
  const a = Buffer.from("<html><body><p>x</p></body></html>");
  const b = Buffer.from("<html><body><p>y</p></body></html>");
  const view = renderHighlightedContent(a, b, "removed");
  assert.match(view, /@media \(prefers-color-scheme: dark\)/);
});

test("injects the scroll-sync script so the two rendered panes can scroll together", () => {
  const a = Buffer.from("<html><body><p>x</p></body></html>");
  const b = Buffer.from("<html><body><p>y</p></body></html>");
  const view = renderHighlightedContent(a, b, "removed");
  // The two panes are cross-origin (sandboxed, no allow-same-origin) - this
  // is the one channel that still works between them, so its presence is a
  // real, load-bearing part of the feature, not incidental.
  assert.match(view, /<script>/);
  assert.match(view, /postMessage/);
  assert.match(view, /docmanager-diff-scroll/);
});

test("never throws on malformed or minimal HTML", () => {
  assert.doesNotThrow(() => renderHighlightedContent(Buffer.from("<p>unclosed"), Buffer.from("<p>also unclosed"), "removed"));
  assert.doesNotThrow(() => renderHighlightedContent(Buffer.from(""), Buffer.from("<p>x</p>"), "removed"));
});
