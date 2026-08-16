import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { docmanagerHome } from "./paths.js";
import { runGit } from "./git.js";

export function storePath() {
  return join(docmanagerHome(), "store");
}

function contentDir() {
  return join(storePath(), "content");
}

function familiesDir() {
  return join(storePath(), "families");
}

function hashContent(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// Every mutating store operation (including git commands) is chained through
// this single-writer queue, so two API calls in flight never interleave git
// commands against the same working tree. Public functions call this exactly
// once each, at the top level - never nest a serialize() call inside another,
// since the inner call would wait on a queue tail that itself waits on the
// outer call, deadlocking.
let writeQueue = Promise.resolve();
function serialize(fn) {
  const result = writeQueue.then(fn, fn);
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// Exposed so other modules that also need to run git commands against the
// store (snapshot.js's push/pull) go through the SAME queue, not a separate
// one - otherwise a track/link could still interleave with a pull's merge.
export function withStoreLock(fn) {
  return serialize(fn);
}

async function commitAll(message) {
  await runGit(storePath(), ["add", "-A"]);
  await runGit(storePath(), [
    "-c",
    "user.email=docmanager@local",
    "-c",
    "user.name=docmanager",
    "commit",
    "-m",
    message,
    "--allow-empty",
  ]);
}

// Not wrapped in serialize() itself - callers that need "the store exists"
// as a precondition call this directly from inside their own serialize()
// callback. Actually initializes the git repo, not just the directories -
// every mutating operation needs a real repo to commit into, not only the
// explicit initStore() call.
async function ensureStoreReadyUnlocked() {
  if (existsSync(storePath())) return;
  mkdirSync(contentDir(), { recursive: true });
  mkdirSync(familiesDir(), { recursive: true });
  writeFileSync(join(storePath(), ".gitattributes"), "* -text\n");
  // Pin the branch name explicitly - two machines' git installs can have
  // different init.defaultBranch config, and cross-machine sync (phase 5)
  // needs both ends pushing/pulling the same branch name.
  await runGit(storePath(), ["init", "-b", "main"]);
  await commitAll("Initialize store");
}

export async function initStore() {
  return serialize(ensureStoreReadyUnlocked);
}

export function listFamilyIds() {
  if (!existsSync(familiesDir())) return [];
  return readdirSync(familiesDir())
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length));
}

export function getFamily(familyId) {
  const filePath = join(familiesDir(), `${familyId}.json`);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function findFamilyBySyntheticPath(syntheticPath) {
  for (const id of listFamilyIds()) {
    const family = getFamily(id);
    if (family && family.syntheticPath === syntheticPath) return family;
  }
  return null;
}

export function readContent(hash) {
  const filePath = join(contentDir(), `${hash}.html`);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath);
}

function writeContentUnlocked(buffer) {
  const hash = hashContent(buffer);
  const filePath = join(contentDir(), `${hash}.html`);
  if (!existsSync(filePath)) {
    writeFileSync(filePath, buffer);
  }
  return hash;
}

function writeFamilyUnlocked(family) {
  writeFileSync(join(familiesDir(), `${family.id}.json`), JSON.stringify(family, null, 2));
}

/**
 * Creates a new document family and its first version. Throws if a family
 * already exists at this synthetic path - path uniqueness is a storage-layer
 * invariant, not just a CLI-level check, since it's the family's stable
 * logical identity.
 */
export async function createFamily({ syntheticPath, title, content, sourceFileName }) {
  return serialize(async () => {
    await ensureStoreReadyUnlocked();
    if (findFamilyBySyntheticPath(syntheticPath)) {
      const err = new Error(`A family already exists at synthetic path "${syntheticPath}"`);
      err.code = "FAMILY_PATH_EXISTS";
      throw err;
    }

    const hash = writeContentUnlocked(content);
    const now = new Date().toISOString();
    const family = {
      id: randomUUID(),
      syntheticPath,
      title: title ?? syntheticPath,
      createdAt: now,
      headVersion: hash,
      tags: [],
      versions: {
        [hash]: { createdAt: now, sourceFileName: sourceFileName ?? null, supersedes: null },
      },
    };
    writeFamilyUnlocked(family);
    await commitAll(`Track ${syntheticPath}`);
    return family;
  });
}

/**
 * Records a new version of an existing family if the content actually
 * changed since the head version. No-ops (does not error, does not commit)
 * if the content hash is unchanged - this is the automatic, no-confirmation
 * capture path for an already-tracked synthetic path (see systemPatterns.md
 * - this is a different mechanism from suggesting a link between two
 * previously unrelated files, which never happens in this function).
 */
