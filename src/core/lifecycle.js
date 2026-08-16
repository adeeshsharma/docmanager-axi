import {
  existsSync,
  mkdirSync,
  chmodSync,
  openSync,
  closeSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { docmanagerHome, lockFilePath, logFilePath } from "./paths.js";
import { SERVICE_NAME } from "./server.js";
import { VERSION } from "../version.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_SCRIPT = join(__dirname, "daemon.js");

// A fixed default, not a random one, so a browser tab stays valid across a
// restart instead of needing to be reopened every time - continuing the
// sibling AXI tools' own port convention (lavish-axi: 4387, reactive-axi:
// 4388). Only actually falls back to a random port if this exact port is
// taken by something else entirely (see daemon.js's EADDRINUSE handling),
// which stays rare in practice.
const DEFAULT_PORT = Number(process.env.DOCMANAGER_PORT) || 4389;

const READY_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 100;
// How long a "starting" placeholder is trusted before it's treated as a
// crashed starter that never got to bind a port, and cleared for retry.
const STARTING_PLACEHOLDER_TIMEOUT_MS = READY_TIMEOUT_MS * 2;
const MAX_ACQUIRE_ATTEMPTS = 5;
// How long to wait for a stale core (see below) to actually exit after
// SIGTERM before spawning its replacement - core stop already completes in
// well under a second in practice (closeAllConnections(), not a graceful
// wait for open SSE streams), so this is a generous ceiling, not a typical
// wait.
const STOP_WAIT_TIMEOUT_MS = 3000;

function ensureHome() {
  if (!existsSync(docmanagerHome())) {
    mkdirSync(docmanagerHome(), { recursive: true, mode: 0o700 });
  } else {
    chmodSync(docmanagerHome(), 0o700);
  }
}

function readLock() {
  try {
    const raw = readFileSync(lockFilePath(), "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clearLock() {
  try {
    unlinkSync(lockFilePath());
  } catch {
    // Already gone - fine, that's the goal.
  }
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// PID liveness alone is not proof the lock is valid: PIDs are reused after a
// reboot. Confirm the process at that port is genuinely this tool's core.
async function checkHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (body.service !== SERVICE_NAME) return null;
    return body;
  } catch {
    return null;
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return false;
}

async function waitForReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const lock = readLock();
    if (lock && lock.port) {
      const health = await checkHealth(lock.port);
      if (health && health.pid === lock.pid) {
        return { pid: lock.pid, port: lock.port };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    `docmanager core did not become ready within ${READY_TIMEOUT_MS}ms - check ${logFilePath()} for details`,
  );
}

function isStartingPlaceholderFresh(lock) {
  if (!lock.startedAt) return false;
  const age = Date.now() - Date.parse(lock.startedAt);
  return Number.isFinite(age) && age >= 0 && age < STARTING_PLACEHOLDER_TIMEOUT_MS;
}

function spawnDaemon(preferredPort) {
  const logFd = openSync(logFilePath(), "a");
  const child = spawn(process.execPath, [DAEMON_SCRIPT, String(preferredPort)], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);
  return child;
}

/**
 * Starts the core daemon if none is running and reusable, or reuses an
 * already-healthy one. Race-safe against concurrent callers: only one ever
 * wins the exclusive lock-file create, so only one ever spawns a daemon.
 */
export async function ensureCoreRunning() {
  ensureHome();

  // A dead core's port is worth remembering across the loop below: clearing
  // a stale lock re-reads as "no lock file" on the next iteration, which
  // would otherwise lose the port a restart should try to reacquire.
  let lastKnownPort = null;

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    const lock = readLock();

    if (lock) {
      if (lock.port) {
        // A previously-bound core. Reuse it if it's genuinely still alive.
        if (isProcessAlive(lock.pid)) {
          const health = await checkHealth(lock.port);
          if (health && health.pid === lock.pid) {
            if (health.version === VERSION) {
              return { pid: lock.pid, port: lock.port };
            }
            // A real, expected gap after `npm update`/`npm install -g`: the
            // files on disk are the new version, but this already-running
            // process loaded the old code into memory and has no way to
            // notice a change made to files out from under it - node
            // doesn't hot-reload. Restart it rather than silently keep
            // serving from before the update for the rest of its idle
            // lifetime. This is the ONLY case that reaches here: readLock()
            // parses this same version.js on every fresh CLI invocation, so
            // this can't spuriously fire from unrelated code changes during
            // local development, only from an actual version string change
            // between when this core started and now.
            process.kill(lock.pid, "SIGTERM");
            await waitForProcessExit(lock.pid, STOP_WAIT_TIMEOUT_MS);
            lastKnownPort = lock.port;
            clearLock();
            continue;
          }
        }
        // Stale: dead process, or something else now answers on that port.
        lastKnownPort = lock.port;
        clearLock();
        continue;
      }

      // A "starting" placeholder with no port yet.
      if (isStartingPlaceholderFresh(lock)) {
        // Someone else is starting the core right now - wait for them
        // rather than racing to start a second one.
        return waitForReady();
      }
      // Stale placeholder: its starter crashed before ever binding.
      clearLock();
      continue;
    }

    // No lock file at all. Try to become the starter.
    let lockFd;
    try {
      lockFd = openSync(lockFilePath(), "wx");
    } catch (err) {
      if (err.code === "EEXIST") {
        // Someone else's create won the race between our read and now.
        continue;
      }
      throw err;
    }
    closeSync(lockFd);

    writeFileSync(
      lockFilePath(),
      JSON.stringify(
        {
          service: SERVICE_NAME,
          pid: null,
          port: null,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    spawnDaemon(lastKnownPort || DEFAULT_PORT);
    return waitForReady();
  }

  throw new Error("docmanager core: gave up acquiring the startup lock after repeated conflicts");
}

export async function coreStatus() {
  const lock = readLock();
  if (!lock || !lock.port || !isProcessAlive(lock.pid)) {
    return { running: false };
  }
  const health = await checkHealth(lock.port);
  if (!health || health.pid !== lock.pid) {
    return { running: false };
  }
  // A read-only check - never restarts anything itself, unlike
  // ensureCoreRunning(), but a stale version is worth surfacing here too
  // rather than silently reporting "running" with no further detail.
  return {
    running: true,
    pid: lock.pid,
    port: lock.port,
    version: health.version,
    stale: health.version !== VERSION,
  };
}

export async function stopCore() {
  const lock = readLock();
  if (!lock || !lock.pid || !isProcessAlive(lock.pid)) {
    clearLock();
    return { stopped: false };
  }
  process.kill(lock.pid, "SIGTERM");
  clearLock();
  return { stopped: true, pid: lock.pid };
}
