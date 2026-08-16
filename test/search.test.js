import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { useIsolatedHome, cleanupHome } from "./helpers.js";
import { createFamily, storePath } from "../src/core/store.js";
import { rebuildIndex, searchFamilies } from "../src/core/index.js";

let homeDir;
beforeEach(() => {
  homeDir = useIsolatedHome();
});
afterEach(() => {
  cleanupHome(homeDir);
});

async function track(syntheticPath, title, bodyText) {
  return createFamily({
    syntheticPath,
    content: Buffer.from(`<html><head><title>${title}</title></head><body><p>${bodyText}</p></body></html>`),
  });
}

test("search matches on body text and returns a highlighted snippet", async () => {
  await track("/q3", "Q3 Financial Report", "Revenue grew significantly this quarter across all regions.");
  rebuildIndex();

  const results = searchFamilies("quarter");
  assert.equal(results.length, 1);
  assert.equal(results[0].syntheticPath, "/q3");
  assert.match(results[0].snippet, /\*\*quarter\*\*/);
});

test("search matches on the document's own extracted title, not just body text", async () => {
  await track("/report-a", "Annual Sustainability Report", "Nothing about the matched word in here.");
  rebuildIndex();

  const results = searchFamilies("sustainability");
  assert.equal(results.length, 1);
  assert.equal(results[0].docTitle, "Annual Sustainability Report");
});

test("search matches on the synthetic path itself", async () => {
  await track("/reports/quarterly/q3", "Untitled", "no matching words in the body");
  rebuildIndex();

  const results = searchFamilies("quarterly");
  assert.equal(results.length, 1);
  assert.equal(results[0].syntheticPath, "/reports/quarterly/q3");
});

test("multi-word queries require every term to match (implicit AND)", async () => {
  await track("/both", "Doc", "roadmap and staffing plans for next sprint");
  await track("/onlyone", "Doc", "roadmap for the year, no mention of the other word");
  rebuildIndex();

  const results = searchFamilies("roadmap staffing");
  assert.equal(results.length, 1);
  assert.equal(results[0].syntheticPath, "/both");
});

test("a genuinely unmatched query returns an empty array, not an error", async () => {
  await track("/a", "Doc", "some content");
  rebuildIndex();
  assert.deepEqual(searchFamilies("zzznotfoundanywhere"), []);
});

test("an empty or whitespace-only query returns an empty array without querying the index", async () => {
  await track("/a", "Doc", "some content");
  rebuildIndex();
  assert.deepEqual(searchFamilies(""), []);
  assert.deepEqual(searchFamilies("   "), []);
});

test("a family whose content blob is missing is still searchable by its synthetic path", async () => {
  const family = await track("/orphan-content", "Doc", "irrelevant");
  unlinkSync(join(storePath(), "content", `${family.headVersion}.html`));
  rebuildIndex();

  const results = searchFamilies("orphan");
  assert.equal(results.length, 1);
  assert.equal(results[0].syntheticPath, "/orphan-content");
});

test("a corrupt family JSON file never breaks search for every other healthy family", async () => {
  await track("/healthy", "Findable Document", "this one should still be searchable");
  writeFileSync(join(storePath(), "families", "deadbeef.json"), "{not valid json");
  rebuildIndex();

  assert.doesNotThrow(() => searchFamilies("findable"));
  const results = searchFamilies("findable");
  assert.equal(results.length, 1);
  assert.equal(results[0].syntheticPath, "/healthy");
});
