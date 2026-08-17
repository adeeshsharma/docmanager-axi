import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useIsolatedHome, cleanupHome } from "./helpers.js";
import { trackPath, trackPaths, untrackFamilies, defaultSyntheticPath } from "../src/core/track.js";
import { getFamily } from "../src/core/store.js";

let homeDir;
let fixtureDir;
beforeEach(() => {
  homeDir = useIsolatedHome();
  fixtureDir = mkdtempSync(join(tmpdir(), "docmanager-fixture-"));
});
afterEach(() => {
  cleanupHome(homeDir);
  rmSync(fixtureDir, { recursive: true, force: true });
});

function writeHtml(relPath, content = "<html><body>doc</body></html>") {
  const full = join(fixtureDir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  return full;
}

test("defaultSyntheticPath derives from basename, extension stripped", () => {
  assert.equal(defaultSyntheticPath("/x/y/report.html"), "/report");
});

test("trackPath creates a family; re-tracking the same real path is an idempotent no-op", async () => {
  const filePath = writeHtml("report.html");
  const first = await trackPath(filePath);
  assert.equal(first.alreadyTracked, false);

  const second = await trackPath(filePath);
  assert.equal(second.alreadyTracked, true);
  assert.equal(second.family.id, first.family.id);
});

test("trackPaths on a folder skips vendor/build directories, tracks only real documents", async () => {
  writeHtml("notes/doc.html", "<html>real</html>");
  writeHtml("node_modules/pkg/fixture.html", "<html>vendor</html>");
  writeHtml("dist/bundle.html", "<html>build output</html>");
  writeHtml(".git/hooks/sample.html", "<html>vcs internals</html>");

  const { results, summary } = await trackPaths([fixtureDir]);

  assert.equal(summary.trackedCount, 1);
  const tracked = results.find((r) => r.status === "tracked");
  assert.ok(tracked.path.endsWith(join("notes", "doc.html")), `expected a real filesystem path ending in notes/doc.html, got ${tracked.path}`);
});

test("trackPaths derives folder-relative synthetic paths, avoiding collisions on same-named files", async () => {
  writeHtml("reports/q3.html");
  writeHtml("notes/q3.html");

  const { results, summary } = await trackPaths([fixtureDir]);

  assert.equal(summary.trackedCount, 2);
  const paths = results.filter((r) => r.status === "tracked").map((r) => r.family.syntheticPath).sort();
  assert.deepEqual(paths, ["/notes/q3", "/reports/q3"]);
});

test("trackPaths never aborts the batch: one bad target reports its own error, others still succeed", async () => {
  const good = writeHtml("report.html");
  const missing = join(fixtureDir, "does-not-exist.html");

  const { results, summary } = await trackPaths([good, missing]);

  assert.equal(summary.trackedCount, 1);
  assert.equal(summary.errorCount, 1);
  const errored = results.find((r) => r.status === "error");
  assert.equal(errored.code, "FILE_NOT_FOUND");
});

test("trackPaths rejects --as when tracking more than one target", async () => {
  const a = writeHtml("a.html");
  const b = writeHtml("b.html");
  await assert.rejects(
    trackPaths([a, b], { as: "/custom" }),
    (err) => err.code === "AS_REQUIRES_SINGLE_FILE",
  );
});

test("trackPaths reports no-html-files-found for an empty folder", async () => {
  mkdirSync(join(fixtureDir, "empty"));
  const { results } = await trackPaths([join(fixtureDir, "empty")]);
  assert.equal(results[0].status, "no-html-files-found");
});

test("untrackFamilies removes a family and its local mapping; one failure never aborts the batch", async () => {
  const filePath = writeHtml("report.html");
  const { family } = await trackPath(filePath);

  const { results, summary } = await untrackFamilies([family.id, "nonexistent-id"]);

  assert.equal(summary.untrackedCount, 1);
  assert.equal(summary.errorCount, 1);
  assert.equal(getFamily(family.id), null);

  // The real path is now unmapped, so tracking it again creates a fresh family
  // rather than being treated as already-tracked.
  const retracked = await trackPath(filePath);
  assert.equal(retracked.alreadyTracked, false);
  assert.notEqual(retracked.family.id, family.id);
});

test("trackPath's FAMILY_PATH_EXISTS error carries the real colliding family's info, not just a bare message", async () => {
  const original = writeHtml("report.html", "<html><body>original</body></html>");
  const { family } = await trackPath(original);

  const duplicate = writeHtml("elsewhere/report.html", "<html><body>a different copy</body></html>");
  await assert.rejects(trackPath(duplicate), (err) => {
    assert.equal(err.code, "FAMILY_PATH_EXISTS");
    assert.ok(err.existingFamily, "the error should carry the colliding family's info");
    assert.equal(err.existingFamily.id, family.id);
    assert.equal(err.existingFamily.syntheticPath, "/report");
    assert.equal(err.existingFamily.versionCount, 1);
    assert.equal(err.existingFamily.headVersion, family.headVersion);
    assert.ok(err.existingFamily.headCreatedAt, "should include when the head version was created");
    return true;
  });
});

test("trackPaths surfaces existingFamily on each per-path collision result, not just the batch-level error", async () => {
  const original = writeHtml("report.html", "<html><body>original</body></html>");
  const { family } = await trackPath(original);
  const duplicate = writeHtml("elsewhere/report.html", "<html><body>a different copy</body></html>");

  const { results } = await trackPaths([duplicate]);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "error");
  assert.equal(results[0].code, "FAMILY_PATH_EXISTS");
  assert.equal(results[0].existingFamily.id, family.id);
  assert.equal(results[0].existingFamily.syntheticPath, "/report");
});
