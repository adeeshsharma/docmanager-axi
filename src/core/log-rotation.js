import { existsSync, statSync, copyFileSync, truncateSync } from "node:fs";
import { logFilePath } from "./paths.js";

// A long-lived background process with nothing capping this would write to
// core.log forever. Overridable for tests (a tiny threshold triggers
// rotation without writing megabytes of fake data) and for anyone who
// genuinely wants a different ceiling. Read fresh on every call, not cached
// at module-import time - matching paths.js's own docmanagerHome()
// convention - so an env override set after this module first loads (e.g.
// per-test, in beforeEach) actually takes effect.
const DEFAULT_MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024;
function maxLogSizeBytes() {
  return Number(process.env.DOCMANAGER_MAX_LOG_SIZE_BYTES) || DEFAULT_MAX_LOG_SIZE_BYTES;
}

/**
 * Copy-then-truncate, not rename-then-recreate - deliberately. The daemon's
 * own stdout/stderr are redirected to this exact file's fd for its entire
 * lifetime (`lifecycle.js`'s `spawnDaemon()`), and Node has no way to
 * reopen `process.stdout` to a different file at runtime. Renaming the
 * file out from under an already-open fd doesn't touch what that fd
 * writes to - the daemon would keep silently writing into the renamed
 * file forever, never actually shrinking anything. Truncating the file
 * IN PLACE (same inode, same fd, same name) is what actually works
 * whether this runs once at daemon spawn or repeatedly from inside an
 * already-running daemon.
 */
export function rotateLogIfNeeded() {
  const path = logFilePath();
  if (!existsSync(path)) return;

  let size;
  try {
    size = statSync(path).size;
  } catch {
    return; // raced with something else touching the file - not worth failing over
  }
  if (size < maxLogSizeBytes()) return;

  try {
    copyFileSync(path, `${path}.old`);
    truncateSync(path, 0);
  } catch {
    // Best-effort - a failed rotation is never worth crashing the daemon
    // over. The file just keeps growing until the next successful attempt.
  }
}
