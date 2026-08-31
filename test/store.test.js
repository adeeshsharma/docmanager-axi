import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { useIsolatedHome, cleanupHome } from "./helpers.js";
import {
  initStore,
  storePath,
  createFamily,
  getFamily,
  recordVersionIfChanged,
  mergeFamilies,
  deleteFamily,
  listFamilyIds,
  readContent,
  findFamilyByVersionHash,
} from "../src/core/store.js";
import { runGit } from "../src/core/git.js";
import { rebuildIndex, listFamiliesFromIndex, getFamilyFromIndex } from "../src/core/index.js";

let homeDir;
beforeEach(() => {
  homeDir = useIsolatedHome();
});
afterEach(() => {
  cleanupHome(homeDir);
});

test("initStore creates a real git repo with an initial commit", async () => {
  await initStore();
  assert.ok(existsSync(storePath()));
  assert.ok(existsSync(join(storePath(), ".gitattributes")));
  const log = await runGit(storePath(), ["log", "--oneline"]);
  assert.match(log, /Initialize store/);
});

test("createFamily writes content and family metadata, commits", async () => {
  const family = await createFamily({
    syntheticPath: "/report",
    content: Buffer.from("<html><body>v1</body></html>"),
    sourceFileName: "report.html",
  });
  assert.equal(family.syntheticPath, "/report");
  assert.equal(Object.keys(family.versions).length, 1);
  assert.equal(getFamily(family.id).id, family.id);
  const log = await runGit(storePath(), ["log", "--oneline"]);
  assert.match(log, /Track \/report/);
});

test("createFamily rejects a second family at the same synthetic path", async () => {
  await createFamily({ syntheticPath: "/report", content: Buffer.from("a") });
  await assert.rejects(
    createFamily({ syntheticPath: "/report", content: Buffer.from("b") }),
    (err) => err.code === "FAMILY_PATH_EXISTS",
  );
});

test("recordVersionIfChanged is a real no-op for unchanged content", async () => {
  const family = await createFamily({ syntheticPath: "/report", content: Buffer.from("v1") });
  const { changed } = await recordVersionIfChanged(family.id, Buffer.from("v1"));
  assert.equal(changed, false);
  assert.equal(Object.keys(getFamily(family.id).versions).length, 1);
});

test("recordVersionIfChanged captures a new version and advances head, linked by supersedes", async () => {
  const family = await createFamily({ syntheticPath: "/report", content: Buffer.from("v1") });
  const originalHead = family.headVersion;
  const { changed, family: updated } = await recordVersionIfChanged(family.id, Buffer.from("v2"));
  assert.equal(changed, true);
  assert.equal(Object.keys(updated.versions).length, 2);
  assert.notEqual(updated.headVersion, originalHead);
  assert.equal(updated.versions[updated.headVersion].supersedes, originalHead);
});

test("content is deduplicated by hash across different families", async () => {
  const content = Buffer.from("<html>identical</html>");
  const a = await createFamily({ syntheticPath: "/a", content });
  const b = await createFamily({ syntheticPath: "/b", content });
  assert.equal(a.headVersion, b.headVersion);
  assert.deepEqual(readContent(a.headVersion), content);
});

test("mergeFamilies splices the older family's history in as ancestry and removes the older record", async () => {
  const older = await createFamily({ syntheticPath: "/draft", content: Buffer.from("draft v1") });
  const { family: olderV2 } = await recordVersionIfChanged(older.id, Buffer.from("draft v2"));
  const newer = await createFamily({ syntheticPath: "/report", content: Buffer.from("report v1") });

  const merged = await mergeFamilies(older.id, newer.id);

  assert.equal(getFamily(older.id), null);
  assert.equal(Object.keys(merged.versions).length, 3);
  const newerRootHash = Object.entries(merged.versions).find(([hash]) => hash === newer.headVersion)[0];
  assert.equal(merged.versions[newerRootHash].supersedes, olderV2.headVersion);
});

test("mergeFamilies rejects linking a family to itself", async () => {
  const family = await createFamily({ syntheticPath: "/report", content: Buffer.from("v1") });
  await assert.rejects(mergeFamilies(family.id, family.id), (err) => err.code === "SAME_FAMILY");
});

test("deleteFamily removes the family record; re-deleting the same id errors", async () => {
  const family = await createFamily({ syntheticPath: "/report", content: Buffer.from("v1") });
  const deleted = await deleteFamily(family.id);
  assert.equal(deleted.syntheticPath, "/report");
  assert.equal(getFamily(family.id), null);
  await assert.rejects(deleteFamily(family.id), (err) => err.code === "FAMILY_NOT_FOUND");
});

test("concurrent createFamily calls serialize correctly with no corruption", async () => {
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      createFamily({ syntheticPath: `/doc-${i}`, content: Buffer.from(`content ${i}`) }),
    ),
  );
  assert.equal(new Set(results.map((f) => f.id)).size, 5);
  assert.equal(listFamilyIds().length, 5);
  const log = await runGit(storePath(), ["log", "--oneline"]);
  assert.equal(log.trim().split("\n").length, 6); // 5 tracks + the init commit
});

test("index rebuild matches on-disk family/version data, current flag correct", async () => {
  const family = await createFamily({ syntheticPath: "/report", content: Buffer.from("v1") });
  await recordVersionIfChanged(family.id, Buffer.from("v2"));

  rebuildIndex();

  const indexed = listFamiliesFromIndex();
  assert.equal(indexed.length, 1);
  assert.equal(indexed[0].versionCount, 2);

  const full = getFamilyFromIndex(family.id);
  assert.equal(full.versions.length, 2);
  const current = full.versions.find((v) => v.current);
  assert.equal(current.hash, full.headVersion);
  assert.equal(full.versions.filter((v) => v.current).length, 1);
});

test("findFamilyByVersionHash finds the family owning a given version hash", async () => {
  const family = await createFamily({ syntheticPath: "/report", content: Buffer.from("v1") });
  const v1 = family.headVersion;
  const { family: f2 } = await recordVersionIfChanged(family.id, Buffer.from("v2"));
  const v2 = f2.headVersion;

  assert.equal(findFamilyByVersionHash(v1).id, family.id);
  assert.equal(findFamilyByVersionHash(v2).id, family.id);
});

test("findFamilyByVersionHash returns null for an unknown hash", async () => {
  await createFamily({ syntheticPath: "/report", content: Buffer.from("v1") });
  assert.equal(findFamilyByVersionHash("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"), null);
});
