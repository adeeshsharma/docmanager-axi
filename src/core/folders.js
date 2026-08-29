import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { storePath, withStoreLock, ensureStoreReadyUnlocked, commitAll } from "./store.js";

function foldersDir() {
  return join(storePath(), "folders");
}

function folderFilePath(id) {
  return join(foldersDir(), `${id}.json`);
}

function writeFolderUnlocked(folder) {
  mkdirSync(foldersDir(), { recursive: true });
  writeFileSync(folderFilePath(folder.id), JSON.stringify(folder, null, 2));
}

export function listFolderIds() {
  if (!existsSync(foldersDir())) return [];
  return readdirSync(foldersDir())
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length));
}

export function getFolder(id) {
  const filePath = folderFilePath(id);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/**
 * All folders, flat (the caller builds the parent/child tree from
 * `parentId` - no SQLite indexing for folders in this slice, folder counts
 * are expected to stay small enough that a direct JSON-directory read is
 * simple and fast enough, the same boundary `store.js`'s own
 * `listFamilyIds()`/`getFamily()` already draw).
 */
export function listFolders() {
  return listFolderIds()
    .map((id) => getFolder(id))
    .filter((f) => f !== null);
}

/**
 * Creates a folder. No path-uniqueness constraint like families have - a
 * folder's identity is its id, not its name, so two folders (even under the
 * same parent) may share a name.
 */
export async function createFolder({ name, parentId = null }) {
  return withStoreLock(async () => {
    await ensureStoreReadyUnlocked();
    if (parentId && !getFolder(parentId)) {
      const err = new Error(`No folder with id "${parentId}"`);
      err.code = "FOLDER_NOT_FOUND";
      throw err;
    }
    const folder = {
      id: randomUUID(),
      name,
      parentId,
      createdAt: new Date().toISOString(),
    };
    writeFolderUnlocked(folder);
    await commitAll(`Create folder ${name}`);
    return folder;
  });
}

export async function renameFolder(id, newName) {
  return withStoreLock(async () => {
    const folder = getFolder(id);
    if (!folder) {
      const err = new Error(`No folder with id "${id}"`);
      err.code = "FOLDER_NOT_FOUND";
      throw err;
    }
    if (folder.name === newName) {
      return { changed: false, folder };
    }
    const updated = { ...folder, name: newName };
    writeFolderUnlocked(updated);
    await commitAll(`Rename folder ${folder.name} -> ${newName}`);
    return { changed: true, folder: updated };
  });
}
