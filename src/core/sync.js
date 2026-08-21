import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { storePath, withStoreLock, getFamily, listFamilyIds, mergeFamilies } from "./store.js";
import { runGit } from "./git.js";
import { rebuildIndex } from "./index.js";
import { requireRemote, cloneFresh, fetchOrigin } from "./snapshot.js";

const FAMILY_PATH_PATTERN = /^families\/[^/]+\.json$/;

// How far apart two independently-tracked histories' earliest versions need
// to be before their order is trusted enough to auto-link without asking.
// Two real machines syncing are essentially always more than a second
// apart; this mainly protects against two histories created close enough
// together (e.g. clock skew, or a genuinely simultaneous scenario) that
// "which one is older" isn't a confident call.
const AMBIGUOUS_THRESHOLD_MS = 1000;

function earliestCreatedAt(family) {
  return Math.min(...Object.values(family.versions).map((v) => Date.parse(v.createdAt)));
}

/**
 * Unions two divergent copies of the SAME family's version map - never
 * rewrites a version's own `supersedes` pointer. Two machines that forked
 * from a common ancestor produce a genuine two-branch history; flattening
 * that into one chronological chain by sort order would silently discard
 * which branch a version actually came from. The only thing derived from
 * `createdAt` here is which merged version becomes the new `headVersion` -
 * the same "most recent edit is current" rule the rest of this codebase
 * already applies everywhere (auto-capture, revert, etc.). Exported so this
 * can be unit-tested directly, not only through the full sync path.
 */
export function unionFamilyVersions(ours, theirs) {
  const versions = { ...ours.versions };
  for (const [hash, version] of Object.entries(theirs.versions)) {
    if (!versions[hash]) versions[hash] = version;
  }
  const headVersion = Object.entries(versions).sort(
    ([, a], [, b]) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  )[0][0];
  const tags = [...new Set([...(ours.tags ?? []), ...(theirs.tags ?? [])])];
  return { ...ours, versions, headVersion, tags };
}

// The XY codes `git status --porcelain=v1` uses for an actual unresolved
// conflict - "both modified", "both added", "both deleted", and the four
// add/delete combinations. Everything else (a plain "A ", "M ", "D " line)
// is a cleanly-staged part of the merge, not a conflict, and must never be
// treated as one - a real merge with zero conflicts still stages plenty of
// ordinary "A "/"M " lines for content the other side added.
const CONFLICT_CODES = new Set(["UU", "AA", "DD", "AU", "UA", "DU", "UD"]);

async function parseConflictedPaths() {
  const raw = await runGit(storePath(), ["status", "--porcelain=v1"]);
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }))
    .filter((entry) => CONFLICT_CODES.has(entry.code));
}

async function abortMerge() {
  await runGit(storePath(), ["merge", "--abort"]).catch(() => {});
}

function syncConflictError() {
  const err = new Error(
    "Sync found a conflict outside what it can resolve automatically. Local changes were not affected - " +
      `resolve it directly with git in ${storePath()}, then sync again.`,
  );
  err.code = "SYNC_CONFLICT";
  return err;
}

/**
 * Phase 1: fetch + merge + resolve Case A (same family, both sides added a
 * version) under a single store lock, mirroring pullSnapshot()'s own
 * single-lock shape. For a dry run, the merged-but-uncommitted state is
 * deliberately LEFT on disk when this returns - restoring it is the final
 * caller's job (syncSnapshot, below), never done here, since phase 2 (Case
 * B detection) needs to see the merged state first.
 */
