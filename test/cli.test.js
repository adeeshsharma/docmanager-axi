import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "..", "bin", "docmanager.js");

let homeDir, fixtureDir, env, port;

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

before(() => {
  homeDir = mkdtempSync(join(tmpdir(), "docmanager-cli-home-"));
  fixtureDir = mkdtempSync(join(tmpdir(), "docmanager-cli-fixture-"));
  // A port far from the real default (4389) and derived from this process's
  // own pid, so a real dev-machine core running concurrently is never
  // touched and parallel CI runs are unlikely to collide either.
  port = 40000 + (process.pid % 10000);
  env = { ...process.env, DOCMANAGER_HOME: homeDir, DOCMANAGER_PORT: String(port) };
});

after(async () => {
  // The core is a detached background process - an explicit stop is the
  // only thing that reliably cleans it up after this test file exits.
  await runCli(["core", "stop"]);
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
});

test("--version resolves via the fast path without starting the core", async () => {
  const { code, stdout } = await runCli(["--version"]);
  assert.equal(code, 0);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("core status reports not running before anything has started it", async () => {
  const { code, stdout } = await runCli(["core", "status"]);
  assert.equal(code, 0);
  assert.match(stdout, /not running/);
});

test("track / families / settings / untrack all work end to end through the real binary", async () => {
  const filePath = join(fixtureDir, "report.html");
  writeFileSync(filePath, "<html><body>v1</body></html>");

  const tracked = await runCli(["track", filePath]);
  assert.equal(tracked.code, 0, tracked.stderr);
  assert.match(tracked.stdout, /tracked: \/report/);
  const idMatch = tracked.stdout.match(/id: (\S+)/);
  assert.ok(idMatch, "track output should include the new family id");
  const familyId = idMatch[1];

  const families = await runCli(["families"]);
  assert.equal(families.code, 0);
  assert.match(families.stdout, /count: 1 tracked/);

  const settingsSet = await runCli(["settings", "set", "--snapshot-remote", "https://example.invalid/repo.git"]);
  assert.equal(settingsSet.code, 0);

  const settingsGet = await runCli(["settings", "get"]);
  assert.equal(settingsGet.code, 0);
  assert.match(settingsGet.stdout, /example\.invalid/);

  const untracked = await runCli(["untrack", familyId]);
  assert.equal(untracked.code, 0, untracked.stderr);
  assert.match(untracked.stdout, /1 untracked, 0 failed/);

  const familiesAfter = await runCli(["families"]);
  assert.match(familiesAfter.stdout, /0 tracked documents found/);
});

test("an unknown flag fails loud with exit code 2, not silently ignored", async () => {
  const { code, stdout } = await runCli(["track", "--bogus", fixtureDir]);
  assert.equal(code, 2);
  assert.match(stdout, /unknown flag/);
});

test("doctor reports a healthy store end to end through the real binary", async () => {
  const { code, stdout } = await runCli(["doctor"]);
  assert.equal(code, 0);
  assert.match(stdout, /status: ok/);
  assert.match(stdout, /git,ok/);
  assert.match(stdout, /store,ok/);
});

test("families surfaces a possible-duplicate suggestion for two similar documents through the real binary", async () => {
  const a = join(fixtureDir, "dup-a.html");
  const b = join(fixtureDir, "dup-b.html");
  writeFileSync(a, "<html><head><title>Shared Title</title></head><body><table><tr><td>1</td></tr></table></body></html>");
  writeFileSync(b, "<html><head><title>Shared Title (final)</title></head><body><table><tr><td>2</td></tr></table></body></html>");

  await runCli(["track", a, b]);
  const { stdout } = await runCli(["families"]);
  assert.match(stdout, /possibleDuplicates/);
  assert.match(stdout, /title-match/);
});

test("families diff and families revert work end to end through the real binary", async () => {
  const filePath = join(fixtureDir, "revert-me.html");
  writeFileSync(filePath, "<html><body>v1</body></html>");
  const tracked = await runCli(["track", filePath]);
  const id = tracked.stdout.match(/id: (\S+)/)[1];

  writeFileSync(filePath, "<html><body>v2, a real change</body></html>");
  await runCli(["status"]); // reconciles, captures v2 as head

  const view = await runCli(["families", "view", id]);
  const hashes = [...view.stdout.matchAll(/^\s*([0-9a-f]{64}),/gm)].map((m) => m[1]);
  assert.equal(hashes.length, 2);
  const [oldHash, newHash] = hashes;

  const diff = await runCli(["families", "diff", id, oldHash, newHash]);
  assert.equal(diff.code, 0, diff.stderr);
  assert.match(diff.stdout, /v1/);
  assert.match(diff.stdout, /v2, a real change/);

  const revert = await runCli(["families", "revert", id, oldHash]);
  assert.equal(revert.code, 0, revert.stderr);
  assert.match(revert.stdout, /reverted: true/);

  const revertAgain = await runCli(["families", "revert", id, oldHash]);
  assert.match(revertAgain.stdout, /reverted: false/);

  const badRevert = await runCli(["families", "revert", id, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"]);
  assert.equal(badRevert.code, 1);
  assert.match(badRevert.stdout, /VERSION_NOT_FOUND/);
});

test("search finds a tracked document by content, and reports zero results honestly for no match", async () => {
  const filePath = join(fixtureDir, "searchable.html");
  writeFileSync(filePath, "<html><head><title>Findable Doc</title></head><body><p>a very particular sentence about zephyrs</p></body></html>");
  await runCli(["track", filePath]);

  const found = await runCli(["search", "zephyrs"]);
  assert.equal(found.code, 0, found.stderr);
  assert.match(found.stdout, /count: 1 match/);
  assert.match(found.stdout, /searchable/);

  const notFound = await runCli(["search", "nosuchtermanywhere"]);
  assert.equal(notFound.code, 0);
  assert.match(notFound.stdout, /0 documents found/);
});

test("search with no query fails loud with a usage error", async () => {
  const { code, stdout } = await runCli(["search"]);
  assert.equal(code, 2);
  assert.match(stdout, /query is required/);
});

test("families export writes a version's raw content to a file, and fails loud on a bad hash or an unwritable destination", async () => {
  const filePath = join(fixtureDir, "exportable.html");
  writeFileSync(filePath, "<html><body>export me</body></html>");
  const tracked = await runCli(["track", filePath]);
  const id = tracked.stdout.match(/id: (\S+)/)[1];
  const view = await runCli(["families", "view", id]);
  const hash = view.stdout.match(/[0-9a-f]{64}/)[0];

  const destPath = join(fixtureDir, "exported-copy.html");
  const exported = await runCli(["families", "export", id, hash, "--to", destPath]);
  assert.equal(exported.code, 0, exported.stderr);
  assert.match(exported.stdout, /exported:/);
  assert.equal(readFileSync(destPath, "utf8"), "<html><body>export me</body></html>");

  const badHash = await runCli([
    "families",
    "export",
    id,
    "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    "--to",
    destPath,
  ]);
  assert.equal(badHash.code, 1);
  assert.match(badHash.stdout, /CONTENT_NOT_FOUND/);

  const badDest = await runCli(["families", "export", id, hash, "--to", join(fixtureDir, "no-such-dir", "x.html")]);
  assert.equal(badDest.code, 2);
  assert.match(badDest.stdout, /Could not write/);
});

// Only the validation-error paths are exercised here, deliberately - the
// real success path launches an actual, visible lavish-axi browser session,
// which a CI/automated run should never do as a side effect.
test("families lavish fails loud with a usage error when id/hash are missing, and with a real error for an unknown family", async () => {
  const noArgs = await runCli(["families", "lavish"]);
  assert.equal(noArgs.code, 2);
  assert.match(noArgs.stdout, /id and hash are both required/);

  const unknownFamily = await runCli(["families", "lavish", "does-not-exist", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"]);
  assert.equal(unknownFamily.code, 1);
  assert.match(unknownFamily.stdout, /FAMILY_NOT_FOUND/);
});

test("families delete-version works end to end, including chain-healing and the last-version refusal", async () => {
  const filePath = join(fixtureDir, "delver.html");
  writeFileSync(filePath, "<html><body>v1</body></html>");
  const tracked = await runCli(["track", filePath]);
  const id = tracked.stdout.match(/id: (\S+)/)[1];

  writeFileSync(filePath, "<html><body>v2</body></html>");
  await runCli(["status"]);

  const view = await runCli(["families", "view", id]);
  const hashes = [...view.stdout.matchAll(/^\s*([0-9a-f]{64}),/gm)].map((m) => m[1]);
  const [v1, v2] = hashes;

  const del = await runCli(["families", "delete-version", id, v1]);
  assert.equal(del.code, 0, del.stderr);
  assert.match(del.stdout, new RegExp(`deleted: ${v1}`));

  const lastDel = await runCli(["families", "delete-version", id, v2]);
  assert.equal(lastDel.code, 1);
  assert.match(lastDel.stdout, /CANNOT_DELETE_LAST_VERSION/);
});

test("revert and delete-version HTTP responses return family.versions as an array, the exact shape the UI renders directly without a re-fetch", async () => {
  // A real bug, found by the user actually using the UI: the DELETE route
  // returned store.js's raw family record (versions as a hash-keyed OBJECT),
  // but app.js's renderTimeline()/populateCompareSelects() call
  // family.versions.slice() on the response - which only works on the
  // array shape GET /families/:id already returns via getFamilyFromIndex().
  // No CLI-level test caught this, since the CLI only ever reads
  // familySummary()'s derived fields, never the raw `versions` field itself
  // - this asserts the actual HTTP response shape the UI depends on.
  const filePath = join(fixtureDir, "shape-check.html");
  writeFileSync(filePath, "<html><body>v1</body></html>");
  const tracked = await runCli(["track", filePath]);
  const id = tracked.stdout.match(/id: (\S+)/)[1];

  writeFileSync(filePath, "<html><body>v2</body></html>");
  await runCli(["status"]);

  const view = await runCli(["families", "view", id]);
  const hashes = [...view.stdout.matchAll(/^\s*([0-9a-f]{64}),/gm)].map((m) => m[1]);
  const [v1, v2] = hashes;

  const revertRes = await fetch(`http://127.0.0.1:${port}/families/${id}/revert`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hash: v1 }),
  });
  const revertBody = await revertRes.json();
  assert.equal(Array.isArray(revertBody.family.versions), true, "revert's response must return versions as an array");

  const deleteRes = await fetch(`http://127.0.0.1:${port}/families/${id}/versions/${v1}`, { method: "DELETE" });
  const deleteBody = await deleteRes.json();
  assert.equal(deleteRes.status, 200, JSON.stringify(deleteBody));
  assert.equal(Array.isArray(deleteBody.family.versions), true, "delete-version's response must return versions as an array");
});

test("the access token is never echoed back over GET or PUT /settings, only whether one is set", async () => {
  const putRes = await fetch(`http://127.0.0.1:${port}/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshotRemote: "https://example.invalid/repo.git", snapshotRemoteToken: "ghp_realsecret" }),
  });
  const putBody = await putRes.json();
  assert.equal(putBody.snapshotRemoteTokenSet, true);
  assert.equal("snapshotRemoteToken" in putBody, false, "PUT response must never include the raw token field");
  assert.equal(JSON.stringify(putBody).includes("ghp_realsecret"), false);

  const getRes = await fetch(`http://127.0.0.1:${port}/settings`);
  const getBody = await getRes.json();
  assert.equal(getBody.snapshotRemoteTokenSet, true);
  assert.equal("snapshotRemoteToken" in getBody, false, "GET response must never include the raw token field");
  assert.equal(JSON.stringify(getBody).includes("ghp_realsecret"), false);
});

test("docmanager setup ssh reports plainly when the configured remote isn't SSH-style", async () => {
  await runCli(["settings", "set", "--snapshot-remote", "https://example.invalid/repo.git"]);
  const { code, stdout } = await runCli(["setup", "ssh"]);
  assert.equal(code, 0);
  assert.match(stdout, /not an SSH-style URL/);
});

test("the rendered content-diff route highlights real changed blocks and rejects malformed requests", async () => {
  const filePath = join(fixtureDir, "renderdiff.html");
  writeFileSync(filePath, "<html><body><p>Original wording.</p><p>Unchanged line.</p></body></html>");
  const tracked = await runCli(["track", filePath]);
  const id = tracked.stdout.match(/id: (\S+)/)[1];

  writeFileSync(filePath, "<html><body><p>Updated wording.</p><p>Unchanged line.</p></body></html>");
  await runCli(["status"]);

  const view = await runCli(["families", "view", id]);
  const hashes = [...view.stdout.matchAll(/^\s*([0-9a-f]{64}),/gm)].map((m) => m[1]);
  const [oldHash, newHash] = hashes;

  const removedRes = await fetch(`http://127.0.0.1:${port}/content/${oldHash}/diff-against/${newHash}?mode=removed`);
  const removedBody = await removedRes.text();
  assert.equal(removedRes.status, 200);
  assert.match(removedBody, /<p data-diff="removed">Original wording\.<\/p>/);
  assert.match(removedBody, /<p>Unchanged line\.<\/p>/);

  const addedRes = await fetch(`http://127.0.0.1:${port}/content/${newHash}/diff-against/${oldHash}?mode=added`);
  assert.match(await addedRes.text(), /<p data-diff="added">Updated wording\.<\/p>/);

  const badHash = await fetch(`http://127.0.0.1:${port}/content/not-a-real-hash/diff-against/${newHash}?mode=removed`);
  assert.equal(badHash.status, 400);

  const badMode = await fetch(`http://127.0.0.1:${port}/content/${oldHash}/diff-against/${newHash}?mode=bogus`);
  assert.equal(badMode.status, 400);

  const unknownHash = "f".repeat(64);
  const notFound = await fetch(`http://127.0.0.1:${port}/content/${unknownHash}/diff-against/${newHash}?mode=removed`);
  assert.equal(notFound.status, 404);
});

test("families rename and families tags work end to end through the real binary", async () => {
  const filePath = join(fixtureDir, "renamable.html");
  writeFileSync(filePath, "<html><body>rename me</body></html>");
  const tracked = await runCli(["track", filePath]);
  const id = tracked.stdout.match(/id: (\S+)/)[1];

  const rename = await runCli(["families", "rename", id, "/renamed-doc"]);
  assert.equal(rename.code, 0, rename.stderr);
  assert.match(rename.stdout, /renamed: true/);
  assert.match(rename.stdout, /\/renamed-doc/);

  const renameAgain = await runCli(["families", "rename", id, "/renamed-doc"]);
  assert.match(renameAgain.stdout, /renamed: false/);

  const status = await runCli(["status"]);
  assert.match(status.stdout, /\/renamed-doc/, "reconcile should report the new path, not the stale original one");
  assert.doesNotMatch(status.stdout, /\/renamable/);

  const tagsEmpty = await runCli(["families", "tags", id]);
  assert.equal(tagsEmpty.code, 0);
  assert.match(tagsEmpty.stdout, /tags: \[\]/);

  const tagsSet = await runCli(["families", "tags", id, "--set", "draft, q3"]);
  assert.equal(tagsSet.code, 0, tagsSet.stderr);
  assert.match(tagsSet.stdout, /draft/);
  assert.match(tagsSet.stdout, /q3/);

  const tagsAdd = await runCli(["families", "tags", id, "--add", "internal"]);
  assert.match(tagsAdd.stdout, /internal/);
  assert.match(tagsAdd.stdout, /draft/);

  const tagsRemove = await runCli(["families", "tags", id, "--remove", "q3"]);
  assert.doesNotMatch(tagsRemove.stdout, /q3/);
  assert.match(tagsRemove.stdout, /draft/);
  assert.match(tagsRemove.stdout, /internal/);

  const searchByTag = await runCli(["search", "internal"]);
  assert.equal(searchByTag.code, 0, searchByTag.stderr);
  assert.match(searchByTag.stdout, /\/renamed-doc/);

  const badRename = await runCli(["families", "rename", "does-not-exist", "/x"]);
  assert.equal(badRename.code, 1);
  assert.match(badRename.stdout, /FAMILY_NOT_FOUND/);
});

test("folders create / list / rename / move / delete work end to end through the real binary", async () => {
  const created = await runCli(["folders", "create", "Reports"]);
  assert.equal(created.code, 0, created.stderr);
  assert.match(created.stdout, /created: Reports/);
  const idMatch = created.stdout.match(/id: (\S+)/);
  assert.ok(idMatch, "folders create output should include the new folder id");
  const folderId = idMatch[1];

  const child = await runCli(["folders", "create", "Q3", "--parent", folderId]);
  assert.equal(child.code, 0, child.stderr);
  const childIdMatch = child.stdout.match(/id: (\S+)/);
  const childId = childIdMatch[1];

  const list = await runCli(["folders", "list"]);
  assert.equal(list.code, 0);
  assert.match(list.stdout, /Reports/);
  assert.match(list.stdout, /Q3/);

  const renamed = await runCli(["folders", "rename", folderId, "Archived Reports"]);
  assert.equal(renamed.code, 0, renamed.stderr);
  assert.match(renamed.stdout, /renamed: true/);

  const moved = await runCli(["folders", "move", childId]);
  assert.equal(moved.code, 0, moved.stderr);
  assert.match(moved.stdout, /moved: true/);

  const deleteChild = await runCli(["folders", "delete", childId]);
  assert.equal(deleteChild.code, 0, deleteChild.stderr);
  assert.match(deleteChild.stdout, /deleted: Q3/);

  const deleteParent = await runCli(["folders", "delete", folderId]);
  assert.equal(deleteParent.code, 0, deleteParent.stderr);
});

test("folders delete refuses a non-empty folder", async () => {
  const created = await runCli(["folders", "create", "NotEmpty"]);
  const folderId = created.stdout.match(/id: (\S+)/)[1];
  await runCli(["folders", "create", "Child", "--parent", folderId]);

  const result = await runCli(["folders", "delete", folderId]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /not empty/i);
});

test("folders move rejects a cycle", async () => {
  const a = await runCli(["folders", "create", "A"]);
  const aId = a.stdout.match(/id: (\S+)/)[1];
  const b = await runCli(["folders", "create", "B", "--parent", aId]);
  const bId = b.stdout.match(/id: (\S+)/)[1];

  const result = await runCli(["folders", "move", aId, "--parent", bId]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /descendant/i);
});

test("folders create requires a name", async () => {
  const result = await runCli(["folders", "create"]);
  assert.equal(result.code, 2);
});

test("families move puts a document in a folder, and --unfile takes it back out", async () => {
  const filePath = join(fixtureDir, "moveme.html");
  writeFileSync(filePath, "<html><body>v1</body></html>");
  const tracked = await runCli(["track", filePath]);
  const familyId = tracked.stdout.match(/id: (\S+)/)[1];

  const folder = await runCli(["folders", "create", "MoveTarget"]);
  const folderId = folder.stdout.match(/id: (\S+)/)[1];

  const moved = await runCli(["families", "move", familyId, "--to-folder", folderId]);
  assert.equal(moved.code, 0, moved.stderr);
  assert.match(moved.stdout, /1 moved, 0 failed/);

  const unfiled = await runCli(["families", "move", familyId, "--unfile"]);
  assert.equal(unfiled.code, 0, unfiled.stderr);
  assert.match(unfiled.stdout, /1 moved, 0 failed/);
});

test("families move to a nonexistent folder id fails without aborting other ids", async () => {
  const filePath = join(fixtureDir, "moveme2.html");
  writeFileSync(filePath, "<html><body>v1</body></html>");
  const tracked = await runCli(["track", filePath]);
  const familyId = tracked.stdout.match(/id: (\S+)/)[1];

  const result = await runCli(["families", "move", familyId, "--to-folder", "does-not-exist"]);
  assert.equal(result.code, 1);
});

test("families move requires --to-folder or --unfile", async () => {
  const result = await runCli(["families", "move", "some-id"]);
  assert.equal(result.code, 2);
});

test("core status reflects a real running core, and stop actually stops it", async () => {
  const status = await runCli(["core", "status"]);
  assert.match(status.stdout, /running/);

  const stop = await runCli(["core", "stop"]);
  assert.equal(stop.code, 0);
  assert.match(stop.stdout, /core: stopped/);

  const statusAfter = await runCli(["core", "status"]);
  assert.match(statusAfter.stdout, /not running/);
});
