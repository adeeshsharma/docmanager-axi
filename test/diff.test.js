import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useIsolatedHome, cleanupHome } from "./helpers.js";
import { createFamily, recordVersionIfChanged } from "../src/core/store.js";
import { diffVersions } from "../src/core/diff.js";

let homeDir;
beforeEach(() => {
  homeDir = useIsolatedHome();
});
afterEach(() => {
  cleanupHome(homeDir);
});

test("diffVersions reports a real, human-visible difference between two genuinely different versions", async () => {
  const family = await createFamily({
    syntheticPath: "/report",
    content: Buffer.from("<html><body><p>original numbers</p></body></html>"),
  });
  const { family: advanced } = await recordVersionIfChanged(
    family.id,
    Buffer.from("<html><body><p>updated numbers</p></body></html>"),
  );

  const result = diffVersions(family.id, family.headVersion, advanced.headVersion);

  assert.equal(result.from, family.headVersion);
  assert.equal(result.to, advanced.headVersion);
  const removed = result.parts.filter((p) => p.removed).map((p) => p.value).join("");
  const added = result.parts.filter((p) => p.added).map((p) => p.value).join("");
  assert.match(removed, /original numbers/);
  assert.match(added, /updated numbers/);
});

test("diffVersions between the same hash twice has no added or removed parts", async () => {
  const family = await createFamily({ syntheticPath: "/report", content: Buffer.from("<html><body>same</body></html>") });
  const result = diffVersions(family.id, family.headVersion, family.headVersion);
  assert.equal(result.parts.every((p) => !p.added && !p.removed), true);
});

// Directly verifies ARCHITECTURE.md section 3.4's claim ("the diff shown to
// the user is computed on the normalized form, not the raw bytes"): two
// distinct stored versions whose RAW bytes differ (so they're legitimately
// two separate version entries) but whose NORMALIZED form is identical
// (whitespace/attribute-order only) must diff as having no real changes.
test("diffVersions on the normalized form treats two whitespace-only-different versions as having no real changes", async () => {
  const family = await createFamily({
    syntheticPath: "/report",
    content: Buffer.from("<html><head></head><body><p>content</p></body></html>"),
  });
  const { family: advanced, changed } = await recordVersionIfChanged(
    family.id,
    Buffer.from("<html>\n  <head></head>\n  <body>\n    <p>content</p>\n  </body>\n</html>\n"),
  );
  assert.equal(changed, true, "raw bytes differ, so store.js correctly records this as a distinct version");

  const result = diffVersions(family.id, family.headVersion, advanced.headVersion);
  assert.equal(result.parts.every((p) => !p.added && !p.removed), true);
});

test("diffVersions errors with VERSION_NOT_FOUND for an unknown hash on either side", async () => {
  const family = await createFamily({ syntheticPath: "/report", content: Buffer.from("v1") });
  const bogus = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  assert.throws(() => diffVersions(family.id, bogus, family.headVersion), (err) => err.code === "VERSION_NOT_FOUND");
  assert.throws(() => diffVersions(family.id, family.headVersion, bogus), (err) => err.code === "VERSION_NOT_FOUND");
});

test("diffVersions errors with FAMILY_NOT_FOUND for an unknown family", () => {
  assert.throws(() => diffVersions("nonexistent-id", "a", "b"), (err) => err.code === "FAMILY_NOT_FOUND");
});
