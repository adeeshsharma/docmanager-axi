import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../src/core/git.js";
import { updateSettings } from "../src/core/settings.js";
import { pushSnapshot, pullSnapshot } from "../src/core/snapshot.js";
import { syncSnapshot, unionFamilyVersions } from "../src/core/sync.js";
import { storePath, getFamily, deleteFamily, recordVersionIfChanged } from "../src/core/store.js";
import { trackPath } from "../src/core/track.js";

// Same two-"machine" simulation technique as snapshot.test.js: two
// independent DOCMANAGER_HOME directories talking to a real local bare git
// remote, on one filesystem.
let remoteDir, homeA, homeB, fixtureA, fixtureB;

function useHome(dir) {
  process.env.DOCMANAGER_HOME = dir;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(async () => {
  remoteDir = mkdtempSync(join(tmpdir(), "docmanager-sync-remote-"));
  homeA = mkdtempSync(join(tmpdir(), "docmanager-sync-homeA-"));
  homeB = mkdtempSync(join(tmpdir(), "docmanager-sync-homeB-"));
  fixtureA = mkdtempSync(join(tmpdir(), "docmanager-sync-fixtureA-"));
  fixtureB = mkdtempSync(join(tmpdir(), "docmanager-sync-fixtureB-"));
  await runGit(remoteDir, ["init", "--bare"]);
});

afterEach(() => {
  delete process.env.DOCMANAGER_HOME;
  for (const dir of [remoteDir, homeA, homeB, fixtureA, fixtureB]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unionFamilyVersions merges two version maps without rewriting either side's own supersedes pointer", () => {
  const ours = {
    id: "f1",
    syntheticPath: "/report",
    title: "/report",
    tags: ["a"],
    versions: {
      root: { createdAt: "2026-01-01T00:00:00.000Z", supersedes: null },
      oursOnly: { createdAt: "2026-01-01T00:00:02.000Z", supersedes: "root" },
    },
  };
  const theirs = {
    id: "f1",
    syntheticPath: "/report",
    title: "/report",
    tags: ["b"],
    versions: {
      root: { createdAt: "2026-01-01T00:00:00.000Z", supersedes: null },
      theirsOnly: { createdAt: "2026-01-01T00:00:01.000Z", supersedes: "root" },
    },
  };

  const merged = unionFamilyVersions(ours, theirs);
  assert.equal(Object.keys(merged.versions).length, 3);
  assert.equal(merged.versions.oursOnly.supersedes, "root", "ours' own branch must not be rewritten");
  assert.equal(merged.versions.theirsOnly.supersedes, "root", "theirs' own branch must not be rewritten either");
  assert.equal(merged.headVersion, "oursOnly", "the newest createdAt across the union must become head");
  assert.deepEqual([...merged.tags].sort(), ["a", "b"]);
});

test("Case A: same family edited independently on both machines - sync unions cleanly, preserving each version's own supersedes", async () => {
  useHome(homeA);
  updateSettings({ snapshotRemote: remoteDir });
  const filePathA = join(fixtureA, "report.html");
  writeFileSync(filePathA, "<html><body>original</body></html>");
  const { family: familyA } = await trackPath(filePathA);
  const originalHead = familyA.headVersion;
  await pushSnapshot({ acknowledgePrivacy: true });

  useHome(homeB);
  updateSettings({ snapshotRemote: remoteDir });
  await pullSnapshot();
  const { family: bEdited } = await recordVersionIfChanged(
    familyA.id,
    Buffer.from("<html><body>edited on B</body></html>"),
  );
  const bHash = bEdited.headVersion;

  useHome(homeA);
  const { family: aEdited } = await recordVersionIfChanged(
    familyA.id,
    Buffer.from("<html><body>edited on A</body></html>"),
  );
  const aHash = aEdited.headVersion;
  await pushSnapshot();

  useHome(homeB);
  const result = await syncSnapshot();
  assert.equal(result.synced, true);
  assert.equal(result.semanticMerges.length, 1);

  const merged = getFamily(familyA.id);
  assert.equal(Object.keys(merged.versions).length, 3);
  assert.equal(merged.headVersion, aHash, "A's edit landed later in wall-clock time - it must win as head");
  assert.equal(merged.versions[bHash].supersedes, originalHead, "B's own version must keep pointing at its real parent");
  assert.equal(
    merged.versions[aHash].supersedes,
    originalHead,
    "A's own version must keep pointing at its real parent, not get flattened through B's version",
  );
});

test("Case B: two machines independently track the same path before ever syncing - sync auto-links when unambiguous", async () => {
  useHome(homeA);
  updateSettings({ snapshotRemote: remoteDir });
  const filePathA = join(fixtureA, "report.html");
  writeFileSync(filePathA, "<html><body>from A</body></html>");
  const { family: familyA } = await trackPath(filePathA);
  await pushSnapshot({ acknowledgePrivacy: true });

  // Clear the ambiguous-timestamp threshold so ordering is unambiguous -
  // a real two-machine scenario is essentially always this far apart.
  await sleep(1100);

  useHome(homeB);
  updateSettings({ snapshotRemote: remoteDir });
  const filePathB = join(fixtureB, "report.html"); // same basename -> same default synthetic path
  writeFileSync(filePathB, "<html><body>from B</body></html>");
  const { family: familyB } = await trackPath(filePathB); // independent track - no pull/relink yet

  const result = await syncSnapshot();
  assert.equal(result.synced, true);
  assert.equal(result.autoLinks.length, 1);
  assert.equal(result.autoLinks[0].olderId, familyA.id);
  assert.equal(result.autoLinks[0].newerId, familyB.id);

  assert.equal(getFamily(familyA.id), null, "the older family record must be gone after auto-linking");
  const merged = getFamily(familyB.id);
  assert.equal(merged.syntheticPath, "/report");
  assert.equal(Object.keys(merged.versions).length, 2, "both histories must be present in the surviving family");
});

test("Case B: an ambiguous timestamp order is reported, never auto-linked", async () => {
  useHome(homeA);
  updateSettings({ snapshotRemote: remoteDir });
  const filePathA = join(fixtureA, "report.html");
  writeFileSync(filePathA, "<html><body>from A</body></html>");
  const { family: familyA } = await trackPath(filePathA);
  await pushSnapshot({ acknowledgePrivacy: true });

  // Deliberately NO delay here - real, unmocked filesystem/git operations
  // are fast enough that this stays well under the ambiguity threshold.
  useHome(homeB);
  updateSettings({ snapshotRemote: remoteDir });
  const filePathB = join(fixtureB, "report.html");
  writeFileSync(filePathB, "<html><body>from B</body></html>");
  const { family: familyB } = await trackPath(filePathB);

  const result = await syncSnapshot();
  assert.equal(result.autoLinks.length, 0);
  assert.equal(result.unresolved.length, 1);
  assert.match(result.unresolved[0].reason, /ambiguous/);
  assert.ok(getFamily(familyA.id), "an ambiguous collision must link nothing");
  assert.ok(getFamily(familyB.id));
});

test("--no-auto-link reports a Case B collision without linking it", async () => {
  useHome(homeA);
  updateSettings({ snapshotRemote: remoteDir });
  const filePathA = join(fixtureA, "report.html");
  writeFileSync(filePathA, "<html><body>from A</body></html>");
  const { family: familyA } = await trackPath(filePathA);
  await pushSnapshot({ acknowledgePrivacy: true });

  await sleep(1100);

  useHome(homeB);
  updateSettings({ snapshotRemote: remoteDir });
  const filePathB = join(fixtureB, "report.html");
  writeFileSync(filePathB, "<html><body>from B</body></html>");
  const { family: familyB } = await trackPath(filePathB);

  const result = await syncSnapshot({ autoLink: false });
  assert.equal(result.autoLinks.length, 0);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].reason, "not auto-linked (--no-auto-link)");
  assert.equal(result.unresolved[0].command, `docmanager link ${familyA.id} ${familyB.id}`);
  assert.ok(getFamily(familyA.id));
  assert.ok(getFamily(familyB.id));
});

