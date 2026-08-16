import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useIsolatedHome, cleanupHome } from "./helpers.js";
import { trackPath } from "../src/core/track.js";
import { reconcile } from "../src/core/reconcile.js";
import { getFamily, recordVersionIfChanged } from "../src/core/store.js";

let homeDir;
let fixtureDir;
beforeEach(() => {
  homeDir = useIsolatedHome();
  fixtureDir = mkdtempSync(join(tmpdir(), "docmanager-fixture-"));
});
afterEach(() => {
  cleanupHome(homeDir);
  rmSync(fixtureDir, { recursive: true, force: true });
});

test("reconcile captures a real content edit as a new version automatically", async () => {
  const filePath = join(fixtureDir, "report.html");
  writeFileSync(filePath, "<html><body>v1</body></html>");
  const { family } = await trackPath(filePath);

  writeFileSync(filePath, "<html><body>v2, genuinely different</body></html>");
  const results = await reconcile();

  assert.equal(results[0].status, "new-version-captured");
  assert.equal(Object.keys(getFamily(family.id).versions).length, 2);
});

test("reconcile leaves versionCount unchanged for a whitespace-only edit", async () => {
  // The added whitespace must land strictly BETWEEN tags (a purely-whitespace
  // text node, dropped entirely by normalizeHtml) rather than directly
  // adjacent to real text content within the same element - html-normalize.js
  // deliberately preserves leading/trailing whitespace on a text node that
  // has real content, since that can be adjacency-significant next to inline
  // siblings, so whitespace touching "content" itself would be a real change.
  const filePath = join(fixtureDir, "report.html");
  writeFileSync(filePath, "<html><head></head><body><p>content</p></body></html>");
  const { family } = await trackPath(filePath);

  writeFileSync(
    filePath,
    "<html>\n  <head></head>\n  <body>\n    <p>content</p>\n  </body>\n</html>\n",
  );
  const results = await reconcile();

  assert.equal(results[0].status, "unchanged");
  assert.equal(Object.keys(getFamily(family.id).versions).length, 1);
});

test("reconcile reports a genuinely unchanged file as unchanged", async () => {
  const filePath = join(fixtureDir, "report.html");
  writeFileSync(filePath, "<html><body>same</body></html>");
  await trackPath(filePath);

  const results = await reconcile();
  assert.equal(results[0].status, "unchanged");
});

test("reconcile reports a deleted tracked file as missing", async () => {
  const filePath = join(fixtureDir, "report.html");
  writeFileSync(filePath, "<html><body>v1</body></html>");
  await trackPath(filePath);
  rmSync(filePath);

  const results = await reconcile();
  assert.equal(results[0].status, "missing");
});

test("reconcile marks a live file behind a remotely-arrived head as behind-head, never rewriting lineage", async () => {
  // Simulates the real cross-machine bug this exact logic was built to fix:
  // a remote pull can advance a family's head without touching this
  // machine's own live file, which is then behind, not newly edited.
  const filePath = join(fixtureDir, "report.html");
  writeFileSync(filePath, "<html><body>original</body></html>");
  const { family } = await trackPath(filePath);
  const originalHead = family.headVersion;

  // A version arriving "from another machine" - the local file never changes.
  const { family: advanced } = await recordVersionIfChanged(family.id, Buffer.from("<html><body>from another machine</body></html>"));
  assert.notEqual(advanced.headVersion, originalHead);

  const results = await reconcile();

  assert.equal(results[0].status, "behind-head");
  const after = getFamily(family.id);
  assert.equal(after.headVersion, advanced.headVersion, "head must not be rewritten backwards");
  assert.equal(Object.keys(after.versions).length, 2, "no spurious new version written");
});
