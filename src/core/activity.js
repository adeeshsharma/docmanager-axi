// Tracked separately from the lifecycle lock file, which only records that
// the process exists, not whether anyone is actually using it. daemon.js's
// idle-timeout check reads this to decide whether the core has genuinely
// been forgotten, not just quiet for a moment.
let lastActivityAt = Date.now();

export function markActivity() {
  lastActivityAt = Date.now();
}

export function idleMs() {
  return Date.now() - lastActivityAt;
}