test("outside the two defined shapes (delete on one side, edit on the other) falls back to SYNC_CONFLICT, store fully untouched", async () => {
  useHome(homeA);
  updateSettings({ snapshotRemote: remoteDir });
  const filePathA = join(fixtureA, "report.html");
  writeFileSync(filePathA, "<html><body>v1</body></html>");
  const { family: familyA } = await trackPath(filePathA);
  await pushSnapshot({ acknowledgePrivacy: true });

  // --- Machine B: pull, then untrack and freshly re-track the same path -
  // exactly this session's own real scenario (a deliberate cleanup, not a
  // hypothetical) ---
  useHome(homeB);
  updateSettings({ snapshotRemote: remoteDir });
  await pullSnapshot();
  await deleteFamily(familyA.id);
  const filePathB = join(fixtureB, "report.html");
  writeFileSync(filePathB, "<html><body>v1 again</body></html>");
  await trackPath(filePathB);
  await pushSnapshot({ acknowledgePrivacy: true });

  // --- Machine A: unaware of B's cleanup, edits the (now remotely-deleted) family ---
  useHome(homeA);
  await recordVersionIfChanged(familyA.id, Buffer.from("<html><body>edited on A</body></html>"));

  const preHead = (await runGit(storePath(), ["rev-parse", "HEAD"])).trim();
  await assert.rejects(syncSnapshot(), (err) => err.code === "SYNC_CONFLICT");
  const postHead = (await runGit(storePath(), ["rev-parse", "HEAD"])).trim();
  assert.equal(postHead, preHead, "a failed sync must never move HEAD");

  const status = await runGit(storePath(), ["status", "--porcelain=v1"]);
  assert.equal(status.trim(), "", "a failed sync must leave a clean working tree");
  assert.ok(getFamily(familyA.id), "A's local family record must still exist, untouched");
});

