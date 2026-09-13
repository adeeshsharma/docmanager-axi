import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFlattenedVisibleText } from "../src/core/html-normalize.js";

test("extractFlattenedVisibleText concatenates body text nodes in document order with no separator", () => {
  const html = Buffer.from("<html><body><p>Hello</p><p>world</p></body></html>");
  assert.equal(extractFlattenedVisibleText(html), "Helloworld");
});

test("extractFlattenedVisibleText excludes head, script, and style content", () => {
  const html = Buffer.from(
    "<html><head><title>Title text</title></head><body><script>evil()</script><style>.c{}</style><p>Visible</p></body></html>",
  );
  assert.equal(extractFlattenedVisibleText(html), "Visible");
});

test("extractFlattenedVisibleText preserves internal whitespace exactly, unlike extractPlainText", () => {
  const html = Buffer.from("<html><body><p>a   b\nc</p></body></html>");
  assert.equal(extractFlattenedVisibleText(html), "a   b\nc");
});