async function fetchAndResolveCaseA(url, { dryRun }) {
  return withStoreLock(async () => {
    const preMergeHead = (await runGit(storePath(), ["rev-parse", "HEAD"])).trim();
    await fetchOrigin(url);

    const semanticMerges = [];
    let mergeInProgress = false;

    try {
      // Unlike pullSnapshot()'s plain merge (only ever run against a store
      // that was itself cloned from this same remote, so always a related
      // history), sync's whole point is also covering two machines that
      // each tracked independently before ever syncing - two entirely
      // separate git histories with no common ancestor at all. Git refuses
      // that by default ("refusing to merge unrelated histories"); this is
      // exactly the expected shape for Case B, not an error condition.
      await runGit(storePath(), ["merge", "origin/main", "--no-commit", "--allow-unrelated-histories"]);
    } catch {
      mergeInProgress = true;
      const conflicts = await parseConflictedPaths();

      // An empty conflict list here means the merge failed for some other
      // reason entirely (not a content conflict this function understands)
      // - fall back to the raw conflict rather than silently treating "no
      // recognized conflicts" as "nothing to resolve."
      const resolvable =
        conflicts.length > 0 && conflicts.every((c) => c.code === "UU" && FAMILY_PATH_PATTERN.test(c.path));
      if (!resolvable) {
        await abortMerge();
        throw syncConflictError();
      }

      for (const { path } of conflicts) {
        const [oursRaw, theirsRaw] = await Promise.all([
          runGit(storePath(), ["show", `HEAD:${path}`]),
          runGit(storePath(), ["show", `MERGE_HEAD:${path}`]),
        ]);
        const ours = JSON.parse(oursRaw);
        const theirs = JSON.parse(theirsRaw);

        // A rename racing a version add on the two sides is a real but
        // different shape than "both sides added a version" - outside this
        // function's defined scope, falls back to the raw conflict.
        if (ours.syntheticPath !== theirs.syntheticPath) {
          await abortMerge();
          throw syncConflictError();
        }

        const resolved = unionFamilyVersions(ours, theirs);
        writeFileSync(join(storePath(), path), JSON.stringify(resolved, null, 2));
        if (!dryRun) await runGit(storePath(), ["add", path]);

        semanticMerges.push({
          syntheticPath: resolved.syntheticPath,
          localVersionCount: Object.keys(ours.versions).length,
          remoteVersionCount: Object.keys(theirs.versions).length,
          mergedVersionCount: Object.keys(resolved.versions).length,
          headVersion: resolved.headVersion,
        });
      }
    }

    if (!dryRun) {
      const status = await runGit(storePath(), ["status", "--porcelain=v1"]);
      if (status.trim().length > 0 || mergeInProgress) {
        const message =
          semanticMerges.length > 0
            ? `Sync-merge: ${semanticMerges
                .map(
                  (m) =>
                    `${m.syntheticPath}: ${m.localVersionCount} local + ${m.remoteVersionCount} remote version(s) -> ${m.mergedVersionCount} total`,
                )
                .join(", ")}`
            : "Sync-merge (no version conflicts)";
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
      rebuildIndex();
    }

    return { semanticMerges, mergeInProgress, preMergeHead };
  });
}

/**
 * Phase 2: scan for Case B (two DIFFERENT families sharing the exact same
 * syntheticPath - never a git-level conflict, since they're different
 * files, so it has to be detected separately after the merge). Reads
 * families straight off disk (getFamily/listFamilyIds), which reflects
 * phase 1's merged-but-possibly-uncommitted state correctly either way.
 * Deliberately NOT called from inside fetchAndResolveCaseA's own lock -
 * mergeFamilies() self-serializes via its own withStoreLock call, and
 * store.js's serialize() explicitly forbids nesting one inside another (it
 * deadlocks, waiting on a queue tail that itself waits on the outer call).
 */
async function resolveCaseB({ dryRun, autoLink }) {
  const byPath = new Map();
  for (const id of listFamilyIds()) {
    const family = getFamily(id);
    if (!family) continue;
    const group = byPath.get(family.syntheticPath) ?? [];
    group.push(family);
    byPath.set(family.syntheticPath, group);
  }

  const autoLinks = [];
  const unresolved = [];

  for (const [syntheticPath, group] of byPath) {
    if (group.length <= 1) continue;

    if (group.length !== 2) {
      unresolved.push({
        syntheticPath,
        ids: group.map((f) => f.id),
        reason: "3+ way collision on this path - resolve manually with `docmanager link`",
      });
      continue;
    }

    const [a, b] = group;
    const aHashes = new Set(Object.keys(a.versions));
    const disjoint = !Object.keys(b.versions).some((hash) => aHashes.has(hash));
    const gapMs = Math.abs(earliestCreatedAt(a) - earliestCreatedAt(b));
    const unambiguous = gapMs >= AMBIGUOUS_THRESHOLD_MS;

    if (disjoint && unambiguous) {
      const [older, newer] = earliestCreatedAt(a) < earliestCreatedAt(b) ? [a, b] : [b, a];
      const entry = {
        syntheticPath,
        olderId: older.id,
        newerId: newer.id,
        olderVersionCount: Object.keys(older.versions).length,
        newerVersionCount: Object.keys(newer.versions).length,
      };
      if (autoLink && !dryRun) {
        await mergeFamilies(older.id, newer.id);
        autoLinks.push(entry);
      } else {
        unresolved.push({
          ...entry,
          command: `docmanager link ${older.id} ${newer.id}`,
          reason: dryRun ? "would auto-link (dry run)" : "not auto-linked (--no-auto-link)",
        });
      }
    } else {
      unresolved.push({
        syntheticPath,
        ids: [a.id, b.id],
        reason: disjoint
          ? "ambiguous order - earliest versions are too close in time to call confidently"
          : "shares version history with another family at this path - resolve manually",
        command: "docmanager link <older-id> <newer-id> (decide the order yourself)",
      });
    }
  }

  return { autoLinks, unresolved };
}

/**
 * Pulls the configured remote and resolves the two most common divergence
 * shapes automatically instead of always falling back to a raw git conflict
 * abort (pullSnapshot()'s own behavior, still available and still the
 * fallback here for anything outside these two shapes) - see
 * fetchAndResolveCaseA and resolveCaseB above for the two shapes themselves.
 * `--dry-run` reports everything that would happen without changing
 * anything; `autoLink: false` still detects and reports Case B collisions
 * but never links them automatically.
 */
export async function syncSnapshot({ dryRun = false, autoLink = true } = {}) {
  const url = requireRemote();

  if (!existsSync(storePath())) {
    return withStoreLock(async () => {
      if (dryRun) return { dryRun: true, mode: "would-clone" };
      const result = await cloneFresh(url);
      return { ...result, semanticMerges: [], autoLinks: [], unresolved: [] };
    });
  }

  const phase1 = await fetchAndResolveCaseA(url, { dryRun });
  const { autoLinks, unresolved } = await resolveCaseB({ dryRun, autoLink });

  if (dryRun) {
    await withStoreLock(async () => {
      if (phase1.mergeInProgress) await abortMerge();
      else await runGit(storePath(), ["reset", "--hard", phase1.preMergeHead]);
    });
    return { dryRun: true, semanticMerges: phase1.semanticMerges, autoLinks: [], unresolved };
  }

  // mergeFamilies() (inside resolveCaseB, when it auto-links) commits but
  // doesn't rebuild the index itself - same precedent as the /link route in
  // server.js, which calls rebuildIndex() right after its own mergeFamilies()
  // call rather than folding it into store.js.
  if (autoLinks.length > 0) rebuildIndex();

  return { synced: true, semanticMerges: phase1.semanticMerges, autoLinks, unresolved };
}
