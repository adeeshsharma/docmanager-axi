import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useIsolatedHome, cleanupHome } from "./helpers.js";
import { createFolder, getFolder, listFolders, renameFolder, deleteFolder, reparentFolder } from "../src/core/folders.js";
import { createFamily, moveFamilyToFolder } from "../src/core/store.js";
import { rebuildIndex, listFamiliesFromIndex, getFamilyFromIndex } from "../src/core/index.js";

let homeDir;
beforeEach(() => {
  homeDir = useIsolatedHome();
});
afterEach(() => {
  cleanupHome(homeDir);
});

test("createFolder creates a root folder with no parent", async () => {
  const folder = await createFolder({ name: "Reports" });
  assert.equal(folder.name, "Reports");
  assert.equal(folder.parentId, null);
  assert.ok(folder.id);
  assert.ok(folder.createdAt);
});

test("getFolder returns null for an unknown id", () => {
  assert.equal(getFolder("does-not-exist"), null);
});

test("createFolder can nest under an existing folder", async () => {
  const parent = await createFolder({ name: "Reports" });
  const child = await createFolder({ name: "Q3", parentId: parent.id });
  assert.equal(child.parentId, parent.id);
});

test("createFolder rejects a nonexistent parentId", async () => {
  await assert.rejects(createFolder({ name: "Q3", parentId: "does-not-exist" }), (err) => err.code === "FOLDER_NOT_FOUND");
});

test("listFolders returns every created folder", async () => {
  await createFolder({ name: "A" });
  await createFolder({ name: "B" });
  const folders = listFolders();
  assert.equal(folders.length, 2);
  assert.deepEqual(folders.map((f) => f.name).sort(), ["A", "B"]);
});

test("two folders can share the same name - identity is the id, not the name", async () => {
  const a = await createFolder({ name: "Drafts" });
  const b = await createFolder({ name: "Drafts" });
  assert.notEqual(a.id, b.id);
  assert.equal(listFolders().length, 2);
});

test("reparentFolder moves a folder under a new parent", async () => {
  const a = await createFolder({ name: "A" });
  const b = await createFolder({ name: "B" });
  const { changed, folder } = await reparentFolder(b.id, a.id);
  assert.equal(changed, true);
  assert.equal(folder.parentId, a.id);
});

test("reparentFolder to the same parent is a no-op", async () => {
  const a = await createFolder({ name: "A" });
  const b = await createFolder({ name: "B", parentId: a.id });
  const { changed } = await reparentFolder(b.id, a.id);
  assert.equal(changed, false);
});

test("reparentFolder rejects making a folder its own parent", async () => {
  const a = await createFolder({ name: "A" });
  await assert.rejects(reparentFolder(a.id, a.id), (err) => err.code === "FOLDER_CYCLE");
});

test("reparentFolder rejects moving a folder under its own descendant", async () => {
  const a = await createFolder({ name: "A" });
  const b = await createFolder({ name: "B", parentId: a.id });
  const c = await createFolder({ name: "C", parentId: b.id });
  await assert.rejects(reparentFolder(a.id, c.id), (err) => err.code === "FOLDER_CYCLE");
});

test("reparentFolder to root (null) works", async () => {
  const a = await createFolder({ name: "A" });
  const b = await createFolder({ name: "B", parentId: a.id });
  const { changed, folder } = await reparentFolder(b.id, null);
  assert.equal(changed, true);
  assert.equal(folder.parentId, null);
});

test("deleteFolder removes an empty folder", async () => {
  const a = await createFolder({ name: "A" });
  await deleteFolder(a.id);
  assert.equal(getFolder(a.id), null);
});

test("deleteFolder refuses a folder with a child folder inside", async () => {
  const a = await createFolder({ name: "A" });
  await createFolder({ name: "B", parentId: a.id });
  await assert.rejects(deleteFolder(a.id), (err) => err.code === "FOLDER_NOT_EMPTY");
});

test("deleteFolder refuses a folder with a family inside", async () => {
  const a = await createFolder({ name: "A" });
  const family = await createFamily({ syntheticPath: "/report", content: Buffer.from("v1") });
  await moveFamilyToFolder(family.id, a.id);
  await assert.rejects(deleteFolder(a.id), (err) => err.code === "FOLDER_NOT_EMPTY");
});

test("deleteFolder rejects an unknown id", async () => {
  await assert.rejects(deleteFolder("does-not-exist"), (err) => err.code === "FOLDER_NOT_FOUND");
});

test("folderId defaults to null and survives the index round-trip", async () => {
  const family = await createFamily({ syntheticPath: "/report", content: Buffer.from("v1") });
  rebuildIndex();
  assert.equal(getFamilyFromIndex(family.id).folderId, null);
  assert.equal(listFamiliesFromIndex().find((f) => f.id === family.id).folderId, null);
});

test("a moved family's folderId survives the index round-trip", async () => {
  const folder = await createFolder({ name: "Reports" });
  const family = await createFamily({ syntheticPath: "/report", content: Buffer.from("v1") });
  await moveFamilyToFolder(family.id, folder.id);
  rebuildIndex();
  assert.equal(getFamilyFromIndex(family.id).folderId, folder.id);
  assert.equal(listFamiliesFromIndex().find((f) => f.id === family.id).folderId, folder.id);
});
