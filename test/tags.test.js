import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useIsolatedHome, cleanupHome } from "./helpers.js";
import { createFamily, setFamilyTags, getFamily } from "../src/core/store.js";
import { rebuildIndex, listFamiliesFromIndex, getFamilyFromIndex, searchFamilies } from "../src/core/index.js";

let homeDir;
beforeEach(() => {
  homeDir = useIsolatedHome();
});
afterEach(() => {
  cleanupHome(homeDir);
});

test("a new family starts with no tags", async () => {
  const family = await createFamily({ syntheticPath: "/report", content: Buffer.from("v1") });
  assert.deepEqual(family.tags, []);
});

test("setFamilyTags replaces the whole array, trims, dedupes, drops empties", async () => {
  const family = await createFamily({ syntheticPath: "/report", content: Buffer.from("v1") });
  const updated = await setFamilyTags(family.id, [" draft ", "q3", "draft", "", "  "]);
  assert.deepEqual(updated.tags, ["draft", "q3"]);
  assert.deepEqual(getFamily(family.id).tags, ["draft", "q3"]);
});

test("setFamilyTags can clear all tags", async () => {
  const family = await createFamily({ syntheticPath: "/report", content: Buffer.from("v1") });
  await setFamilyTags(family.id, ["draft"]);
  const cleared = await setFamilyTags(family.id, []);
  assert.deepEqual(cleared.tags, []);
});

test("setFamilyTags errors on an unknown family id", async () => {
  await assert.rejects(setFamilyTags("does-not-exist", ["x"]), (err) => err.code === "FAMILY_NOT_FOUND");
});

test("tags survive the index round-trip in listFamiliesFromIndex and getFamilyFromIndex", async () => {
  const family = await createFamily({ syntheticPath: "/report", content: Buffer.from("v1") });
  await setFamilyTags(family.id, ["draft", "internal"]);
  rebuildIndex();

  const listed = listFamiliesFromIndex().find((f) => f.id === family.id);
  assert.deepEqual(listed.tags, ["draft", "internal"]);

  const fetched = getFamilyFromIndex(family.id);
  assert.deepEqual(fetched.tags, ["draft", "internal"]);
});

test("a family with no tags round-trips to an empty array, not null/undefined", async () => {
  const family = await createFamily({ syntheticPath: "/report", content: Buffer.from("v1") });
  rebuildIndex();
  assert.deepEqual(getFamilyFromIndex(family.id).tags, []);
  assert.deepEqual(listFamiliesFromIndex().find((f) => f.id === family.id).tags, []);
});

test("search finds a document by its tag, not just by title/path/body", async () => {
  const family = await createFamily({
    syntheticPath: "/unrelated-name",
    title: "Something else entirely",
    content: Buffer.from("<html><body>nothing relevant here</body></html>"),
  });
  await setFamilyTags(family.id, ["quarterly-planning"]);
  rebuildIndex();

  const results = searchFamilies("quarterly-planning");
  assert.equal(results.length, 1);
  assert.equal(results[0].id, family.id);
});
