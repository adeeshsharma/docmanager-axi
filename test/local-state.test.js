import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useIsolatedHome, cleanupHome } from "./helpers.js";
import { addMapping, listMappings, findByRealPath } from "../src/core/local-state.js";

let homeDir;
beforeEach(() => {
  homeDir = useIsolatedHome();
});
afterEach(() => {
  cleanupHome(homeDir);
});

test("addMapping stores linkRoot when provided", () => {
  addMapping({ syntheticPath: "/report", realPath: "/tmp/report.html", familyId: "fam-1", linkRoot: "/tmp" });
  const mapping = findByRealPath("/tmp/report.html");
  assert.equal(mapping.linkRoot, "/tmp");
});

test("addMapping omits linkRoot when not provided, rather than storing it as undefined", () => {
  addMapping({ syntheticPath: "/report", realPath: "/tmp/report.html", familyId: "fam-1" });
  const mapping = findByRealPath("/tmp/report.html");
  assert.equal("linkRoot" in mapping, false);
});
