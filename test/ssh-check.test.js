import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useIsolatedHome, cleanupHome } from "./helpers.js";
import { updateSettings } from "../src/core/settings.js";
import { extractSshHost, isSshRemote, classifyConnectionOutput, checkSshSetup } from "../src/core/ssh-check.js";

let homeDir;
beforeEach(() => {
  homeDir = useIsolatedHome();
});
afterEach(() => {
  cleanupHome(homeDir);
});

test("extractSshHost handles the real URL shapes git actually accepts", () => {
  assert.equal(extractSshHost("git@github.com:you/repo.git"), "github.com");
  assert.equal(extractSshHost("ssh://git@github.com/you/repo.git"), "github.com");
  assert.equal(extractSshHost("git@gitlab.example.com:group/repo.git"), "gitlab.example.com");
  assert.equal(extractSshHost("https://github.com/you/repo.git"), null);
  assert.equal(extractSshHost("/local/bare/repo.git"), null);
});

test("isSshRemote matches extractSshHost", () => {
  assert.equal(isSshRemote("git@github.com:you/repo.git"), true);
  assert.equal(isSshRemote("https://github.com/you/repo.git"), false);
});

test("classifyConnectionOutput recognizes GitHub's real 'successfully authenticated but no shell' quirk as success, not failure", () => {
  // Real, well-known wording - GitHub intentionally denies shell access
  // even on a fully successful auth and exits non-zero regardless, so this
  // has to be read from the message text, never the exit code.
  const realGithubOutput =
    "Hi someuser! You've successfully authenticated, but GitHub does not provide shell access.";
  assert.equal(classifyConnectionOutput(realGithubOutput), "ok");
});

test("classifyConnectionOutput recognizes a real publickey rejection as failure", () => {
  const realFailureOutput = "git@github.com: Permission denied (publickey).";
  assert.equal(classifyConnectionOutput(realFailureOutput), "failed");
});

test("classifyConnectionOutput reports unknown for anything it can't confidently classify, rather than guessing", () => {
  assert.equal(classifyConnectionOutput("some completely unrelated output"), "unknown");
});

test("checkSshSetup reports no remote configured without attempting any connection", () => {
  const result = checkSshSetup();
  assert.equal(result.remoteConfigured, false);
  assert.equal(result.isSshRemote, false);
  assert.equal(result.connection, null);
});

test("checkSshSetup reports an HTTPS remote as not SSH, without attempting any connection", () => {
  updateSettings({ snapshotRemote: "https://github.com/you/repo.git" });
  const result = checkSshSetup();
  assert.equal(result.remoteConfigured, true);
  assert.equal(result.isSshRemote, false);
  assert.equal(result.connection, null);
});
