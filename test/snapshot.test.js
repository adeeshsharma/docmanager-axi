import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../src/core/git.js";
import { updateSettings } from "../src/core/settings.js";
import { pushSnapshot, pullSnapshot } from "../src/core/snapshot.js";
import { storePath, getFamily } from "../src/core/store.js";
import { trackPath, renameTrackedDocument } from "../src/core/track.js";
import { recordVersionIfChanged } from "../src/core/store.js";
import { reconcile } from "../src/core/reconcile.js";

// A genuine two-"machine" simulation on one filesystem: two independent
// DOCMANAGER_HOME directories, talking to a real local bare git remote -
// the same technique used to manually verify phase 5, now automated.
let remoteDir, homeA, homeB, fixtureA, fixtureB;

function useHome(dir) {
  process.env.DOCMANAGER_HOME = dir;
}

beforeEach(async () => {
  remoteDir = mkdtempSync(join(tmpdir(), "docmanager-remote-"));
  homeA = mkdtempSync(join(tmpdir(), "docmanager-homeA-"));
  homeB = mkdtempSync(join(tmpdir(), "docmanager-homeB-"));
  fixtureA = mkdtempSync(join(tmpdir(), "docmanager-fixtureA-"));
  fixtureB = mkdtempSync(join(tmpdir(), "docmanager-fixtureB-"));
  await runGit(remoteDir, ["init", "--bare"]);
});

afterEach(() => {
  delete process.env.DOCMANAGER_HOME;
  for (const dir of [remoteDir, homeA, homeB, fixtureA, fixtureB]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("push, fresh clone on a second machine, relink, divergent push rejection, and a clean conflict abort", async () => {
  // --- Machine A: track, configure the remote, push ---
  useHome(homeA);
  updateSettings({ snapshotRemote: remoteDir });
  const filePathA = join(fixtureA, "report.html");
  writeFileSync(filePathA, "<html><body>original</body></html>");
  const { family: familyA } = await trackPath(filePathA);

  const pushResult = await pushSnapshot();
  assert.equal(pushResult.pushed, true);

  // --- Machine B: fresh, no local store yet - pull must clone, not assume ---
  useHome(homeB);
  updateSettings({ snapshotRemote: remoteDir });
  const pullResult = await pullSnapshot();
  assert.equal(pullResult.pulled, true);
  assert.equal(pullResult.mode, "clone");
  assert.ok(getFamily(familyA.id), "the pulled family must exist under the same id on B");

  // --- Relink B's own real file to the pulled family, in bulk-onboarding style ---
  const filePathB = join(fixtureB, "report.html"); // same basename -> same default synthetic path
  writeFileSync(filePathB, "<html><body>original</body></html>");
  const relinkResult = await trackPath(filePathB, { relink: true });
  assert.equal(relinkResult.relinked, true);
  assert.equal(relinkResult.family.id, familyA.id);

  // Naive re-track without --relink must fail actionable, not silently do the wrong thing.
  const filePathB2 = join(fixtureB, "report-again.html");
  writeFileSync(filePathB2, "<html><body>whatever</body></html>");
  await assert.rejects(
    trackPath(filePathB2, { as: "/report" }),
    (err) => err.code === "FAMILY_PATH_EXISTS",
  );

  // --- B edits and pushes first ---
  await recordVersionIfChanged(familyA.id, Buffer.from("<html><body>edited on B</body></html>"));
  const bPush = await pushSnapshot();
  assert.equal(bPush.pushed, true);

  // --- A, unaware of B's push, edits independently and tries to push: must be rejected ---
  useHome(homeA);
  await recordVersionIfChanged(familyA.id, Buffer.from("<html><body>edited on A, diverging</body></html>"));
  await assert.rejects(pushSnapshot(), (err) => err.code === "PUSH_REJECTED");

  // --- A pulls B's change: a genuine same-family conflict, aborted cleanly ---
  await assert.rejects(pullSnapshot(), (err) => err.code === "SYNC_CONFLICT");

  const statusAfterAbort = await runGit(storePath(), ["status", "--short"]);
  assert.equal(statusAfterAbort.trim(), "", "a merge abort must leave a clean working tree");

  // A only ever recorded ONE version locally beyond the original (its own
  // diverging edit) - B's second version lives only on the remote/on B until
  // a successful pull, which this conflict deliberately never reaches.
  const aFamilyAfter = getFamily(familyA.id);
  assert.equal(Object.keys(aFamilyAfter.versions).length, 2, "A's own edit must survive the aborted pull intact");
  assert.notEqual(aFamilyAfter.headVersion, familyA.headVersion, "A's own diverging edit must still be head");
});

test("a rename made on one machine and pulled on another is reflected in reconcile() output, not left showing the stale pre-rename path", async () => {
  // --- Machine A: track, push, rename, push again ---
  useHome(homeA);
  updateSettings({ snapshotRemote: remoteDir });
  const filePathA = join(fixtureA, "report.html");
  writeFileSync(filePathA, "<html><body>v1</body></html>");
  const { family: familyA } = await trackPath(filePathA);
  await pushSnapshot();

  await renameTrackedDocument(familyA.id, "/renamed-on-a");
  await pushSnapshot();

  // --- Machine B: pull, relink to a local copy of the same content ---
  useHome(homeB);
  updateSettings({ snapshotRemote: remoteDir });
  await pullSnapshot();
  const filePathB = join(fixtureB, "report.html");
  writeFileSync(filePathB, "<html><body>v1</body></html>");
  const relinkResult = await trackPath(filePathB, { as: "/renamed-on-a", relink: true });
  assert.equal(relinkResult.family.syntheticPath, "/renamed-on-a");

  let resultsB = await reconcile();
  assert.equal(resultsB[0].syntheticPath, "/renamed-on-a");

  // --- A renames AGAIN and pushes; B pulls but never re-tracks or re-relinks ---
  useHome(homeA);
  await renameTrackedDocument(familyA.id, "/renamed-on-a-second-time");
  await pushSnapshot();

  useHome(homeB);
  await pullSnapshot();

  // Before this fix, reconcile() read the path from local-state.json's own
  // denormalized copy - never touched by a pull, since local-state.json is
  // deliberately never synced - so this would still report the FIRST
  // rename's path, not the second one actually pulled in.
  resultsB = await reconcile();
  assert.equal(resultsB[0].syntheticPath, "/renamed-on-a-second-time");
  assert.equal(resultsB[0].status, "unchanged", "the live file content didn't change - only the path did");
});
