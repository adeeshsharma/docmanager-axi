import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useIsolatedHome, cleanupHome } from "./helpers.js";
import { trackPath, trackPaths, untrackFamilies, defaultSyntheticPath } from "../src/core/track.js";
import { getFamily, deleteVersion } from "../src/core/store.js";
import { reconcile } from "../src/core/reconcile.js";
import { listMappings } from "../src/core/local-state.js";
import { editDir } from "../src/core/paths.js";
import { editFileName } from "../src/cli/lavish.js";
import { existsSync } from "node:fs";

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

test("relinking a new Lavish scratch copy retires the previous one, so a superseded version isn't blocked from deletion forever", async () => {
  const filePath = writeHtml("report.html", "<html><body>v1</body></html>");
  const { family } = await trackPath(filePath, { as: "/report" });
  const v1 = family.headVersion;

  // Session 1: export v1 to a scratch working file, edit it, relink+reconcile
  // - the exact sequence `docmanager families lavish` + `track --relink` +
  // `status` produces per ARCHITECTURE.md section 5.
  mkdirSync(editDir(), { recursive: true });
  const editFile1 = join(editDir(), editFileName("/report", v1));
  writeFileSync(editFile1, "<html><body>v2 from session 1</body></html>");
  await trackPath(editFile1, { as: "/report", relink: true });
  await reconcile();
  const v2 = getFamily(family.id).headVersion;
  assert.notEqual(v2, v1);

  // Session 2: a later Lavish session exports v2, edits it, relinks again.
  const editFile2 = join(editDir(), editFileName("/report", v2));
  writeFileSync(editFile2, "<html><body>v3 from session 2</body></html>");
  await trackPath(editFile2, { as: "/report", relink: true });
  await reconcile();
  const v3 = getFamily(family.id).headVersion;
  assert.notEqual(v3, v2);

  // Session 1's scratch file is retired: unmapped and removed from disk,
  // since it will never be touched again - only the original tracked file
  // and session 2's scratch copy remain live mappings for this family.
  const mappings = listMappings().filter((m) => m.familyId === family.id);
  assert.equal(mappings.length, 2, "original file + latest scratch copy only");
  assert.ok(!mappings.some((m) => m.realPath === editFile1), "session 1's mapping must be gone");
  assert.ok(!existsSync(editFile1), "session 1's scratch file must be deleted from disk");

  // v2 is fully superseded by v3 and no live mapping holds its content
  // anymore, so it must now be deletable - this was the actual bug: the
  // abandoned session-1 mapping used to make deleteVersion think v2's
  // content (which happened to equal what it exported) was still live.
  const updated = await deleteVersion(family.id, v2);
  assert.equal(updated.versions[v2], undefined);
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
