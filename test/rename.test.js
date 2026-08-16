import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useIsolatedHome, cleanupHome } from "./helpers.js";
import { createFamily, renameFamily, getFamily } from "../src/core/store.js";
import { trackPath, renameTrackedDocument } from "../src/core/track.js";
import { listMappings } from "../src/core/local-state.js";
import { reconcile } from "../src/core/reconcile.js";

let homeDir;
beforeEach(() => {
  homeDir = useIsolatedHome();
});
afterEach(() => {
  cleanupHome(homeDir);
});

test("renameFamily changes the synthetic path, keeps id and version history intact", async () => {
  const family = await createFamily({ syntheticPath: "/report", content: Buffer.from("v1") });
  const { changed, family: renamed } = await renameFamily(family.id, "/quarterly-report");
  assert.equal(changed, true);
  assert.equal(renamed.id, family.id);
  assert.equal(renamed.syntheticPath, "/quarterly-report");
  assert.deepEqual(renamed.versions, family.versions);
  assert.equal(getFamily(family.id).syntheticPath, "/quarterly-report");
});

test("renameFamily to the same path is an idempotent no-op", async () => {
  const family = await createFamily({ syntheticPath: "/report", content: Buffer.from("v1") });
  const { changed } = await renameFamily(family.id, "/report");
  assert.equal(changed, false);
});

test("renameFamily rejects a collision with another family's existing synthetic path", async () => {
  const a = await createFamily({ syntheticPath: "/a", content: Buffer.from("a") });
  await createFamily({ syntheticPath: "/b", content: Buffer.from("b") });
  await assert.rejects(renameFamily(a.id, "/b"), (err) => err.code === "FAMILY_PATH_EXISTS");
});

test("renameFamily errors on an unknown family id", async () => {
  await assert.rejects(renameFamily("does-not-exist", "/x"), (err) => err.code === "FAMILY_NOT_FOUND");
});

test("renameTrackedDocument keeps the local-state mapping's syntheticPath in sync", async () => {
  const dir = mkdtempSync(join(tmpdir(), "docmanager-rename-"));
  const filePath = join(dir, "report.html");
  writeFileSync(filePath, "<html><body>v1</body></html>");

  try {
    const { family } = await trackPath(filePath);
    assert.equal(listMappings()[0].syntheticPath, "/report");

    await renameTrackedDocument(family.id, "/quarterly-report");

    const mappings = listMappings();
    assert.equal(mappings.length, 1);
    assert.equal(mappings[0].syntheticPath, "/quarterly-report");
    assert.equal(mappings[0].familyId, family.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("after a rename, reconcile() reports the NEW synthetic path, not a stale one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "docmanager-rename-"));
  const filePath = join(dir, "report.html");
  writeFileSync(filePath, "<html><body>v1</body></html>");

  try {
    const { family } = await trackPath(filePath);
    await renameTrackedDocument(family.id, "/quarterly-report");

    const results = await reconcile();
    assert.equal(results.length, 1);
    assert.equal(results[0].syntheticPath, "/quarterly-report");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
