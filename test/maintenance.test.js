import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useIsolatedHome, cleanupHome } from "./helpers.js";
import { runGc } from "../src/core/maintenance.js";
import { trackPath, renameTrackedDocument } from "../src/core/track.js";
import { recordVersionIfChanged, getFamily, readContent } from "../src/core/store.js";

let homeDir;
beforeEach(() => {
  homeDir = useIsolatedHome();
});
afterEach(() => {
  cleanupHome(homeDir);
});

test("runGc refuses with NOTHING_TO_CLEAN when nothing has ever been tracked", async () => {
  await assert.rejects(runGc(), (err) => err.code === "NOTHING_TO_CLEAN");
});

test("runGc runs successfully against a real store, reporting before/after size, and never loses any document data", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "docmanager-gc-fixture-"));
  try {
    const filePath = join(fixtureDir, "doc.html");
    writeFileSync(filePath, "<html><body>v1</body></html>");
    const { family } = await trackPath(filePath);

    // Accumulate a bit of real history so gc has something to actually do.
    for (let i = 0; i < 5; i++) {
      await recordVersionIfChanged(family.id, Buffer.from(`<html><body>v${i + 2}</body></html>`));
    }
    await renameTrackedDocument(family.id, "/renamed-doc");

    const result = await runGc();
    assert.equal(result.ranGc, true);
    assert.equal(typeof result.sizeBeforeBytes, "number");
    assert.equal(typeof result.sizeAfterBytes, "number");
    assert.ok(result.sizeAfterBytes >= 0);

    // The whole point: gc must never touch the actual document history it's
    // compacting - every version's content must still resolve after gc runs.
    const familyAfter = getFamily(family.id);
    assert.equal(familyAfter.syntheticPath, "/renamed-doc");
    assert.equal(Object.keys(familyAfter.versions).length, 6);
    for (const hash of Object.keys(familyAfter.versions)) {
      assert.ok(readContent(hash), `content for ${hash} must survive gc`);
    }
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("runGc is safe to run twice in a row - a repeat gc is a no-op, not an error", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "docmanager-gc-fixture2-"));
  try {
    const filePath = join(fixtureDir, "doc.html");
    writeFileSync(filePath, "<html><body>v1</body></html>");
    await trackPath(filePath);

    const first = await runGc();
    assert.equal(first.ranGc, true);
    const second = await runGc();
    assert.equal(second.ranGc, true);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