export async function recordVersionIfChanged(familyId, content, sourceFileName) {
  return serialize(async () => {
    const family = getFamily(familyId);
    if (!family) {
      const err = new Error(`No family with id "${familyId}"`);
      err.code = "FAMILY_NOT_FOUND";
      throw err;
    }

    const hash = writeContentUnlocked(content);
    if (hash === family.headVersion) {
      return { changed: false, family };
    }

    const now = new Date().toISOString();
    family.versions[hash] = {
      createdAt: now,
      sourceFileName: sourceFileName ?? null,
      supersedes: family.headVersion,
    };
    family.headVersion = hash;
    writeFamilyUnlocked(family);
    await commitAll(`New version of ${family.syntheticPath}`);
    return { changed: true, family };
  });
}

/**
 * Declares that `newerFamilyId` supersedes `olderFamilyId`: splices the
 * older family's entire version chain in as ancestry of the newer family's
 * earliest version, under the newer family's own identity, then removes the
 * older family record (its content blobs stay referenced, nothing is lost).
 * This is the explicit, user/agent-declared "these are the same document"
 * link - never inferred automatically. See systemPatterns.md.
 */
export async function mergeFamilies(olderFamilyId, newerFamilyId) {
  return serialize(async () => {
    if (olderFamilyId === newerFamilyId) {
      const err = new Error("Cannot link a family to itself");
      err.code = "SAME_FAMILY";
      throw err;
    }

    const older = getFamily(olderFamilyId);
    if (!older) {
      const err = new Error(`No family with id "${olderFamilyId}"`);
      err.code = "FAMILY_NOT_FOUND";
      throw err;
    }
    const newer = getFamily(newerFamilyId);
    if (!newer) {
      const err = new Error(`No family with id "${newerFamilyId}"`);
      err.code = "FAMILY_NOT_FOUND";
      throw err;
    }

    const newerRootHash = Object.entries(newer.versions).find(
      ([, v]) => v.supersedes === null,
    )?.[0];
    if (!newerRootHash) {
      const err = new Error(`Family "${newerFamilyId}" has no root version to splice onto`);
      err.code = "NO_ROOT_VERSION";
      throw err;
    }

    for (const [hash, version] of Object.entries(older.versions)) {
      if (!newer.versions[hash]) {
        newer.versions[hash] = version;
      }
    }
    newer.versions[newerRootHash] = {
      ...newer.versions[newerRootHash],
      supersedes: older.headVersion,
    };

    writeFamilyUnlocked(newer);
    unlinkSync(join(familiesDir(), `${older.id}.json`));
    await commitAll(`Link ${older.syntheticPath} -> ${newer.syntheticPath}`);
    return newer;
  });
}

/**
 * Moves a family's headVersion back to an EXISTING version's hash. This is
 * not "a new version with old content" - content is hash-addressed, so old
 * content can never produce a new, distinct entry; naively writing one would
 * collide with and overwrite the original entry's own createdAt/supersedes,
 * corrupting lineage the same way the phase-5 reconciliation bug once did.
 * No version is added or removed here, only which one headVersion points at
 * - the full history stays intact and visible, exactly like moving a git
 * branch pointer to an earlier commit without deleting anything after it.
 */
export async function revertToVersion(familyId, hash) {
  return serialize(async () => {
    const family = getFamily(familyId);
    if (!family) {
      const err = new Error(`No family with id "${familyId}"`);
      err.code = "FAMILY_NOT_FOUND";
      throw err;
    }
    if (!family.versions[hash]) {
      const err = new Error(`Family "${familyId}" has no version "${hash}"`);
      err.code = "VERSION_NOT_FOUND";
      throw err;
    }
    if (family.headVersion === hash) {
      return { changed: false, family };
    }

    family.headVersion = hash;
    writeFamilyUnlocked(family);
    await commitAll(`Revert ${family.syntheticPath} to ${hash}`);
    return { changed: true, family };
  });
}

/**
 * Changes a family's synthetic path in place - the same family id, the same
 * version history, just a different logical identity going forward. Refuses
 * to collide with another family's existing path, the same invariant
 * createFamily() itself enforces. Callers that also maintain local-state
 * mappings (track.js) are responsible for keeping a mapping's own
 * denormalized syntheticPath field in sync after a real rename - store.js
 * only owns the family record itself.
 */
