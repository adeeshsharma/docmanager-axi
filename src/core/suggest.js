import { createHash } from "node:crypto";
import { parse } from "parse5";
import { getFamily, listFamilyIds, readContent } from "./store.js";
import { extractTitle } from "./html-normalize.js";

// Cheap, suggestion-only heuristics for "these two SEPARATE, already-tracked
// families might actually be the same document" - explicitly scoped into v1
// by ARCHITECTURE.md section 9 ("something cheap... to nudge the user toward
// linking versions") but never implemented until now. This is a genuinely
// different mechanism from reconcile.js's automatic capture: that operates
// on ONE already-known family at an already-tracked path, with no ambiguity
// left to resolve. This operates across DIFFERENT families and is always,
// only, a suggestion - never auto-linked. See systemPatterns.md.

function collectTagSequence(node, out) {
  if (node.tagName) out.push(node.tagName);
  for (const child of node.childNodes ?? []) collectTagSequence(child, out);
}

// Coarse on purpose: a hash of the tag sequence in document order, ignoring
// text and attributes entirely. Two documents built from the same template
// (a report generator, an export tool) tend to share this exactly even when
// their content differs completely - "near-identical structure" per
// ARCHITECTURE.md section 9, not a precise similarity score.
function structuralFingerprint(document) {
  const tags = [];
  collectTagSequence(document, tags);
  return createHash("sha256").update(tags.join(">")).digest("hex");
}

// Strips common "this is a copy/draft/version of the same thing" suffixes
// before comparing titles, so "Q3 Report" and "Q3 Report (final)" or "Q3
// Report v2" are still recognized as the same underlying document title.
const VERSION_SUFFIX_PATTERN =
  /[\s_-]*\(?(copy|draft|final|old|new|backup|v\d+|version\s*\d+|\d+)\)?\s*$/i;

function normalizeTitle(title) {
  let normalized = title.toLowerCase().trim().replace(/\s+/g, " ");
  // Strip at most a couple of trailing suffix-like segments (e.g. "report
  // final copy") rather than looping to a fixed point, which could strip a
  // legitimately short, all-suffix-looking real title down to nothing.
  for (let i = 0; i < 2; i++) {
    const stripped = normalized.replace(VERSION_SUFFIX_PATTERN, "").trim();
    if (stripped === normalized || stripped.length === 0) break;
    normalized = stripped;
  }
  return normalized;
}

function analyzeFamily(id) {
  // A corrupt family record must never take down suggestions for every
  // OTHER, perfectly healthy family - see doctor.js's familyIntegrity check
  // for surfacing that specific problem to the user; this just makes sure
  // it can't cascade into breaking `GET /families` entirely.
  let family;
  try {
    family = getFamily(id);
  } catch {
    return null;
  }
  if (!family) return null;
  const content = readContent(family.headVersion);
  if (!content) return { id, syntheticPath: family.syntheticPath, title: null, fingerprint: null };
  try {
    const document = parse(content.toString("utf8"));
    return {
      id,
      syntheticPath: family.syntheticPath,
      title: extractTitle(content),
      fingerprint: structuralFingerprint(document),
    };
  } catch {
    // Malformed enough that even parse5's lenient parser chokes - skip
    // heuristics for this family rather than let one bad document break
    // suggestions for every other pair.
    return { id, syntheticPath: family.syntheticPath, title: null, fingerprint: null };
  }
}

/**
 * Compares every pair of currently-tracked families and returns cheap,
 * suggestion-only signals that a pair might be the same document at
 * different points in time. Never links anything itself - see `link` /
 * `mergeFamilies` for the explicit, user/agent-declared action this can
 * only ever nudge toward.
 */
export function suggestLinks() {
  const infos = listFamilyIds()
    .map(analyzeFamily)
    .filter((info) => info !== null);

  const suggestions = [];
  for (let i = 0; i < infos.length; i++) {
    for (let j = i + 1; j < infos.length; j++) {
      const a = infos[i];
      const b = infos[j];
      const reasons = [];

      if (a.title && b.title) {
        const normalizedA = normalizeTitle(a.title);
        const normalizedB = normalizeTitle(b.title);
        if (normalizedA && normalizedA === normalizedB) reasons.push("title-match");
      }
      if (a.fingerprint && b.fingerprint && a.fingerprint === b.fingerprint) {
        reasons.push("structural-match");
      }

      if (reasons.length > 0) {
        suggestions.push({
          a: { id: a.id, syntheticPath: a.syntheticPath },
          b: { id: b.id, syntheticPath: b.syntheticPath },
          reasons,
        });
      }
    }
  }
  return suggestions;
}
