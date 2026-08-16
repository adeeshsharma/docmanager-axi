import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useIsolatedHome, cleanupHome } from "./helpers.js";
import { createFamily, getFamily, recordVersionIfChanged, revertToVersion, readContent } from "../src/core/store.js";
import { trackPath } from "../src/core/track.js";
import { reconcile } from "../src/core/reconcile.js";

let homeDir;
beforeEach(() => {
  homeDir = useIsolatedHome();
});
afterEach(() => {
  cleanupHome(homeDir);
});

test("revert moves headVersion to an existing hash without adding or removing any version entry", async () => {
  const family = await createFamily({ syntheticPath: "/report", content: Buffer.from("v1") });
  const originalHead = family.headVersion;
  const { family: advanced } = await recordVersionIfChanged(family.id, Buffer.from("v2"));
  assert.notEqual(advanced.headVersion, originalHead);

  const { changed, family: reverted } = await revertToVersion(family.id, originalHead);

  assert.equal(changed, true);
  assert.equal(reverted.headVersion, originalHead);
  assert.equal(Object.keys(reverted.versions).length, 2, "no version added or removed by revert");
  assert.deepEqual(reverted.versions, advanced.versions, "the version records themselves are untouched, only headVersion moved");
});

test("revert never touches any content blob", async () => {
  const family = await createFamily({ syntheticPath: "/report", content: Buffer.from("v1") });
  const originalHead = family.headVersion;
  const { family: advanced } = await recordVersionIfChanged(family.id, Buffer.from("v2"));

  await revertToVersion(family.id, originalHead);

  assert.deepEqual(readContent(originalHead), Buffer.from("v1"));
  assert.deepEqual(readContent(advanced.headVersion), Buffer.from("v2"));
});

test("reverting to the current head is an idempotent no-op", async () => {
  const family = await createFamily({ syntheticPath: "/report", content: Buffer.from("v1") });
  const { changed, family: after } = await revertToVersion(family.id, family.headVersion);
  assert.equal(changed, false);
  assert.equal(after.headVersion, family.headVersion);
});

test("reverting to an unknown hash errors with VERSION_NOT_FOUND", async () => {
  const family = await createFamily({ syntheticPath: "/report", content: Buffer.from("v1") });
  await assert.rejects(
    revertToVersion(family.id, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
    (err) => err.code === "VERSION_NOT_FOUND",
  );
});

test("reverting an unknown family errors with FAMILY_NOT_FOUND", async () => {
  await assert.rejects(revertToVersion("nonexistent-id", "anyhash"), (err) => err.code === "FAMILY_NOT_FOUND");
});

test("after a revert, a live file that still holds the newer content reconciles as behind-head, not a spurious new version - the real file is never touched by revert itself", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "docmanager-revert-fixture-"));
  try {
    const filePath = join(fixtureDir, "report.html");
    writeFileSync(filePath, "<html><body>v1</body></html>");
    const { family } = await trackPath(filePath);
    const originalHead = family.headVersion;

    writeFileSync(filePath, "<html><body>v2</body></html>");
    await reconcile(); // captures v2 as the new head, matching normal use
    const advanced = getFamily(family.id);
    assert.notEqual(advanced.headVersion, originalHead);

    await revertToVersion(family.id, originalHead);

    // The real file on disk was never touched by revert - checksum-equivalent
    // check via exact byte comparison against what reconcile() last wrote it as.
    const { readFileSync } = await import("node:fs");
    assert.deepEqual(readFileSync(filePath), Buffer.from("<html><body>v2</body></html>"));

    const results = await reconcile();
    assert.equal(results[0].status, "behind-head");
    const finalFamily = getFamily(family.id);
    assert.equal(finalFamily.headVersion, originalHead, "reconcile must not silently undo the revert");
    assert.equal(Object.keys(finalFamily.versions).length, 2, "no spurious new version written");
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
