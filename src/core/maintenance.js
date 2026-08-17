import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { storePath, withStoreLock } from "./store.js";
import { runGit } from "./git.js";

// Every version of every tracked document lives on as a git commit forever
// (the append-only model this whole project is built on) - nothing else
// ever prunes or compacts that history. Left alone indefinitely across many
// families and years of real use, the store's .git directory only grows.
// git itself already solves this (loose objects -> packfiles, deltas
// against similar content) - `git gc` just needs to actually be run
// sometimes. This is deliberately never automatic: an opt-in command the
// user (or their agent, when asked) runs occasionally, not a background job
// silently doing file-level work on every push/pull.
// git's own gc/maintenance can leave transient lock files (e.g.
// objects/maintenance.lock) that appear and vanish on its own schedule,
// independent of our await on the gc subprocess itself - a real race
// against this walk, seen for real in CI. This is only ever an informational
// size report, not a correctness-critical value, so a file that disappears
// between listing and stating just contributes 0 rather than crashing the
// whole report.
function dirSizeBytes(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    try {
      total += entry.isDirectory() ? dirSizeBytes(full) : statSync(full).size;
    } catch {
      // Vanished between listing and stating - skip it.
    }
  }
  return total;
}

export async function runGc() {
  return withStoreLock(async () => {
    if (!existsSync(storePath())) {
      const err = new Error("Nothing to clean up yet - track a document first.");
      err.code = "NOTHING_TO_CLEAN";
      throw err;
    }
    const sizeBefore = dirSizeBytes(join(storePath(), ".git"));
    await runGit(storePath(), ["gc"]);
    const sizeAfter = dirSizeBytes(join(storePath(), ".git"));
    return { ranGc: true, sizeBeforeBytes: sizeBefore, sizeAfterBytes: sizeAfter };
  });
}
