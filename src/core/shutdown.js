// A single canonical shutdown path, requested from more than one place
// (SIGTERM, the idle-timeout check, the UI's explicit stop action, the
// self-check finding its lock file gone) but only ever actually run once -
// daemon.js registers exactly one listener that performs the real
// closeAllConnections()+exit sequence, so every trigger converges on the
// same, already-tested graceful shutdown instead of each needing its own.
let requested = false;
let listener = null;

export function onShutdownRequested(fn) {
  listener = fn;
}

export function requestShutdown(reason) {
  if (requested) return;
  requested = true;
  listener?.(reason);
}
