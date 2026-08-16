import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { storePath, listFamilyIds, getFamily, readContent } from "./store.js";
import { rebuildIndex, listFamiliesFromIndex } from "./index.js";
import { listMappings, removeMappingByFamilyId } from "./local-state.js";

// A diagnostic-and-safe-repair command, distinct from (and much less
// dangerous than) a full reset: everything here either only READS state, or
// repairs something that's provably safe to fix automatically because it's
// either fully derived data (the SQLite index - store.js/systemPatterns.md
// already treat it as disposable, rebuilt from the git-backed JSON on
// startup/after every relevant change) or a pointer to something that's
// already gone (a local-state mapping whose family no longer exists - the
// same cleanup `untrackFamilies` already does for a family it deletes
// itself, just catching the case where a family disappeared some other way,
// e.g. hand-edited out of the store). Anything that could represent real
// document data loss (a corrupt family record, a missing content blob) is
// only ever reported, never silently touched - that judgment call belongs
// to the user, the same approval-gating principle as the reset/uninstall
// command.

function checkGit() {
  const result = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return {
      name: "git",
      status: "error",
      message: "git is not available on this machine - see the README's setup instructions",
    };
  }
  return { name: "git", status: "ok", message: result.stdout.trim() };
}

function checkStore() {
  if (!existsSync(storePath())) {
    return {
      name: "store",
      status: "warning",
      message: "No store yet - nothing has been tracked, and no snapshot has been pulled, on this machine",
    };
  }
  if (!existsSync(join(storePath(), ".git"))) {
    return {
      name: "store",
      status: "error",
      message: `${storePath()} exists but is not a git repository - something outside docmanager likely modified it`,
    };
  }
  return { name: "store", status: "ok", message: storePath() };
}

// Walks every family once, checking both that its own JSON record parses
// (checkFamilyIntegrity) and that every version it claims to have actually
// has a content blob on disk (checkContentIntegrity) - one pass rather than
// two, since both need the same family list.
function walkFamiliesForIntegrity() {
  const corruptFamilies = [];
  const missingContent = [];
  let familyCount = 0;
  let versionCount = 0;

  for (const id of listFamilyIds()) {
    let family;
    try {
      family = getFamily(id);
    } catch (err) {
      corruptFamilies.push({ id, error: err.message });
      continue;
    }
    if (!family) continue;
    familyCount++;
    for (const hash of Object.keys(family.versions ?? {})) {
      versionCount++;
      if (!readContent(hash)) {
        missingContent.push({ familyId: id, syntheticPath: family.syntheticPath, hash });
      }
    }
  }

  return { familyCount, versionCount, corruptFamilies, missingContent };
}

function checkFamilyIntegrity({ familyCount, corruptFamilies }) {
  if (corruptFamilies.length === 0) {
    return { name: "familyIntegrity", status: "ok", message: `${familyCount} family record(s), all valid JSON` };
  }
  return {
    name: "familyIntegrity",
    status: "error",
    message: `${corruptFamilies.length} family record(s) failed to parse - real data, not auto-repaired`,
    details: corruptFamilies,
  };
}

function checkContentIntegrity({ versionCount, missingContent }) {
  if (missingContent.length === 0) {
    return { name: "contentIntegrity", status: "ok", message: `${versionCount} version(s), all content present` };
  }
  return {
    name: "contentIntegrity",
    status: "error",
    message: `${missingContent.length} version(s) reference content that is missing on disk - not auto-repaired`,
    details: missingContent,
  };
}

// Always safe: the index is explicitly derived, disposable data (see
// store.js/systemPatterns.md) - a rebuild here is the exact same operation
// that already runs automatically after every track/link/untrack/pull.
function checkIndex() {
  try {
    rebuildIndex();
    const families = listFamiliesFromIndex();
    return { name: "index", status: "ok", message: `rebuilt - ${families.length} famil${families.length === 1 ? "y" : "ies"} indexed` };
  } catch (err) {
    return { name: "index", status: "error", message: `Could not rebuild the index: ${err.message}` };
  }
}

// "Gone" (getFamily returns null) and "corrupt" (getFamily throws) are NOT
// the same situation and must not be treated the same way here: a genuinely
// missing family means the mapping points at nothing and is safe to clean
// up, but a corrupt-but-present family record might still be recoverable
// (e.g. from the store's own git history) - silently deleting a real path's
// mapping to it on top of that would compound data loss instead of just
// reporting it, which is exactly what checkFamilyIntegrity already does.
function familyIsGenuinelyMissing(familyId) {
  try {
    return getFamily(familyId) === null;
  } catch {
    return false; // present but corrupt - leave the mapping alone
  }
}

// Also safe to auto-repair: a mapping whose family id no longer resolves to
// anything is a pointer to nothing, identical in spirit to the cleanup
// untrackFamilies() already does when IT deletes a family - this just
// catches the same situation when the family disappeared some other way.
function checkLocalState() {
  const mappings = listMappings();
  const orphaned = mappings.filter((m) => familyIsGenuinelyMissing(m.familyId));
  for (const mapping of orphaned) {
    removeMappingByFamilyId(mapping.familyId);
  }

  if (orphaned.length === 0) {
    return { name: "localState", status: "ok", message: `${mappings.length} local path mapping(s), all valid` };
  }
  return {
    name: "localState",
    status: "repaired",
    message: `Removed ${orphaned.length} orphaned local path mapping(s) pointing at families that no longer exist`,
    details: orphaned.map((m) => ({ syntheticPath: m.syntheticPath, realPath: m.realPath })),
  };
}

const SEVERITY = { ok: 0, repaired: 0, warning: 1, error: 2 };

export async function runDoctor() {
  const checks = [checkGit(), checkStore()];

  // Only meaningful once a store actually exists - an empty machine with
  // nothing tracked yet isn't "broken", so skip the deeper checks rather
  // than reporting hollow zero-count "errors" against nothing.
  if (existsSync(storePath())) {
    const integrity = walkFamiliesForIntegrity();
    checks.push(checkFamilyIntegrity(integrity), checkContentIntegrity(integrity), checkIndex(), checkLocalState());
  }

  const worst = checks.reduce((max, c) => Math.max(max, SEVERITY[c.status] ?? 0), 0);
  const status = worst === 2 ? "error" : worst === 1 ? "warning" : "ok";

  return { status, checks };
}
