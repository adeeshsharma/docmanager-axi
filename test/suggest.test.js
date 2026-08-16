import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { useIsolatedHome, cleanupHome } from "./helpers.js";
import { createFamily } from "../src/core/store.js";
import { suggestLinks } from "../src/core/suggest.js";
import { docmanagerHome } from "../src/core/paths.js";

let homeDir;
beforeEach(() => {
  homeDir = useIsolatedHome();
});
afterEach(() => {
  cleanupHome(homeDir);
});

test("suggests a link when two separate families share a normalized title, even with different structure", async () => {
  await createFamily({
    syntheticPath: "/report",
    content: Buffer.from("<html><head><title>Q3 Report</title></head><body><p>numbers</p></body></html>"),
  });
  await createFamily({
    syntheticPath: "/report-final",
    // Deliberately a different tag shape (a table instead of a paragraph) so
    // this isolates the title signal - a structural match would pass too,
    // but this test should hold even without one.
    content: Buffer.from(
      "<html><head><title>Q3 Report (final)</title></head><body><table><tr><td>1</td></tr></table></body></html>",
    ),
  });

  const suggestions = suggestLinks();
  assert.equal(suggestions.length, 1);
  assert.deepEqual(suggestions[0].reasons, ["title-match"]);
});

test("suggests a link when two separate families share an identical tag structure", async () => {
  await createFamily({
    syntheticPath: "/a",
    content: Buffer.from("<html><head><title>Alpha</title></head><body><h1>x</h1><p>one</p></body></html>"),
  });
  await createFamily({
    syntheticPath: "/b",
    content: Buffer.from("<html><head><title>Beta</title></head><body><h1>x</h1><p>two</p></body></html>"),
  });

  const suggestions = suggestLinks();
  assert.equal(suggestions.length, 1);
  assert.ok(suggestions[0].reasons.includes("structural-match"));
});

test("never suggests unrelated families", async () => {
  await createFamily({
    syntheticPath: "/report",
    content: Buffer.from("<html><head><title>Q3 Report</title></head><body><h1>x</h1><table><tr><td>1</td></tr></table></body></html>"),
  });
  await createFamily({
    syntheticPath: "/memo",
    content: Buffer.from("<html><head><title>Totally unrelated memo</title></head><body><p>nothing to do with the report</p></body></html>"),
  });

  assert.deepEqual(suggestLinks(), []);
});

test("never links automatically - only ever returns suggestions", async () => {
  const a = await createFamily({
    syntheticPath: "/a",
    content: Buffer.from("<html><head><title>Same Title</title></head><body>1</body></html>"),
  });
  const b = await createFamily({
    syntheticPath: "/b",
    content: Buffer.from("<html><head><title>Same Title</title></head><body>2</body></html>"),
  });

  suggestLinks();
  // Both families must still independently exist - suggestLinks() is
  // read-only, never a substitute for an explicit `link` call.
  const { getFamily } = await import("../src/core/store.js");
  assert.ok(getFamily(a.id));
  assert.ok(getFamily(b.id));
});

test("a corrupt family record never breaks suggestions for every other family", async () => {
  await createFamily({
    syntheticPath: "/a",
    content: Buffer.from("<html><head><title>Alpha</title></head><body>1</body></html>"),
  });
  await createFamily({
    syntheticPath: "/b",
    content: Buffer.from("<html><head><title>Alpha</title></head><body>2</body></html>"),
  });

  writeFileSync(join(docmanagerHome(), "store", "families", "deadbeef.json"), "{not valid json");

  assert.doesNotThrow(() => suggestLinks());
  const suggestions = suggestLinks();
  assert.equal(suggestions.length, 1);
  assert.ok(suggestions[0].reasons.includes("title-match"));
});
