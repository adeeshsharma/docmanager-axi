import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useIsolatedHome, cleanupHome } from "./helpers.js";
import { createFamily, getFamily, recordVersionIfChanged, deleteVersion, readContent } from "../src/core/store.js";
import { trackPath } from "../src/core/track.js";
import { reconcile } from "../src/core/reconcile.js";

let homeDir;
beforeEach(() => {
  homeDir = useIsolatedHome();
});
afterEach(() => {
  cleanupHome(homeDir);
});

async function chainOfThree() {
  const family = await createFamily({ syntheticPath: "/report", content: Buffer.from("v1") });
  const v1 = family.headVersion;
  const { family: f2 } = await recordVersionIfChanged(family.id, Buffer.from("v2"));
  const v2 = f2.headVersion;
  const { family: f3 } = await recordVersionIfChanged(family.id, Buffer.from("v3"));
  const v3 = f3.headVersion;
  return { familyId: family.id, v1, v2, v3 };
}

test("deleting a middle version re-links its child to its own parent, healing the chain", async () => {
  const { familyId, v1, v2, v3 } = await chainOfThree();

  const updated = await deleteVersion(familyId, v2);

  assert.equal(Object.keys(updated.versions).length, 2);
  assert.equal(updated.versions[v2], undefined);
  assert.equal(updated.versions[v3].supersedes, v1, "v3 must now point directly at v1, not the deleted v2");
  assert.equal(updated.headVersion, v3, "head is untouched when deleting a non-head version");
});

test("deleting the root version makes its child the new root", async () => {
  const { familyId, v1, v2, v3 } = await chainOfThree();

  const updated = await deleteVersion(familyId, v1);

  assert.equal(updated.versions[v1], undefined);
  assert.equal(updated.versions[v2].supersedes, null, "v2 must become the new root");
  assert.equal(updated.versions[v3].supersedes, v2, "v3's own link to v2 is untouched");
});

test("deleting the head version moves headVersion back to its parent", async () => {
  const { familyId, v1, v2, v3 } = await chainOfThree();

  const updated = await deleteVersion(familyId, v3);

  assert.equal(updated.versions[v3], undefined);
  assert.equal(updated.headVersion, v2, "head must fall back to v3's own parent");
  assert.equal(Object.keys(updated.versions).length, 2);
});

test("deleting a version never touches its content blob", async () => {
  const { familyId, v2 } = await chainOfThree();
  await deleteVersion(familyId, v2);
  assert.deepEqual(readContent(v2), Buffer.from("v2"), "content stays readable even after its version record is gone");
});

test("refuses to delete a family's only remaining version", async () => {
  const family = await createFamily({ syntheticPath: "/report", content: Buffer.from("v1") });
  await assert.rejects(
    deleteVersion(family.id, family.headVersion),
    (err) => err.code === "CANNOT_DELETE_LAST_VERSION",
  );
  assert.ok(getFamily(family.id), "the family and its one version must still exist");
});

test("errors with VERSION_NOT_FOUND for an unknown hash", async () => {
  const family = await createFamily({ syntheticPath: "/report", content: Buffer.from("v1") });
  await recordVersionIfChanged(family.id, Buffer.from("v2"));
  await assert.rejects(
    deleteVersion(family.id, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
    (err) => err.code === "VERSION_NOT_FOUND",
  );
});

test("errors with FAMILY_NOT_FOUND for an unknown family", async () => {
  await assert.rejects(deleteVersion("nonexistent-id", "anyhash"), (err) => err.code === "FAMILY_NOT_FOUND");
});

test("after deleting the head, a live file still holding that exact content is re-captured on the next reconcile, not silently lost", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "docmanager-delver-fixture-"));
  try {
    const filePath = join(fixtureDir, "report.html");
    writeFileSync(filePath, "<html><body>v1</body></html>");
    const { family } = await trackPath(filePath);
    const v1 = family.headVersion;

    writeFileSync(filePath, "<html><body>v2</body></html>");
    await reconcile();
    const afterV2 = getFamily(family.id);
    const v2 = afterV2.headVersion;
    assert.notEqual(v2, v1);

    await deleteVersion(family.id, v2);
    const afterDelete = getFamily(family.id);
    assert.equal(afterDelete.headVersion, v1);

    // The real file on disk still holds v2's exact bytes - untouched by
    // deleteVersion, per the same disk-boundary revert already established.
    const results = await reconcile();
    const afterReconcile = getFamily(family.id);
    assert.equal(results[0].status, "new-version-captured");
    assert.equal(Object.keys(afterReconcile.versions).length, 2);
    assert.notEqual(afterReconcile.headVersion, v1, "the live file's content was correctly re-captured, not lost");
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
