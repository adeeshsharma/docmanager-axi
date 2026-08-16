import { test } from "node:test";
import assert from "node:assert/strict";
import { useIsolatedHome, cleanupHome } from "./helpers.js";

// Deliberately its own file: git.js caches a successful `assertGitAvailable()`
// check for the process lifetime, and node's test runner gives each test
// *file* its own process - so this is the only place a PATH-stripped
// scenario can be tested without a real git call earlier in the same
// process silently making the cache always pass.
test("a missing git binary produces the structured GIT_UNAVAILABLE error, not a raw failure", async () => {
  const homeDir = useIsolatedHome();
  const originalPath = process.env.PATH;
  try {
    // A directory containing only `node` itself, no `git`.
    process.env.PATH = process.execPath.includes("/") ? process.execPath.split("/").slice(0, -1).join("/") : "";
    const { createFamily } = await import("../src/core/store.js");
    await assert.rejects(
      createFamily({ syntheticPath: "/report", content: Buffer.from("v1") }),
      (err) => err.code === "GIT_UNAVAILABLE",
    );
  } finally {
    process.env.PATH = originalPath;
    cleanupHome(homeDir);
  }
});
