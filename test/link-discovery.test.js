import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHrefTarget, discoverLinkTargets, discoverAndTrackLinkedDocuments } from "../src/core/link-discovery.js";
import { useIsolatedHome, cleanupHome } from "./helpers.js";
import { trackPath } from "../src/core/track.js";
import { findByRealPath } from "../src/core/local-state.js";

let fixtureDir;
// Add alongside the existing beforeEach/afterEach - this module now also
// needs an isolated docmanager home, since discoverAndTrackLinkedDocuments
// calls trackPath() internally.
let homeDir;
beforeEach(() => {
  homeDir = useIsolatedHome();
  fixtureDir = realpathSync(mkdtempSync(join(tmpdir(), "docmanager-linkdisc-")));
});
afterEach(() => {
  cleanupHome(homeDir);
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

test("discoverAndTrackLinkedDocuments tracks a single linked document", async () => {
  const a = write("a.html", `<html><body><a href="b.html">B</a></body></html>`);
  write("b.html", "<html><body>b</body></html>");

  const { results } = await discoverAndTrackLinkedDocuments(a, fixtureDir);

  assert.equal(results.length, 1);
  assert.equal(results[0].status, "tracked");
  assert.equal(findByRealPath(join(fixtureDir, "b.html")).familyId, results[0].family.id);
});

test("discoverAndTrackLinkedDocuments follows links transitively across the whole reachable cluster", async () => {
  const a = write("a.html", `<html><body><a href="b.html">B</a></body></html>`);
  write("b.html", `<html><body><a href="c.html">C</a></body></html>`);
  write("c.html", "<html><body>c, no further links</body></html>");

  const { results } = await discoverAndTrackLinkedDocuments(a, fixtureDir);

  const trackedPaths = results.filter((r) => r.status === "tracked").map((r) => r.family.syntheticPath).sort();
  assert.deepEqual(trackedPaths, ["/b", "/c"]);
});

test("discoverAndTrackLinkedDocuments terminates on a cycle (A links to B links back to A)", async () => {
  const a = write("a.html", `<html><body><a href="b.html">B</a></body></html>`);
  write("b.html", `<html><body><a href="a.html">back to A</a></body></html>`);

  const { results } = await discoverAndTrackLinkedDocuments(a, fixtureDir);

  // Only B gets tracked here - A is the crawl's own starting point, tracked
  // separately by whatever called this (trackPaths()'s own integration),
  // not by the crawl itself re-tracking its own start.
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "tracked");
});

test("discoverAndTrackLinkedDocuments never leaves linkRoot", async () => {
  mkdirSync(join(fixtureDir, "root"), { recursive: true });
  const a = write("root/a.html", `<html><body><a href="../outside.html">X</a></body></html>`);
  write("outside.html", "<html></html>");

  const { results } = await discoverAndTrackLinkedDocuments(a, join(fixtureDir, "root"));

  assert.equal(results.length, 0);
});

test("discoverAndTrackLinkedDocuments reports an already-tracked target without re-creating its family", async () => {
  const a = write("a.html", `<html><body><a href="b.html">B</a></body></html>`);
  const b = write("b.html", "<html></html>");
  const { family: preTracked } = await trackPath(b, { linkRoot: fixtureDir });

  const { results } = await discoverAndTrackLinkedDocuments(a, fixtureDir);

  assert.equal(results[0].status, "already-tracked");
  assert.equal(results[0].family.id, preTracked.id);
});
