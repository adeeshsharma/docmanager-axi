import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { useIsolatedHome, cleanupHome } from "./helpers.js";
import { lockFilePath } from "../src/core/paths.js";
import { SERVICE_NAME } from "../src/core/server.js";
import { VERSION } from "../src/version.js";
import { coreStatus, ensureCoreRunning, stopCore } from "../src/core/lifecycle.js";

let homeDir;
// A throwaway, genuinely separate child process stands in for "a stale
// core" - its real, living pid is what a hand-written lock file points at,
// so isProcessAlive() finds it genuinely alive without ever risking this
// test process's own pid being the thing that gets SIGTERM'd.
let fakeCoreChild;
let fakeHealthServer;

beforeEach(() => {
  homeDir = useIsolatedHome();
});

afterEach(async () => {
  if (fakeCoreChild && !fakeCoreChild.killed) {
    fakeCoreChild.kill();
  }
  fakeCoreChild = null;
  if (fakeHealthServer) {
    await new Promise((resolve) => fakeHealthServer.close(resolve));
    fakeHealthServer = null;
  }
  await stopCore().catch(() => {});
  cleanupHome(homeDir);
});

function spawnFakeCoreProcess() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
}

function startFakeHealthServer(reportedVersion, reportedPid) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ service: SERVICE_NAME, version: reportedVersion, pid: reportedPid }));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function writeFakeLock(pid, port) {
  writeFileSync(
    lockFilePath(),
    JSON.stringify({ service: SERVICE_NAME, pid, port, startedAt: new Date().toISOString() }, null, 2),
  );
}

test("coreStatus reports a healthy but old-versioned core as stale, without touching it", async () => {
  fakeCoreChild = spawnFakeCoreProcess();
  await new Promise((resolve) => setTimeout(resolve, 50)); // let it actually start

  fakeHealthServer = await startFakeHealthServer("0.0.0-old-fake", fakeCoreChild.pid);
  writeFakeLock(fakeCoreChild.pid, fakeHealthServer.address().port);

  const status = await coreStatus();
  assert.equal(status.running, true);
  assert.equal(status.version, "0.0.0-old-fake");
  assert.equal(status.stale, true);
  assert.equal(fakeCoreChild.killed, false, "a read-only status check must never kill the stale core itself");
});

test("coreStatus reports a current-versioned core as not stale", async () => {
  fakeCoreChild = spawnFakeCoreProcess();
  await new Promise((resolve) => setTimeout(resolve, 50));

  fakeHealthServer = await startFakeHealthServer(VERSION, fakeCoreChild.pid);
  writeFakeLock(fakeCoreChild.pid, fakeHealthServer.address().port);

  const status = await coreStatus();
  assert.equal(status.running, true);
  assert.equal(status.stale, false);
});

test("ensureCoreRunning restarts a stale-versioned core rather than reusing it, and the replacement reports the current version", { timeout: 15000 }, async () => {
  fakeCoreChild = spawnFakeCoreProcess();
  await new Promise((resolve) => setTimeout(resolve, 50));

  fakeHealthServer = await startFakeHealthServer("0.0.0-old-fake", fakeCoreChild.pid);
  const fakePort = fakeHealthServer.address().port;
  writeFakeLock(fakeCoreChild.pid, fakePort);

  const result = await ensureCoreRunning();

  assert.notEqual(result.pid, fakeCoreChild.pid, "must not report the stale core's own pid as the running one");
  const statusAfter = await coreStatus();
  assert.equal(statusAfter.running, true);
  assert.equal(statusAfter.stale, false, "the freshly spawned real core must report the current VERSION");
  assert.equal(statusAfter.pid, result.pid);
});
