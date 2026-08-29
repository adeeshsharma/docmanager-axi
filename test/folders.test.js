import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useIsolatedHome, cleanupHome } from "./helpers.js";
import { createFolder, getFolder, listFolders, renameFolder } from "../src/core/folders.js";

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
