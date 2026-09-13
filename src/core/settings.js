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
  // Set internally, once, by the first successful `snapshot push` that
  // actually goes through - not something exposed via `docmanager settings
  // set` directly. See snapshot.js's own privacy-nudge check.
  snapshotPrivacyAcknowledged: false,
  // How long a burst of rapid saves (an AI or human editing a tracked file
  // several times a second) has to go quiet before the latest content
  // becomes its own permanent version, rather than amending the version
  // currently in progress - see recordVersionIfChanged() in store.js. A
  // fixed enum, not a free-form number: these are the only values the UI's
  // settings dropdown offers, and rejecting anything else here (not just in
  // the UI) keeps that true regardless of caller.
  versionDebounceSeconds: 20,
};

const VERSION_DEBOUNCE_OPTIONS = new Set([5, 10, 15, 20, 30, 45, 60]);

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
  if ("versionDebounceSeconds" in patch && !VERSION_DEBOUNCE_OPTIONS.has(patch.versionDebounceSeconds)) {
    const err = new Error(
      `versionDebounceSeconds must be one of ${[...VERSION_DEBOUNCE_OPTIONS].join(", ")}, got ${patch.versionDebounceSeconds}`,
    );
    err.code = "INVALID_SETTING";
    throw err;
  }
  const next = { ...getSettings(), ...patch };
  writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  return next;
}
