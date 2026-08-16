import { existsSync, mkdirSync } from "node:fs";
import { docmanagerHome } from "./paths.js";
import { storePath, withStoreLock } from "./store.js";
import { runGit } from "./git.js";
import { getSettings } from "./settings.js";
import { rebuildIndex } from "./index.js";

function requireRemote() {
  const settings = getSettings();
  if (!settings.snapshotRemote) {
    const err = new Error(
      "No snapshot remote configured. Set one in the UI's Settings page, or `docmanager settings set --snapshot-remote <url>`.",
    );
    err.code = "NO_REMOTE_CONFIGURED";
    throw err;
  }
  return settings.snapshotRemote;
}

export function isHttpsRemote(url) {
  return /^https?:\/\//i.test(url);
}

// Only meaningful for an HTTPS-style remote - an SSH-style remote
// authenticates via SSH key regardless (see ssh-check.js), so a configured
// token is simply unused there, never an error. Injected ephemerally on
// the ONE git invocation that actually needs it (`-c http.extraheader=...`
// as a global option before the subcommand) - never written into the
// store's own .git/config, never embedded in the remote URL itself, so it
// never appears in `git remote -v`, never gets committed by accident, and
// isn't left sitting in a config file beyond this single call.
export function authArgs(url) {
  const { snapshotRemoteToken } = getSettings();
  if (!snapshotRemoteToken || !isHttpsRemote(url)) return [];
  const basic = Buffer.from(`x-access-token:${snapshotRemoteToken}`).toString("base64");
  return ["-c", `http.extraheader=AUTHORIZATION: basic ${basic}`];
}

// git's own real-world wording for these failures, not something docmanager
// invents - detected here so the CLI can name the real cause and point at
// `docmanager setup ssh` instead of surfacing git's raw stderr.
const SSH_AUTH_FAILURE_PATTERN = /permission denied \(publickey\)|host key verification failed/i;

function translateNetworkError(err, fallbackCode, fallbackMessage) {
  if (SSH_AUTH_FAILURE_PATTERN.test(err.message)) {
    const sshErr = new Error(
      "SSH authentication failed for this remote - this machine's SSH key may not be registered with the git host yet. " +
        "Run `docmanager setup ssh` to check.",
    );
    sshErr.code = "SSH_AUTH_FAILED";
    throw sshErr;
  }
  const translated = new Error(fallbackMessage);
  translated.code = fallbackCode;
  throw translated;
}

async function ensureRemoteConfigured(url) {
  try {
    await runGit(storePath(), ["remote", "add", "origin", url]);
  } catch {
    // Already configured from a prior push/pull - point it at the current
    // setting instead, in case the user changed the remote since.
    await runGit(storePath(), ["remote", "set-url", "origin", url]);
  }
}

/**
 * Pushes the local store to the configured git remote. The store is always
 * fully committed already (every store.js mutation commits immediately), so
 * this never needs to stage anything itself - just configure the remote and
 * push.
 */
export async function pushSnapshot() {
  const url = requireRemote();
  return withStoreLock(async () => {
    if (!existsSync(storePath())) {
      const err = new Error("Nothing to push yet - track a document first.");
      err.code = "NOTHING_TO_PUSH";
      throw err;
    }
    await ensureRemoteConfigured(url);
    try {
      await runGit(storePath(), [...authArgs(url), "push", "-u", "origin", "main"]);
    } catch (err) {
      translateNetworkError(
        err,
        "PUSH_REJECTED",
        "Push was rejected - the remote has changes not present locally. Run `docmanager snapshot pull` first, then push again.",
      );
    }
    return { pushed: true };
  });
}

/**
 * Pulls the configured remote. On a machine with no local store yet, this
 * clones fresh rather than assuming a repo already exists. On a machine
 * that already has one, it's a real fetch + merge - never a force-overwrite
 * - so unpushed local changes are never discarded. A genuine same-family
 * conflict aborts the merge cleanly (local store stays exactly as it was
 * before the pull) and reports it, rather than attempting to auto-resolve.
 */
export async function pullSnapshot() {
  const url = requireRemote();
  return withStoreLock(async () => {
    if (!existsSync(storePath())) {
      mkdirSync(docmanagerHome(), { recursive: true, mode: 0o700 });
      try {
        await runGit(docmanagerHome(), [...authArgs(url), "clone", url, "store"]);
      } catch (err) {
        translateNetworkError(err, "CLONE_FAILED", `Could not clone the configured remote (${url}).`);
      }
      rebuildIndex();
      return { pulled: true, mode: "clone" };
    }

    await ensureRemoteConfigured(url);
    try {
      await runGit(storePath(), [...authArgs(url), "fetch", "origin", "main"]);
    } catch (err) {
      translateNetworkError(err, "FETCH_FAILED", `Could not fetch the configured remote (${url}).`);
    }
    try {
      await runGit(storePath(), ["merge", "origin/main", "--no-edit"]);
    } catch {
      await runGit(storePath(), ["merge", "--abort"]).catch(() => {});
      const err = new Error(
        "Snapshot pull found a conflict that needs manual resolution. Local changes were not affected - " +
          `resolve it directly with git in ${storePath()}, then pull again.`,
      );
      err.code = "SYNC_CONFLICT";
      throw err;
    }
    rebuildIndex();
    return { pulled: true, mode: "merge" };
  });
}
