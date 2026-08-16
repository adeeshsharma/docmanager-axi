import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { docmanagerHome } from "./paths.js";

// Maps a synthetic logical path to wherever its source file lives on THIS
// machine. Deliberately never synced (not part of the git store) - this is
// what keeps the system independent of any one machine's file layout. See
// ARCHITECTURE.md section 3.2 and systemPatterns.md.
function localStatePath() {
  return join(docmanagerHome(), "local-state.json");
}

function readAll() {
  if (!existsSync(localStatePath())) return [];
  return JSON.parse(readFileSync(localStatePath(), "utf8"));
}

function writeAll(mappings) {
  writeFileSync(localStatePath(), JSON.stringify(mappings, null, 2));
}

export function listMappings() {
  return readAll();
}

export function findBySyntheticPath(syntheticPath) {
  return readAll().find((m) => m.syntheticPath === syntheticPath) ?? null;
}

export function findByRealPath(realPath) {
  return readAll().find((m) => m.realPath === realPath) ?? null;
}

/**
 * Each real path maps to at most one synthetic path on a given machine -
 * tracking a path that's already mapped elsewhere is an error, not a silent
 * overwrite.
 */
export function addMapping({ syntheticPath, realPath, familyId }) {
  const mappings = readAll();
  if (mappings.some((m) => m.realPath === realPath)) {
    const err = new Error(`"${realPath}" is already tracked under a different synthetic path`);
    err.code = "PATH_ALREADY_MAPPED";
    throw err;
  }
  mappings.push({ syntheticPath, realPath, familyId });
  writeAll(mappings);
}

export function removeMappingByFamilyId(familyId) {
  const mappings = readAll().filter((m) => m.familyId !== familyId);
  writeAll(mappings);
}

/**
 * A mapping's own syntheticPath is denormalized from the family record it
 * points at (store.js is the source of truth) - purely so reconcile()'s
 * results carry a readable path without an extra family lookup per mapping.
 * Nothing looks a mapping up BY this field (findBySyntheticPath has no real
 * call site), so staleness here can never break tracking behavior, but it
 * WOULD make `docmanager status`/`families` report a stale path after a
 * rename if this isn't kept in sync. A family can in principle have more
 * than one local mapping (tracked at two real paths on the same machine), so
 * every matching mapping is updated, not just the first.
 */
export function updateMappingSyntheticPath(familyId, newSyntheticPath) {
  const mappings = readAll();
  let changed = false;
  for (const m of mappings) {
    if (m.familyId === familyId && m.syntheticPath !== newSyntheticPath) {
      m.syntheticPath = newSyntheticPath;
      changed = true;
    }
  }
  if (changed) writeAll(mappings);
}