test("--dry-run reports a Case A merge without changing anything", async () => {
  useHome(homeA);
  updateSettings({ snapshotRemote: remoteDir });
  const filePathA = join(fixtureA, "report.html");
  writeFileSync(filePathA, "<html><body>original</body></html>");
  const { family: familyA } = await trackPath(filePathA);
  await pushSnapshot({ acknowledgePrivacy: true });

  useHome(homeB);
  updateSettings({ snapshotRemote: remoteDir });
  await pullSnapshot();
  await recordVersionIfChanged(familyA.id, Buffer.from("<html><body>edited on B</body></html>"));

  useHome(homeA);
  await recordVersionIfChanged(familyA.id, Buffer.from("<html><body>edited on A</body></html>"));
  await pushSnapshot();

  useHome(homeB);
  const preHead = (await runGit(storePath(), ["rev-parse", "HEAD"])).trim();
  const result = await syncSnapshot({ dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.semanticMerges.length, 1);

  const postHead = (await runGit(storePath(), ["rev-parse", "HEAD"])).trim();
  assert.equal(postHead, preHead, "a dry run must never move HEAD");
  const status = await runGit(storePath(), ["status", "--porcelain=v1"]);
  assert.equal(status.trim(), "", "a dry run must leave a clean working tree");

  const family = getFamily(familyA.id);
  assert.equal(Object.keys(family.versions).length, 2, "a dry run must not actually merge anything locally");
});

test("--dry-run reports a Case B collision as 'would auto-link' without linking", async () => {
  useHome(homeA);
  updateSettings({ snapshotRemote: remoteDir });
  const filePathA = join(fixtureA, "report.html");
  writeFileSync(filePathA, "<html><body>from A</body></html>");
  const { family: familyA } = await trackPath(filePathA);
  await pushSnapshot({ acknowledgePrivacy: true });

  await sleep(1100);

  useHome(homeB);
  updateSettings({ snapshotRemote: remoteDir });
  const filePathB = join(fixtureB, "report.html");
  writeFileSync(filePathB, "<html><body>from B</body></html>");
  const { family: familyB } = await trackPath(filePathB);

  const preHead = (await runGit(storePath(), ["rev-parse", "HEAD"])).trim();
  const result = await syncSnapshot({ dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.autoLinks.length, 0);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].olderId, familyA.id);
  assert.equal(result.unresolved[0].newerId, familyB.id);
  assert.match(result.unresolved[0].reason, /dry run/);

  // A dry run must fully undo the merge it used to detect this, not just
  // skip the link - B's own store never really had familyA in it at all.
  const postHead = (await runGit(storePath(), ["rev-parse", "HEAD"])).trim();
  assert.equal(postHead, preHead, "a dry run must never move HEAD");
  assert.equal(getFamily(familyA.id), null, "the dry-run merge itself must be fully reverted");
  const stillLocalOnly = getFamily(familyB.id);
  assert.equal(Object.keys(stillLocalOnly.versions).length, 1, "nothing must actually be merged in a dry run");
});

test("sync clones fresh on a machine with no local store yet, same as pullSnapshot", async () => {
  useHome(homeA);
  updateSettings({ snapshotRemote: remoteDir });
  const filePathA = join(fixtureA, "report.html");
  writeFileSync(filePathA, "<html><body>v1</body></html>");
  const { family: familyA } = await trackPath(filePathA);
  await pushSnapshot({ acknowledgePrivacy: true });

  useHome(homeB);
  updateSettings({ snapshotRemote: remoteDir });
  const result = await syncSnapshot();
  assert.equal(result.mode, "clone");
  assert.ok(getFamily(familyA.id));
});

test("sync --dry-run on a fresh machine reports would-clone without actually cloning", async () => {
  useHome(homeA);
  updateSettings({ snapshotRemote: remoteDir });
  const filePathA = join(fixtureA, "report.html");
  writeFileSync(filePathA, "<html><body>v1</body></html>");
  await trackPath(filePathA);
  await pushSnapshot({ acknowledgePrivacy: true });

  useHome(homeB);
  updateSettings({ snapshotRemote: remoteDir });
  const result = await syncSnapshot({ dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.mode, "would-clone");
  assert.equal(existsSync(storePath()), false, "a dry run must never actually create the store");
});
