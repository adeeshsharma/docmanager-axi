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

    const pushResult = await pushSnapshot();
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
    await pushSnapshot();

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
