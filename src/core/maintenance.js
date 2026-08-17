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
function dirSizeBytes(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    total += entry.isDirectory() ? dirSizeBytes(full) : statSync(full).size;
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
