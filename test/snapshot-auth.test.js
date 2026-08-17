import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useIsolatedHome, cleanupHome } from "./helpers.js";
import { updateSettings } from "../src/core/settings.js";
import { isHttpsRemote, authArgs, pushSnapshot, pullSnapshot } from "../src/core/snapshot.js";
import { runGit } from "../src/core/git.js";
import { trackPath } from "../src/core/track.js";

let homeDir;
beforeEach(() => {
  homeDir = useIsolatedHome();
});
afterEach(() => {
  cleanupHome(homeDir);
});

test("first push refuses without acknowledgePrivacy, and never reaches the remote", async () => {
  const remoteDir = mkdtempSync(join(tmpdir(), "docmanager-privacytest-remote-"));
  const fixtureDir = mkdtempSync(join(tmpdir(), "docmanager-privacytest-fixture-"));
  try {
    await runGit(remoteDir, ["init", "--bare"]);
    updateSettings({ snapshotRemote: remoteDir });

    const filePath = join(fixtureDir, "doc.html");
    writeFileSync(filePath, "<html><body>v1</body></html>");
    await trackPath(filePath);

    await assert.rejects(pushSnapshot(), (err) => err.code === "PRIVACY_NOT_ACKNOWLEDGED");

    // Refused before ever touching the remote - the bare repo must still have no commits on main.
    const branches = await runGit(remoteDir, ["branch", "--list"]);
    assert.equal(branches.trim(), "", "a refused push must never reach the remote");
  } finally {
    rmSync(remoteDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("acknowledging privacy once persists it - a second push never needs to re-acknowledge", async () => {
  const remoteDir = mkdtempSync(join(tmpdir(), "docmanager-privacytest-remote2-"));
  const fixtureDir = mkdtempSync(join(tmpdir(), "docmanager-privacytest-fixture2-"));
  try {
    await runGit(remoteDir, ["init", "--bare"]);
    updateSettings({ snapshotRemote: remoteDir });

    const filePath = join(fixtureDir, "doc.html");
    writeFileSync(filePath, "<html><body>v1</body></html>");
    await trackPath(filePath);

    const first = await pushSnapshot({ acknowledgePrivacy: true });
    assert.equal(first.pushed, true);

    const second = await pushSnapshot();
    assert.equal(second.pushed, true, "no acknowledgePrivacy needed once already acknowledged");
  } finally {
    rmSync(remoteDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("isHttpsRemote is true only for http(s) URLs, not SSH or local paths", () => {
  assert.equal(isHttpsRemote("https://github.com/you/repo.git"), true);
  assert.equal(isHttpsRemote("http://internal-git/you/repo.git"), true);
  assert.equal(isHttpsRemote("git@github.com:you/repo.git"), false);
  assert.equal(isHttpsRemote("ssh://git@github.com/you/repo.git"), false);
  assert.equal(isHttpsRemote("/local/bare/repo.git"), false);
});

test("authArgs is empty when no token is configured, even for an HTTPS remote", () => {
  assert.deepEqual(authArgs("https://github.com/you/repo.git"), []);
});

test("authArgs is empty for a non-HTTPS remote, even when a token IS configured - the token only ever applies to HTTPS", () => {
  updateSettings({ snapshotRemoteToken: "ghp_realtoken" });
  assert.deepEqual(authArgs("git@github.com:you/repo.git"), []);
  assert.deepEqual(authArgs("/local/bare/repo.git"), []);
});

test("authArgs injects a base64 basic-auth extraheader for an HTTPS remote with a token configured", () => {
  updateSettings({ snapshotRemoteToken: "ghp_realtoken" });
  const args = authArgs("https://github.com/you/repo.git");
  assert.equal(args[0], "-c");
  assert.match(args[1], /^http\.extraheader=AUTHORIZATION: basic /);
  const encoded = args[1].split("basic ")[1];
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), "x-access-token:ghp_realtoken");
});

test("a configured token never breaks a real push/pull against a local (non-HTTPS) remote - authArgs is correctly a no-op there", async () => {
  const remoteDir = mkdtempSync(join(tmpdir(), "docmanager-authtest-remote-"));
  const fixtureDir = mkdtempSync(join(tmpdir(), "docmanager-authtest-fixture-"));
  try {
    await runGit(remoteDir, ["init", "--bare"]);
    updateSettings({ snapshotRemote: remoteDir, snapshotRemoteToken: "ghp_shouldbeignored" });

    const filePath = join(fixtureDir, "doc.html");
    writeFileSync(filePath, "<html><body>v1</body></html>");
    await trackPath(filePath);

    const pushResult = await pushSnapshot({ acknowledgePrivacy: true });
    assert.equal(pushResult.pushed, true);
  } finally {
    rmSync(remoteDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("pullSnapshot's clone path also tolerates a configured token against a local remote", async () => {
  const remoteDir = mkdtempSync(join(tmpdir(), "docmanager-authtest-remote2-"));
  const fixtureDir = mkdtempSync(join(tmpdir(), "docmanager-authtest-fixture2-"));
  const secondHome = mkdtempSync(join(tmpdir(), "docmanager-authtest-home2-"));
  try {
    await runGit(remoteDir, ["init", "--bare"]);
    updateSettings({ snapshotRemote: remoteDir, snapshotRemoteToken: "ghp_shouldbeignored" });

    const filePath = join(fixtureDir, "doc.html");
    writeFileSync(filePath, "<html><body>v1</body></html>");
    await trackPath(filePath);
    await pushSnapshot({ acknowledgePrivacy: true });

    process.env.DOCMANAGER_HOME = secondHome;
    updateSettings({ snapshotRemote: remoteDir, snapshotRemoteToken: "ghp_shouldbeignored" });
    const pullResult = await pullSnapshot();
    assert.equal(pullResult.pulled, true);
    assert.equal(pullResult.mode, "clone");
  } finally {
    process.env.DOCMANAGER_HOME = homeDir;
    rmSync(remoteDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(secondHome, { recursive: true, force: true });
  }
});