export async function renameFamily(familyId, newSyntheticPath) {
  return serialize(async () => {
    const family = getFamily(familyId);
    if (!family) {
      const err = new Error(`No family with id "${familyId}"`);
      err.code = "FAMILY_NOT_FOUND";
      throw err;
    }
    if (family.syntheticPath === newSyntheticPath) {
      return { changed: false, family };
    }
    const existing = findFamilyBySyntheticPath(newSyntheticPath);
    if (existing) {
      const err = new Error(`A family already exists at synthetic path "${newSyntheticPath}"`);
      err.code = "FAMILY_PATH_EXISTS";
      throw err;
    }

    const oldSyntheticPath = family.syntheticPath;
    // title defaults to syntheticPath at creation time and there's no
    // separate mechanism to customize it - so as long as it's never
    // diverged from the path, treat it as still mirroring the path rather
    // than leaving it stuck on the old value. A genuinely custom title
    // (were that ever added) is left alone.
    if (family.title === oldSyntheticPath) {
      family.title = newSyntheticPath;
    }
    family.syntheticPath = newSyntheticPath;
    writeFamilyUnlocked(family);
    await commitAll(`Rename ${oldSyntheticPath} -> ${newSyntheticPath}`);
    return { changed: true, family };
  });
}

/**
 * Whole-array replace, matching updateSettings()'s own precedent elsewhere
 * in this codebase - the caller (CLI or UI) computes the desired final set
 * (including any add/remove logic), the store just persists it. Trimmed,
 * deduped, empty strings dropped - free-form labels, not a controlled
 * vocabulary, so the only real invariant worth enforcing here is "no
 * meaningless entries."
 */
export async function setFamilyTags(familyId, tags) {
  return serialize(async () => {
    const family = getFamily(familyId);
    if (!family) {
      const err = new Error(`No family with id "${familyId}"`);
      err.code = "FAMILY_NOT_FOUND";
      throw err;
    }
    const cleaned = [...new Set(tags.map((t) => String(t).trim()).filter((t) => t.length > 0))];
    family.tags = cleaned;
    writeFamilyUnlocked(family);
    await commitAll(`Set tags for ${family.syntheticPath}`);
    return family;
  });
}

/**
 * Permanently removes ONE version's record from a family - not the whole
 * family (see deleteFamily/untrack for that). Heals the supersedes chain so
 * history stays continuous instead of leaving a dangling pointer to a hash
 * that no longer exists: whoever superseded the deleted version gets
 * re-pointed at the deleted version's own parent. Deleting the current head
 * moves headVersion back to that same parent - the same mechanics as an
 * implicit revert, just combined with actually discarding the record. The
 * content blob is left in place, the same reasoning deleteFamily() already
 * applies: content-addressed and possibly shared with other versions or
 * families, so deleting it here isn't safe in general. Refuses to delete a
 * family's only remaining version - that's what untrack is for.
 */
export async function deleteVersion(familyId, hash) {
  return serialize(async () => {
    const family = getFamily(familyId);
    if (!family) {
      const err = new Error(`No family with id "${familyId}"`);
      err.code = "FAMILY_NOT_FOUND";
      throw err;
    }
    const target = family.versions[hash];
    if (!target) {
      const err = new Error(`Family "${familyId}" has no version "${hash}"`);
      err.code = "VERSION_NOT_FOUND";
      throw err;
    }
    if (Object.keys(family.versions).length === 1) {
      const err = new Error(
        "Cannot delete a family's only remaining version - untrack the whole document instead",
      );
      err.code = "CANNOT_DELETE_LAST_VERSION";
      throw err;
    }

    const parentHash = target.supersedes;

    for (const [childHash, version] of Object.entries(family.versions)) {
      if (version.supersedes === hash) {
        family.versions[childHash] = { ...version, supersedes: parentHash };
      }
    }
    delete family.versions[hash];

    if (family.headVersion === hash) {
      family.headVersion =
        parentHash ??
        // Practically unreachable given this codebase's own always-linear
        // version history (see systemPatterns.md) - defensive rather than
        // leaving headVersion pointing at a hash that no longer exists.
        Object.entries(family.versions).sort(([, a], [, b]) => b.createdAt.localeCompare(a.createdAt))[0][0];
    }

    writeFamilyUnlocked(family);
    await commitAll(`Delete version ${hash} of ${family.syntheticPath}`);
    return family;
  });
}

/**
 * Removes a family's record from the store - the real, durable undo for a
 * tracking mistake, not a full reset. Content blobs are left in place
 * (content-addressed and possibly shared with other families, so deleting
 * them here isn't safe in general); an untracked family's history is gone
 * once this commits, matching "the store reflects current desired state"
 * the same way a subsequent snapshot push removes it from the remote too.
 */
export async function deleteFamily(familyId) {
  return serialize(async () => {
    const family = getFamily(familyId);
    if (!family) {
      const err = new Error(`No family with id "${familyId}"`);
      err.code = "FAMILY_NOT_FOUND";
      throw err;
    }
    unlinkSync(join(familiesDir(), `${familyId}.json`));
    await commitAll(`Untrack ${family.syntheticPath}`);
    return family;
  });
}
