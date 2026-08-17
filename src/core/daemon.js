import { writeFileSync, readFileSync } from "node:fs";
import { createServer, SERVICE_NAME } from "./server.js";
import { lockFilePath } from "./paths.js";
import { VERSION } from "../version.js";
import { idleMs } from "./activity.js";
import { onShutdownRequested, requestShutdown } from "./shutdown.js";
import { rotateLogIfNeeded } from "./log-rotation.js";

// If the lock file this daemon registered itself under disappears or gets
// overwritten with a different pid - deleted out from under it, replaced by
// a newer daemon that didn't know this one was still alive - it is now an
// orphan: still running, still holding its port, invisible to
// ensureCoreRunning()'s discovery. Left unchecked, every such event leaves
// a permanently leaked process behind. Checking periodically and shutting
// down on mismatch is what makes the singleton design self-healing instead
// of failing open into a silent pile of zombies.
const SELF_CHECK_INTERVAL_MS = 15000;

// A user running one CLI command and never touching docmanager again should
// not leave a background process running indefinitely. An open, connected
// UI tab counts as real activity (see server.js's heartbeat), so this only
// ever fires on genuine abandonment, never mid-use - overridable for anyone
// who wants a shorter or longer window.
const DEFAULT_IDLE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const IDLE_CHECK_INTERVAL_MS =
  Number(process.env.DOCMANAGER_IDLE_CHECK_INTERVAL_MS) || DEFAULT_IDLE_CHECK_INTERVAL_MS;
const IDLE_TIMEOUT_MS = Number(process.env.DOCMANAGER_IDLE_TIMEOUT_MS) || DEFAULT_IDLE_TIMEOUT_MS;

const preferredPort = Number(process.argv[2]) || 0;
const server = createServer();

function listenOn(port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
}

function startSelfCheck() {
  const timer = setInterval(() => {
    let lock;
    try {
      lock = JSON.parse(readFileSync(lockFilePath(), "utf8"));
    } catch {
      lock = null;
    }
    if (!lock || lock.pid !== process.pid) {
      requestShutdown("lock file no longer identifies this process");
    }
  }, SELF_CHECK_INTERVAL_MS);
  timer.unref();
}

function startIdleCheck() {
  const timer = setInterval(() => {
    if (idleMs() > IDLE_TIMEOUT_MS) {
      requestShutdown(`idle for over ${Math.round(IDLE_TIMEOUT_MS / 60000)} minutes`);
    }
  }, IDLE_CHECK_INTERVAL_MS);
  timer.unref();
}

// Rotation also happens once at every daemon spawn (lifecycle.js), which
// covers the common case of periodic restarts - but a single daemon can
// stay running far longer than that (continuous activity resets the idle
// timeout indefinitely), so core.log still needs its own size checked
// periodically from inside the process that's actually still writing to
// it, not just at the moment it started.
const LOG_ROTATION_CHECK_INTERVAL_MS =
  Number(process.env.DOCMANAGER_LOG_ROTATION_CHECK_INTERVAL_MS) || 30 * 60 * 1000;

function startLogRotationCheck() {
  const timer = setInterval(rotateLogIfNeeded, LOG_ROTATION_CHECK_INTERVAL_MS);
  timer.unref();
}

// The one canonical shutdown path - every trigger (SIGTERM, the self-check,
// the idle timeout, the UI's explicit stop action) converges here instead
// of each needing its own close logic. server.close() alone waits for
// every open connection to end on its own before its callback fires - an
// SSE stream never ends by itself, so stopping would hang forever with a
// browser tab open. closeAllConnections() forces existing sockets shut
// immediately so shutdown is always prompt, regardless of what's connected.
onShutdownRequested((reason) => {
  console.error(`docmanager-core (pid ${process.pid}): shutting down - ${reason}`);
  server.closeAllConnections();
  server.close(() => process.exit(0));
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A port a daemon just vacated (a stop immediately followed by a start,
// the exact sequence "click stop, then run a command" produces) can still
// briefly answer EADDRINUSE while the OS finishes releasing it - confirmed
// directly, not theoretical: a real stop-then-start cycle hit this once
// during testing. A few short retries absorb that window; only a port
// genuinely held by something else falls all the way through to random.
const PORT_RETRY_ATTEMPTS = 5;
const PORT_RETRY_DELAY_MS = 200;

async function start() {
  if (preferredPort !== 0) {
    for (let attempt = 1; attempt <= PORT_RETRY_ATTEMPTS; attempt++) {
      try {
        await listenOn(preferredPort);
        break;
      } catch (err) {
        if (err.code !== "EADDRINUSE") throw err;
        if (attempt === PORT_RETRY_ATTEMPTS) {
          await listenOn(0);
          break;
        }
        await delay(PORT_RETRY_DELAY_MS);
      }
    }
  } else {
    await listenOn(0);
  }

  const address = server.address();
  writeFileSync(
    lockFilePath(),
    JSON.stringify(
      {
        service: SERVICE_NAME,
        version: VERSION,
        pid: process.pid,
        port: address.port,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  startSelfCheck();
  startIdleCheck();
  startLogRotationCheck();
}

start().catch((err) => {
  console.error("docmanager-core failed to start:", err);
  process.exit(1);
});

process.on("SIGTERM", () => requestShutdown("SIGTERM"));
