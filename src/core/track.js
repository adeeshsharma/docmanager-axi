import { readFileSync, realpathSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { createFamily, getFamily, findFamilyBySyntheticPath, deleteFamily, renameFamily } from "./store.js";
import {
  addMapping,
  findByRealPath,
  listMappings,
  removeMapping,
  removeMappingByFamilyId,
  updateMappingSyntheticPath,
} from "./local-state.js";
import { editDir } from "./paths.js";
import { discoverAndTrackLinkedDocuments } from "./link-discovery.js";

// Every Lavish edit-and-relink cycle (ARCHITECTURE.md section 5) materializes
// a NEW working file under editDir(), named after the pre-edit hash, then
// relinks it as this family's live mapping. Nothing else ever writes here, so
// a mapping whose realPath lives inside this directory is always a
// single-use Lavish scratch copy (paths.js's own "disposable scratch files"),
// never a second genuine real-world tracked location - unlike the original
// tracked file, which stays a legitimate, permanent mapping even after a
// relink (the user may still be editing it directly, independent of Lavish).
function isEditDirPath(realPath) {
  // realPath (both the mapping's own and the one just resolved in trackPath
  // below) always comes from realpathSync(), which expands symlinks - on
  // Mac in particular, tmpdir()-rooted paths resolve to a "/private/..."
  // prefix that editDir()'s own raw DOCMANAGER_HOME-based path doesn't carry
  // unless it's resolved the same way. Comparing an unresolved editDir()
  // against an already-resolved realPath would silently never match.
  const dir = existsSync(editDir()) ? realpathSync(editDir()) : editDir();
  return realPath === dir || realPath.startsWith(dir + sep);
}

export function defaultSyntheticPath(realPath) {
  const base = basename(realPath, extname(realPath));
  return `/${base}`;
}

/**
 * Tracking an already-tracked path is an idempotent no-op, not an error -
 * the desired end state ("this path is tracked") is already true.
 *
 * If the synthetic path already belongs to a family but nothing on THIS
 * machine maps to it yet (the common case right after a fresh `snapshot
 * pull`, per ARCHITECTURE.md section 6), `relink: true` connects this real
 * path to that existing family instead of erroring or creating a
 * duplicate. Deliberately manual, never inferred - this is exactly the
 * boundary ARCHITECTURE.md draws: the tool never guesses that a file on a
 * new machine is the same as one from a snapshot. Content isn't required to
 * match exactly at relink time; the next reconcile naturally captures any
 * drift as a new version, reusing existing machinery rather than adding a
 * special case here.
 */
export async function trackPath(inputPath, { as, relink, linkRoot } = {}) {
  if (!existsSync(inputPath)) {
    const err = new Error(`No such file: "${inputPath}"`);
    err.code = "FILE_NOT_FOUND";
    throw err;
  }

  const realPath = realpathSync(inputPath);
  // Every track defaults to being bounded to its own containing directory
  // when no explicit root is given - this is what makes cross-document
  // link-following work for the common single-file track case, not just a
  // folder-track.
  const effectiveLinkRoot = linkRoot ?? dirname(realPath);
  const existingMapping = findByRealPath(realPath);
  if (existingMapping) {
    return { family: getFamily(existingMapping.familyId), alreadyTracked: true, relinked: false, linkRoot: effectiveLinkRoot, realPath };
  }

  const syntheticPath = as ?? defaultSyntheticPath(realPath);
  const existingFamily = findFamilyBySyntheticPath(syntheticPath);

  if (existingFamily) {
    if (!relink) {
      const err = new Error(
        `A family already exists at synthetic path "${syntheticPath}". If this is the same document, pass --relink.`,
      );
      err.code = "FAMILY_PATH_EXISTS";
      // Attached so a caller (the UI in particular) can show WHICH existing
      // document this collided with - title, how many versions it already
      // has, when it was last touched - rather than a bare "already exists"
      // error the user has no way to act on informedly.
      err.existingFamily = {
        id: existingFamily.id,
        syntheticPath: existingFamily.syntheticPath,
        title: existingFamily.title,
        versionCount: Object.keys(existingFamily.versions).length,
        headVersion: existingFamily.headVersion,
        headCreatedAt: existingFamily.versions[existingFamily.headVersion]?.createdAt ?? null,
      };
      throw err;
    }
    // Relinking to a new Lavish scratch copy retires this family's PREVIOUS
    // scratch copy, if any - otherwise every completed edit session leaves
    // its now-dead working file permanently mapped, and deleteVersion()'s
    // "is this content still live" check (store.js) treats that abandoned
    // file as though it were still the document's current state forever,
    // blocking deletion of a version that has long since been superseded.
    // Only editDir() mappings are retired here; a genuine second real-world
    // location for this family (e.g. its original tracked file) is left
    // alone; see isEditDirPath()'s own comment above.
    if (isEditDirPath(realPath)) {
      for (const stale of listMappings()) {
        if (stale.familyId !== existingFamily.id || !isEditDirPath(stale.realPath)) continue;
        removeMapping(stale.realPath);
        try {
          unlinkSync(stale.realPath);
        } catch {
          // Best-effort - the scratch file may already be gone.
        }
      }
    }
    addMapping({ syntheticPath, realPath, familyId: existingFamily.id, linkRoot: effectiveLinkRoot });
    return { family: existingFamily, alreadyTracked: false, relinked: true, linkRoot: effectiveLinkRoot, realPath };
  }

  const content = readFileSync(realPath);
  const family = await createFamily({
    syntheticPath,
    content,
    sourceFileName: basename(realPath),
  });
  addMapping({ syntheticPath, realPath, familyId: family.id, linkRoot: effectiveLinkRoot });
  return { family, alreadyTracked: false, relinked: false, linkRoot: effectiveLinkRoot, realPath };
}

// Directories that are near-universally vendor code, build output, or tool
// state rather than a user's own documents - every dev tool that walks a
// directory tree (linters, formatters, search tools) excludes these by
// default for exactly this reason. Real HTML content shows up incidentally
// inside these constantly (test fixtures, coverage reports, a bundler's own
// HTML templates), and none of it is something a user meant to track when
// they pointed docmanager at a folder.
const EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".docmanager",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".cache",
  "coverage",
]);

