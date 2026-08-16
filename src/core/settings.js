import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { docmanagerHome } from "./paths.js";

// Settings live outside the git store (never synced) - the snapshot remote
// URL is itself a setting, so syncing it through the thing it configures
// would be circular. Each machine configures its own remote.
function settingsPath() {
  return join(docmanagerHome(), "settings.json");
}

const DEFAULTS = {
  snapshotRemote: null,
  // Only meaningful for an HTTPS-style remote - an SSH-style remote
  // authenticates via SSH key regardless, see ssh-check.js. Never synced
  // (same reasoning as snapshotRemote itself), and never echoed back over
  // the read API - see server.js's /settings route, which is the actual
  // redaction boundary; this module itself stores and returns it plainly,
  // since core-internal callers (snapshot.js) need the real value.
  snapshotRemoteToken: null,
};

const ALLOWED_KEYS = new Set(Object.keys(DEFAULTS));

export function getSettings() {
  if (!existsSync(settingsPath())) return { ...DEFAULTS };
  return { ...DEFAULTS, ...JSON.parse(readFileSync(settingsPath(), "utf8")) };
}

export function updateSettings(patch) {
  const unknown = Object.keys(patch).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknown.length > 0) {
    const err = new Error(`Unknown setting(s): ${unknown.join(", ")}`);
    err.code = "UNKNOWN_SETTING";
    throw err;
  }
  const next = { ...getSettings(), ...patch };
  writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  return next;
}
