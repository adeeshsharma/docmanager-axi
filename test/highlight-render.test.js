import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHighlightScript } from "../src/core/highlight-render.js";

test("buildHighlightScript returns null for an empty highlights array", () => {
  assert.equal(buildHighlightScript([]), null);
});

test("buildHighlightScript embeds the highlights as JSON inside a script tag", () => {
  const highlights = [{ id: "abc-123", color: "yellow", startOffset: 0, endOffset: 5, createdAt: "2026-01-01T00:00:00.000Z" }];
  const script = buildHighlightScript(highlights);
  assert.ok(script.startsWith("<script>"));
  assert.ok(script.endsWith("</script>"));
  assert.match(script, /"id":"abc-123"/);
  assert.match(script, /"color":"yellow"/);
  assert.match(script, /"startOffset":0/);
  assert.match(script, /"endOffset":5/);
});

test("buildHighlightScript escapes a literal </script> sequence in the payload so it can never break out of the tag", () => {
  // Not a realistic color/value in practice (color is a fixed enum), but the
  // escaping must hold unconditionally, not just for values docmanager itself
  // would ever produce - defensive by construction, not by trusting the input.
  const highlights = [{ id: "</script><script>evil()", color: "yellow", startOffset: 0, endOffset: 5, createdAt: "x" }];
  const script = buildHighlightScript(highlights);
  assert.ok(!script.slice(8, -9).includes("</script>"), "no literal </script> may appear inside the injected script body");
});