/**
 * Recursively finds every .html file under a directory, skipping
 * well-known vendor/build directories. Guards against a symlink cycle by
 * tracking which real directories have already been walked - a rare case,
 * but a recursive walk that follows symlinks needs this to be correct, not
 * just usually fine.
 */
function collectHtmlFiles(rootDir) {
  const found = [];
  const visitedRealDirs = new Set();

  function walk(dir) {
    let real;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (visitedRealDirs.has(real)) return;
    visitedRealDirs.add(real);

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
        walk(fullPath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
        try {
          const targetStat = statSync(fullPath);
          if (targetStat.isDirectory()) {
            walk(fullPath);
          } else if (targetStat.isFile() && extname(fullPath).toLowerCase() === ".html") {
            found.push(fullPath);
          }
        } catch {
          // Broken symlink - skip.
        }
        continue;
      }
      if (entry.isFile() && extname(entry.name).toLowerCase() === ".html") {
        found.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return found;
}

// For a file discovered while walking a folder, the synthetic path is
// derived from its location relative to that folder's root, not just its
// basename - otherwise two same-named files in different subfolders would
// collide on the same synthetic path the moment a folder is tracked in one
// batch, which the single-file default was never designed to handle.
function syntheticPathForDiscoveredFile(rootDir, filePath) {
  const rel = relative(rootDir, filePath);
  const relNoExt = rel.slice(0, rel.length - extname(rel).length);
  const posixRel = relNoExt.split(sep).join("/");
  return `/${posixRel}`;
}

/**
 * Batch entry point: each input may be a file or a folder (recursively
 * expanded for .html files), and one failure never aborts the rest of the
 * batch - every input gets its own result. `as` is only valid when tracking
 * exactly one file, since it sets a single synthetic path and has no
 * sensible meaning across multiple targets.
 */
export async function trackPaths(inputPaths, { as, relink } = {}) {
  if (inputPaths.length === 0) {
    const err = new Error("At least one path is required");
    err.code = "NO_PATHS";
    throw err;
  }

  if (as !== undefined) {
    const singleFileOnly =
      inputPaths.length === 1 && existsSync(inputPaths[0]) && !statSync(inputPaths[0]).isDirectory();
    if (!singleFileOnly) {
      const err = new Error("--as can only be used when tracking a single file, not a folder or multiple paths");
      err.code = "AS_REQUIRES_SINGLE_FILE";
      throw err;
    }
  }

  const results = [];
  const targets = [];

  for (const inputPath of inputPaths) {
    if (!existsSync(inputPath)) {
      results.push({ path: inputPath, status: "error", error: `No such file: "${inputPath}"`, code: "FILE_NOT_FOUND" });
      continue;
    }

    if (statSync(inputPath).isDirectory()) {
      const rootReal = realpathSync(inputPath);
      const files = collectHtmlFiles(inputPath);
      if (files.length === 0) {
        results.push({ path: inputPath, status: "no-html-files-found" });
        continue;
      }
      for (const file of files) {
        targets.push({ filePath: file, syntheticPath: syntheticPathForDiscoveredFile(inputPath, file), linkRoot: rootReal });
      }
    } else {
      targets.push({ filePath: inputPath, syntheticPath: as, linkRoot: undefined });
    }
  }

  for (const target of targets) {
    try {
      const { family, alreadyTracked, relinked, linkRoot: effectiveLinkRoot, realPath } = await trackPath(target.filePath, {
        as: target.syntheticPath,
        relink,
        linkRoot: target.linkRoot,
      });
      results.push({
        path: target.filePath,
        status: relinked ? "relinked" : alreadyTracked ? "already-tracked" : "tracked",
        family,
      });
      // Nothing new to discover from a no-op re-track - only crawl on a
      // genuinely fresh track or a relink (which may have brought in
      // content with links never seen before, e.g. reconnecting a
      // snapshot-pulled folder).
      if (!alreadyTracked) {
        const { results: linkedResults } = await discoverAndTrackLinkedDocuments(realPath, effectiveLinkRoot);
        results.push(...linkedResults);
      }
    } catch (err) {
      results.push({
        path: target.filePath,
        status: "error",
        error: err.message,
        code: err.code,
        ...(err.existingFamily ? { existingFamily: err.existingFamily } : {}),
      });
    }
  }

  const summary = {
    trackedCount: results.filter((r) => r.status === "tracked").length,
    alreadyTrackedCount: results.filter((r) => r.status === "already-tracked").length,
    relinkedCount: results.filter((r) => r.status === "relinked").length,
    errorCount: results.filter((r) => r.status === "error").length,
  };

  return { results, summary };
}

/**
 * The real, durable undo for a tracking mistake: removes each family and
 * its local-machine path mapping. One failure never aborts the rest of the
 * batch, matching trackPaths()'s own behavior - useful for exactly the
 * case that motivated building this, undoing a folder tracked by mistake
 * that pulled in many families at once.
 */
export async function untrackFamilies(ids) {
  const results = [];
  for (const id of ids) {
    try {
      const family = await deleteFamily(id);
      removeMappingByFamilyId(id);
      results.push({ id, status: "untracked", syntheticPath: family.syntheticPath });
    } catch (err) {
      results.push({ id, status: "error", error: err.message, code: err.code });
    }
  }

  const summary = {
    untrackedCount: results.filter((r) => r.status === "untracked").length,
    errorCount: results.filter((r) => r.status === "error").length,
  };

  return { results, summary };
}

/**
 * Renames a tracked family and keeps this machine's own local-state
 * mapping(s) in step - store.js's renameFamily() only owns the synced
 * family record, so this is the orchestration layer that also touches the
 * never-synced local mapping, the same split untrackFamilies() above
 * already follows for delete.
 */
export async function renameTrackedDocument(familyId, newSyntheticPath) {
  const { changed, family } = await renameFamily(familyId, newSyntheticPath);
  if (changed) updateMappingSyntheticPath(familyId, newSyntheticPath);
  return { changed, family };
}
