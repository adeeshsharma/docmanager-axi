import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHrefTarget, discoverLinkTargets } from "../src/core/link-discovery.js";

let fixtureDir;
beforeEach(() => {
  fixtureDir = realpathSync(mkdtempSync(join(tmpdir(), "docmanager-linkdisc-")));
});
afterEach(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

function write(relPath, content) {
  const full = join(fixtureDir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  return full;
}

test("resolveHrefTarget resolves a relative href against the source file's own directory", () => {
  const source = write("docs/a.html", "<html></html>");
  write("docs/b.html", "<html></html>");
  assert.equal(resolveHrefTarget("b.html", source), join(fixtureDir, "docs", "b.html"));
});

test("resolveHrefTarget resolves ../ correctly relative to the source, not any shared root", () => {
  const source = write("docs/sub/a.html", "<html></html>");
  write("docs/shared/glossary.html", "<html></html>");
  assert.equal(resolveHrefTarget("../shared/glossary.html", source), join(fixtureDir, "docs", "shared", "glossary.html"));
});

test("resolveHrefTarget returns null for a missing target file", () => {
  const source = write("docs/a.html", "<html></html>");
  assert.equal(resolveHrefTarget("does-not-exist.html", source), null);
});

test("resolveHrefTarget returns null for a non-.html target", () => {
  const source = write("docs/a.html", "<html></html>");
  write("docs/image.png", "not really an image");
  assert.equal(resolveHrefTarget("image.png", source), null);
});

test("resolveHrefTarget returns null for out-of-scope hrefs", () => {
  const source = write("docs/a.html", "<html></html>");
  write("docs/b.html", "<html></html>");
  for (const href of ["https://example.com/b.html", "//example.com/b.html", "mailto:a@b.com", "#section", "/absolute/b.html"]) {
    assert.equal(resolveHrefTarget(href, source), null, `expected null for "${href}"`);
  }
});

test("resolveHrefTarget strips a trailing fragment before resolving", () => {
  const source = write("docs/a.html", "<html></html>");
  write("docs/b.html", "<html></html>");
  assert.equal(resolveHrefTarget("b.html#section-2", source), join(fixtureDir, "docs", "b.html"));
});

test("discoverLinkTargets finds every in-scope <a href> target within linkRoot", () => {
  const html = `<html><body>
    <a href="b.html">B</a>
    <a href="sub/c.html">C</a>
    <a href="https://example.com">external</a>
  </body></html>`;
  const source = write("docs/a.html", html);
  const bPath = write("docs/b.html", "<html></html>");
  const cPath = write("docs/sub/c.html", "<html></html>");
  const targets = discoverLinkTargets(Buffer.from(html), source, fixtureDir).sort();
  assert.deepEqual(targets, [bPath, cPath].sort());
});

test("discoverLinkTargets excludes a target that resolves outside linkRoot", () => {
  const source = write("root/docs/a.html", `<html><body><a href="../../outside/x.html">X</a></body></html>`);
  write("outside/x.html", "<html></html>");
  const linkRoot = join(fixtureDir, "root", "docs");
  const targets = discoverLinkTargets(Buffer.from(`<html><body><a href="../../outside/x.html">X</a></body></html>`), source, linkRoot);
  assert.deepEqual(targets, []);
});

test("discoverLinkTargets deduplicates the same target linked twice", () => {
  const source = write("docs/a.html", `<html><body><a href="b.html">1</a><a href="b.html">2</a></body></html>`);
  const bPath = write("docs/b.html", "<html></html>");
  const targets = discoverLinkTargets(
    Buffer.from(`<html><body><a href="b.html">1</a><a href="b.html">2</a></body></html>`),
    source,
    fixtureDir,
  );
  assert.deepEqual(targets, [bPath]);
});
