import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { listMappings, updateMappingSyntheticPath } from "./local-state.js";
import { getFamily, readContent, recordVersionIfChanged } from "./store.js";
import { isSameNormalizedHtml } from "./html-normalize.js";
import { discoverAndTrackLinkedDocuments } from "./link-discovery.js";

function hashContent(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * The automatic, no-confirmation version-capture path: for every tracked
 * live path, compares the current file against the family's head version
 * and records a new version if it genuinely changed. Comparison is on
 * NORMALIZED HTML, not raw bytes, so re-saving a file with different
 * whitespace/attribute order doesn't spam a noise version - but the RAW
 * bytes are still what gets stored, preserving exact fidelity (see
 * ARCHITECTURE.md section 3.4 and store.js's own raw-hash content identity).
 *
 * Triggered, not passive: this only runs when something calls it (a status
 * read, a families list) - there is no background file watcher in v1.
 *
 * Before treating a difference from the head as a genuinely new edit, this
 * also checks whether the current file's content already matches SOME
 * earlier version already known to the family, not just the head. That
 * case is real and common after a `snapshot pull`: a live-tracked path on
 * this machine can be behind the family's head because a newer version
 * arrived from another machine, not because this file changed. Recording
 * that as a "new" version would silently reintroduce old content as if it
 * were the newest thing, corrupting the lineage - confirmed as a real bug
 * via an actual two-machine test, not a hypothetical, see techContext.md.
 *
 * Every result's syntheticPath is read from the FAMILY record when one is
 * available, never from the mapping's own denormalized copy of it. A
 * family's synthetic path can change via `renameFamily` on a different
 * machine and arrive here purely through `snapshot pull` (which only
 * touches the synced store, never local-state.json) - so the mapping's own
 * cached copy can go stale on every machine except the one the rename
 * actually happened on. Confirmed as a real, reproducible gap, not a
 * hypothetical: a two-machine simulation showed `docmanager status` on the
 * second machine reporting a renamed family's OLD path indefinitely after a
 * pull, even though version capture itself was already working correctly
 * off the (path-independent) familyId. Self-heals the mapping's cached copy
 * on the way past so this converges rather than staying stale forever.
 */
export async function reconcile() {
  const results = [];

  for (const mapping of listMappings()) {
    const { realPath, familyId } = mapping;

    // A corrupt family record for ONE mapping must never break reconciliation
    // for every other, perfectly healthy mapping - see doctor.js's
    // familyIntegrity check for the full diagnostic; this just keeps a
    // single bad file from taking down `docmanager status`/`families`
    // entirely, the same defensive fix applied to index.js and suggest.js.
    let family;
    try {
      family = getFamily(familyId);
    } catch {
      results.push({ syntheticPath: mapping.syntheticPath, familyId, status: "corrupt", realPath });
      continue;
    }
    if (!family) {
      results.push({ syntheticPath: mapping.syntheticPath, familyId, status: "orphaned-mapping", realPath });
      continue;
    }

    const syntheticPath = family.syntheticPath;
    if (syntheticPath !== mapping.syntheticPath) {
      updateMappingSyntheticPath(familyId, syntheticPath);
    }

    if (!existsSync(realPath)) {
      results.push({ syntheticPath, familyId, status: "missing", realPath });
      continue;
    }

    const currentBytes = readFileSync(realPath);
    const headBytes = readContent(family.headVersion);

    if (headBytes && isSameNormalizedHtml(currentBytes, headBytes)) {
      results.push({ syntheticPath, familyId, status: "unchanged" });
      continue;
    }

    const currentHash = hashContent(currentBytes);
    if (family.versions[currentHash] && currentHash !== family.headVersion) {
      results.push({ syntheticPath, familyId, status: "behind-head" });
      continue;
    }

    const { changed } = await recordVersionIfChanged(familyId, currentBytes, basename(realPath));
    results.push({
      syntheticPath,
      familyId,
      status: changed ? "new-version-captured" : "unchanged",
    });

    // A version that genuinely changed may have added a link to a document
    // never seen before - re-run the same crawl trackPath() itself triggers
    // at track time, so a link added later works exactly like one present
    // from the start. A mapping with no linkRoot predates this feature
    // entirely - skipped, not guessed at.
    if (changed && mapping.linkRoot) {
      const { results: linkedResults } = await discoverAndTrackLinkedDocuments(realPath, mapping.linkRoot);
      for (const linked of linkedResults) {
        if (linked.status !== "tracked") continue;
        results.push({ syntheticPath: linked.family.syntheticPath, familyId: linked.family.id, status: "tracked-via-link" });
      }
    }
  }

  return results;
}
