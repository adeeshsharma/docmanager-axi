import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useIsolatedHome, cleanupHome } from "./helpers.js";
import { getSettings, updateSettings } from "../src/core/settings.js";

let homeDir;
beforeEach(() => {
  homeDir = useIsolatedHome();
});
afterEach(() => {
  cleanupHome(homeDir);
});

test("defaults include snapshotRemoteToken, unset", () => {
  const settings = getSettings();
  assert.equal(settings.snapshotRemote, null);
  assert.equal(settings.snapshotRemoteToken, null);
});

test("the token can be set and read back at this layer (redaction happens in server.js, not here)", () => {
  updateSettings({ snapshotRemoteToken: "ghp_realtoken" });
  assert.equal(getSettings().snapshotRemoteToken, "ghp_realtoken");
});

test("the remote and the token can be updated independently of each other", () => {
  updateSettings({ snapshotRemote: "https://example.invalid/repo.git" });
  updateSettings({ snapshotRemoteToken: "ghp_realtoken" });
  const settings = getSettings();
  assert.equal(settings.snapshotRemote, "https://example.invalid/repo.git");
  assert.equal(settings.snapshotRemoteToken, "ghp_realtoken");

  updateSettings({ snapshotRemoteToken: null });
  const cleared = getSettings();
  assert.equal(cleared.snapshotRemoteToken, null);
  assert.equal(cleared.snapshotRemote, "https://example.invalid/repo.git", "clearing the token must not touch the remote");
});

test("an unknown setting key is still rejected", () => {
  assert.throws(() => updateSettings({ notARealSetting: "x" }), (err) => err.code === "UNKNOWN_SETTING");
});
