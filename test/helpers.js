import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeIndexHandle } from "../src/core/index.js";

// Every store/index/local-state module reads DOCMANAGER_HOME dynamically
// (never cached at import time - see paths.js), so pointing it at a fresh
// temp directory per test is enough to fully isolate a test's storage from
// both the real ~/.docmanager and from other tests. node's test runner
// spawns each *file* as its own process, so module-level singletons
// (store.js's writeQueue, index.js's cached dbHandle, git.js's `checked`
// flag) never leak across files - only within one file's own sequential
// tests, which is why tests that touch the index always call rebuildIndex()
// themselves rather than assuming a fresh handle.
export function useIsolatedHome() {
  const dir = mkdtempSync(join(tmpdir(), "docmanager-test-"));
  process.env.DOCMANAGER_HOME = dir;
  return dir;
}

export function cleanupHome(dir) {
  // Unlinking an open file is silently fine on POSIX but a hard EBUSY on
  // Windows - the cached SQLite handle (index.js's module-level dbHandle)
  // stays open for the rest of this test file's process otherwise.
  closeIndexHandle();
  delete process.env.DOCMANAGER_HOME;
  rmSync(dir, { recursive: true, force: true });
}
