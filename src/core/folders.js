import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { storePath, withStoreLock, ensureStoreReadyUnlocked, commitAll, listFamilyIds, getFamily } from "./store.js";

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

// A cycle would exist if newParentId is the folder itself, or any of its
// own descendants - walk up from newParentId toward the root; hitting `id`
// along the way means moving there would make `id` its own ancestor.
function wouldCreateCycle(id, newParentId) {
  if (!newParentId) return false;
  if (newParentId === id) return true;
  let current = getFolder(newParentId);
  while (current) {
    if (current.id === id) return true;
    if (!current.parentId) return false;
    current = getFolder(current.parentId);
  }
  return false;
}

export async function reparentFolder(id, newParentId = null) {
  return withStoreLock(async () => {
    const folder = getFolder(id);
    if (!folder) {
      const err = new Error(`No folder with id "${id}"`);
      err.code = "FOLDER_NOT_FOUND";
      throw err;
    }
    if (newParentId && !getFolder(newParentId)) {
      const err = new Error(`No folder with id "${newParentId}"`);
      err.code = "FOLDER_NOT_FOUND";
      throw err;
    }
    if ((folder.parentId ?? null) === (newParentId ?? null)) {
      return { changed: false, folder };
    }
    if (wouldCreateCycle(id, newParentId)) {
      const err = new Error(`Cannot move folder "${folder.name}" under one of its own descendants`);
      err.code = "FOLDER_CYCLE";
      throw err;
    }
    const updated = { ...folder, parentId: newParentId };
    writeFolderUnlocked(updated);
    await commitAll(`Move folder ${folder.name}`);
    return { changed: true, folder: updated };
  });
}

/**
 * Deletes a folder - refuses unless it's genuinely empty (no child folder,
 * no family pointing at it). Never cascades: moving contents out is always
 * a separate, explicit step the caller takes first.
 */
export async function deleteFolder(id) {
  return withStoreLock(async () => {
    const folder = getFolder(id);
    if (!folder) {
      const err = new Error(`No folder with id "${id}"`);
      err.code = "FOLDER_NOT_FOUND";
      throw err;
    }
    const hasChildFolder = listFolders().some((f) => f.parentId === id);
    const hasFamilyInside = listFamilyIds().some((famId) => {
      let family;
      try {
        family = getFamily(famId);
      } catch {
        return false;
      }
      return family?.folderId === id;
    });
    if (hasChildFolder || hasFamilyInside) {
      const err = new Error(`Folder "${folder.name}" is not empty - move its contents out first`);
      err.code = "FOLDER_NOT_EMPTY";
      throw err;
    }
    unlinkSync(folderFilePath(id));
    await commitAll(`Delete folder ${folder.name}`);
    return folder;
  });
}
