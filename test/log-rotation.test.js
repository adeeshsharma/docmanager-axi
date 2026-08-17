import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, readFileSync, openSync, writeSync, closeSync } from "node:fs";
import { useIsolatedHome, cleanupHome } from "./helpers.js";
import { logFilePath } from "../src/core/paths.js";
import { rotateLogIfNeeded } from "../src/core/log-rotation.js";

let homeDir;
let originalMaxSize;
beforeEach(() => {
  homeDir = useIsolatedHome();
  originalMaxSize = process.env.DOCMANAGER_MAX_LOG_SIZE_BYTES;
  process.env.DOCMANAGER_MAX_LOG_SIZE_BYTES = "50"; // tiny threshold, no need to write megabytes
});
afterEach(() => {
  if (originalMaxSize === undefined) delete process.env.DOCMANAGER_MAX_LOG_SIZE_BYTES;
  else process.env.DOCMANAGER_MAX_LOG_SIZE_BYTES = originalMaxSize;
  cleanupHome(homeDir);
});

test("rotateLogIfNeeded is a safe no-op when no log file exists yet", () => {
  assert.equal(existsSync(logFilePath()), false);
  assert.doesNotThrow(() => rotateLogIfNeeded());
});

test("rotateLogIfNeeded leaves a log under the size threshold untouched", () => {
  writeFileSync(logFilePath(), "small");
  rotateLogIfNeeded();
  assert.equal(readFileSync(logFilePath(), "utf8"), "small");
  assert.equal(existsSync(`${logFilePath()}.old`), false);
});

test("rotateLogIfNeeded truncates an oversized log and preserves its prior content in .old", () => {
  const bigContent = "x".repeat(200);
  writeFileSync(logFilePath(), bigContent);
  rotateLogIfNeeded();
  assert.equal(readFileSync(logFilePath(), "utf8"), "");
  assert.equal(readFileSync(`${logFilePath()}.old`, "utf8"), bigContent);
});

test("a second rotation overwrites .old with the newer prior content, not accumulating", () => {
  writeFileSync(logFilePath(), "x".repeat(200));
  rotateLogIfNeeded();
  writeFileSync(logFilePath(), "y".repeat(200)); // write past the threshold again
  rotateLogIfNeeded();
  assert.equal(readFileSync(`${logFilePath()}.old`, "utf8"), "y".repeat(200));
});

// The real reason this rotates via copy+truncate instead of rename: a
// daemon's own stdout/stderr are redirected to an already-open fd for its
// entire lifetime (lifecycle.js's spawnDaemon()), and Node can never reopen
// process.stdout to a different file at runtime. Verified directly here,
// not just reasoned about - open a real fd, write through it, rotate the
// file out from under that same fd, then write through it again, and
// confirm the fd is still writing into the file actually named core.log.
test("rotation works correctly against an already-open, still-being-written-to file descriptor", () => {
  const path = logFilePath();
  writeFileSync(path, "");
  const fd = openSync(path, "a");
  writeSync(fd, "x".repeat(200));

  rotateLogIfNeeded();
  writeSync(fd, "after-rotation");
  closeSync(fd);

  assert.equal(readFileSync(path, "utf8"), "after-rotation");
  assert.equal(readFileSync(`${path}.old`, "utf8"), "x".repeat(200));
});
