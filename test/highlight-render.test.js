import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHighlightScript } from "../src/core/highlight-render.js";

test("buildHighlightScript still returns a real script for an empty highlights array - selection/creation must work on a document with none yet", () => {
  const script = buildHighlightScript({ familyId: "fam-1", hash: "hash-1", highlights: [] });
  assert.ok(script.startsWith("<script>"));
  assert.match(script, /docmanager-highlight-create/);
});

test("buildHighlightScript treats undefined the same as an empty array", () => {
  const script = buildHighlightScript({ familyId: "fam-1", hash: "hash-1", highlights: undefined });
  assert.ok(script.startsWith("<script>"));
  assert.match(script, /HIGHLIGHTS = \[\]/);
});

test("buildHighlightScript tolerates being called with no arguments at all", () => {
  const script = buildHighlightScript();
  assert.ok(script.startsWith("<script>"));
  assert.match(script, /HIGHLIGHTS = \[\]/);
});

test("buildHighlightScript embeds the highlights as JSON inside a script tag", () => {
  const highlights = [{ id: "abc-123", color: "yellow", startOffset: 0, endOffset: 5, createdAt: "2026-01-01T00:00:00.000Z" }];
  const script = buildHighlightScript({ familyId: "fam-1", hash: "hash-1", highlights });
  assert.ok(script.startsWith("<script>"));
  assert.ok(script.endsWith("</script>"));
  assert.match(script, /"id":"abc-123"/);
  assert.match(script, /"color":"yellow"/);
  assert.match(script, /"startOffset":0/);
  assert.match(script, /"endOffset":5/);
});

test("buildHighlightScript escapes a literal </script> sequence in the highlights payload so it can never break out of the tag", () => {
  // Not a realistic color/value in practice (color is a fixed enum), but the
  // escaping must hold unconditionally, not just for values docmanager itself
  // would ever produce - defensive by construction, not by trusting the input.
  const highlights = [{ id: "</script><script>evil()", color: "yellow", startOffset: 0, endOffset: 5, createdAt: "x" }];
  const script = buildHighlightScript({ familyId: "fam-1", hash: "hash-1", highlights });
  assert.ok(!script.slice(8, -9).includes("</script>"), "no literal </script> may appear inside the injected script body");
});

test("buildHighlightScript escapes a literal </script> sequence in familyId/hash the same way", () => {
  const script = buildHighlightScript({ familyId: "</script><script>evil()", hash: "</script>", highlights: [] });
  assert.ok(!script.slice(8, -9).includes("</script>"), "no literal </script> may appear inside the injected script body");
});

test("buildHighlightScript embeds familyId and hash so a standalone tab can call the highlight API directly", () => {
  const script = buildHighlightScript({ familyId: "fam-42", hash: "hash-99", highlights: [] });
  assert.match(script, /FAMILY_ID = "fam-42"/);
  assert.match(script, /HASH = "hash-99"/);
});

test("buildHighlightScript's remove handler unwraps every <mark> sharing a highlight's id, not just the one hovered", () => {
  // A highlight spanning more than one text node (e.g. a selection that
  // crosses a whitespace/newline text node between block elements) produces
  // multiple <mark> elements sharing one id - found via manual testing:
  // hovering/clicking one left the others behind client-side until reload.
  const script = buildHighlightScript({ familyId: "fam-1", hash: "hash-1", highlights: [] });
  assert.match(script, /document\.querySelectorAll\('mark\[data-docmanager-highlight-id="' \+ id \+ '"\]'\)/);
});

test("buildHighlightScript's create/remove paths branch on window.parent === window (standalone tab vs. embedded iframe)", () => {
  const script = buildHighlightScript({ familyId: "fam-1", hash: "hash-1", highlights: [] });
  assert.match(script, /STANDALONE = window\.parent === window/);
  // Both the direct-fetch path (standalone) and the postMessage path (embedded) must be present -
  // this is a runtime branch, not two separate build modes.
  assert.match(script, /fetch\(highlightsUrl/);
  assert.match(script, /parent\.postMessage\(\{ source: 'docmanager-highlight-create'/);
  assert.match(script, /parent\.postMessage\(\{ source: 'docmanager-highlight-remove'/);
});
