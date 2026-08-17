import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "..", "bin", "docmanager.js");

// A fully isolated home AND port per test - this command deletes its entire
// home directory, so it must never share state with any other test file
// (cli.test.js's own shared homeDir in particular would be destroyed if a
// reset test ever ran against it).
let homeDir, fixtureDir, env, port;

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "docmanager-reset-home-"));
  fixtureDir = mkdtempSync(join(tmpdir(), "docmanager-reset-fixture-"));
  port = 41000 + (process.pid % 1000);
  env = { ...process.env, DOCMANAGER_HOME: homeDir, DOCMANAGER_PORT: String(port) };
});

afterEach(async () => {
  await runCli(["core", "stop"]).catch(() => {});
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
});

test("reset without --confirm refuses with a usage error and touches nothing", async () => {
  const filePath = join(fixtureDir, "report.html");
  writeFileSync(filePath, "<html><body>v1</body></html>");
  await runCli(["track", filePath]);
  assert.ok(existsSync(homeDir), "home dir should exist after tracking");

  const result = await runCli(["reset"]);
  assert.equal(result.code, 2);
  assert.match(result.stdout, /permanently deletes/i);
  assert.match(result.stdout, /--confirm/);
  assert.ok(existsSync(homeDir), "home dir must still exist - nothing was deleted");

  const families = await runCli(["families"]);
  assert.match(families.stdout, /count: 1 tracked/);
});

test("reset --confirm stops a running core first, then deletes everything, and the next command starts fresh", async () => {
  const filePath = join(fixtureDir, "report.html");
  writeFileSync(filePath, "<html><body>v1</body></html>");
  await runCli(["track", filePath]);

  const statusBefore = await runCli(["core", "status"]);
  assert.match(statusBefore.stdout, /running/);

  const result = await runCli(["reset", "--confirm"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /reset: complete/);
  assert.equal(existsSync(homeDir), false, "the whole home directory must be gone");

  const statusAfter = await runCli(["core", "status"]);
  assert.match(statusAfter.stdout, /not running/);

  // The next command must work correctly against a completely fresh home,
  // not error out because reset left anything half-deleted or dangling.
  const families = await runCli(["families"]);
  assert.equal(families.code, 0, families.stderr);
  assert.match(families.stdout, /0 tracked documents found/);
});

test("reset --confirm with no core running at all still works cleanly", async () => {
  // Never start the core in this test at all.
  const result = await runCli(["reset", "--confirm"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /reset: complete/);
});
