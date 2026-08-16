import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { useIsolatedHome, cleanupHome } from "./helpers.js";
import { createFamily, storePath } from "../src/core/store.js";
import { addMapping } from "../src/core/local-state.js";
import { docmanagerHome } from "../src/core/paths.js";
import { runDoctor } from "../src/core/doctor.js";

let homeDir;
beforeEach(() => {
  homeDir = useIsolatedHome();
});
afterEach(() => {
  cleanupHome(homeDir);
});

function check(report, name) {
  const found = report.checks.find((c) => c.name === name);
  assert.ok(found, `expected a "${name}" check in the report`);
  return found;
}

test("a healthy store reports ok on every check", async () => {
  await createFamily({ syntheticPath: "/report", content: Buffer.from("<html><body>v1</body></html>") });

  const report = await runDoctor();

  assert.equal(report.status, "ok");
  assert.equal(check(report, "git").status, "ok");
  assert.equal(check(report, "store").status, "ok");
  assert.equal(check(report, "familyIntegrity").status, "ok");
  assert.equal(check(report, "contentIntegrity").status, "ok");
  assert.equal(check(report, "index").status, "ok");
  assert.equal(check(report, "localState").status, "ok");
});

test("no store yet is a warning, not an error, and skips the deeper checks rather than reporting hollow problems", async () => {
  const report = await runDoctor();
  assert.equal(check(report, "store").status, "warning");
  assert.equal(report.checks.some((c) => c.name === "familyIntegrity"), false);
});

test("a corrupt family JSON file is reported as an error, never auto-repaired, and never breaks the index or contentIntegrity checks for other families", async () => {
  await createFamily({ syntheticPath: "/a", content: Buffer.from("<html><body>a</body></html>") });
  writeFileSync(join(storePath(), "families", "deadbeef.json"), "{not valid json");

  const report = await runDoctor();

  assert.equal(report.status, "error");
  const familyIntegrity = check(report, "familyIntegrity");
  assert.equal(familyIntegrity.status, "error");
  assert.equal(familyIntegrity.details.length, 1);
  assert.equal(familyIntegrity.details[0].id, "deadbeef");

  // The corrupt file must still be sitting there, untouched.
  assert.ok(existsSync(join(storePath(), "families", "deadbeef.json")));

  // The one healthy family must still be indexed and reported content-complete.
  assert.equal(check(report, "index").status, "ok");
  assert.equal(check(report, "contentIntegrity").status, "ok");
});

test("a version whose content blob is missing on disk is reported, never auto-repaired", async () => {
  const family = await createFamily({ syntheticPath: "/a", content: Buffer.from("<html><body>a</body></html>") });
  unlinkSync(join(storePath(), "content", `${family.headVersion}.html`));

  const report = await runDoctor();

  assert.equal(report.status, "error");
  const contentIntegrity = check(report, "contentIntegrity");
  assert.equal(contentIntegrity.status, "error");
  assert.equal(contentIntegrity.details[0].hash, family.headVersion);
});

test("an orphaned local-state mapping (family genuinely gone) is auto-repaired", async () => {
  // Doctor only runs its deeper checks (including localState) once a store
  // actually exists - see the "no store yet" test above - so a real family
  // has to exist first for this repair path to even be reachable.
  await createFamily({ syntheticPath: "/a", content: Buffer.from("<html><body>a</body></html>") });
  addMapping({ syntheticPath: "/ghost", realPath: "/tmp/does-not-matter.html", familyId: "nonexistent-id" });

  const report = await runDoctor();

  const localState = check(report, "localState");
  assert.equal(localState.status, "repaired");
  assert.equal(localState.details[0].syntheticPath, "/ghost");

  const mappings = JSON.parse(readFileSync(join(docmanagerHome(), "local-state.json"), "utf8"));
  assert.equal(mappings.length, 0);
});

test("a mapping pointing at a CORRUPT (not missing) family is left alone, not deleted", async () => {
  await createFamily({ syntheticPath: "/a", content: Buffer.from("<html><body>a</body></html>") });
  writeFileSync(join(storePath(), "families", "deadbeef.json"), "{not valid json");
  // createFamily() (store-level) doesn't itself add a local-state mapping -
  // only trackPath() does - so the only mapping present is this one.
  addMapping({ syntheticPath: "/corrupt-doc", realPath: "/tmp/does-not-matter-either.html", familyId: "deadbeef" });

  const report = await runDoctor();

  // Only genuinely-missing mappings get cleaned up - a corrupt-but-present
  // family must not be silently deleted, since the underlying data might
  // still be recoverable and that's a real judgment call, not doctor's to make.
  const localState = check(report, "localState");
  assert.equal(localState.status, "ok");
  assert.equal(localState.message, "1 local path mapping(s), all valid");

  const mappings = JSON.parse(readFileSync(join(docmanagerHome(), "local-state.json"), "utf8"));
  assert.equal(mappings.length, 1);
});

test("running doctor twice is idempotent - the second run reports nothing left to repair", async () => {
  await createFamily({ syntheticPath: "/a", content: Buffer.from("<html><body>a</body></html>") });
  addMapping({ syntheticPath: "/ghost", realPath: "/tmp/does-not-matter.html", familyId: "nonexistent-id" });

  const first = await runDoctor();
  assert.equal(check(first, "localState").status, "repaired");

  const second = await runDoctor();
  assert.equal(check(second, "localState").status, "ok");
});

test("git availability is checked fresh each run, not cached like the internal git.js check", async () => {
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = process.execPath.includes("/") ? process.execPath.split("/").slice(0, -1).join("/") : "";
    const report = await runDoctor();
    assert.equal(check(report, "git").status, "error");
  } finally {
    process.env.PATH = originalPath;
  }
});
