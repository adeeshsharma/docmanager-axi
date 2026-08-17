import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/**
 * Resolves the real, installed lavish-axi CLI entry point via Node's own
 * module resolution - works regardless of how npm laid out node_modules
 * (hoisted or nested), and reads the `bin` field dynamically rather than
 * hardcoding "dist/cli.mjs" in case that ever changes upstream. docmanager
 * carries lavish-axi as a real dependency of its own specifically so this
 * never needs `npx` (and its own network-fallback ambiguity) at runtime -
 * the whole point of "reuse it, don't reinvent it."
 */
export function resolveLavishCli() {
  let pkgPath;
  try {
    pkgPath = require.resolve("lavish-axi/package.json");
  } catch {
    const err = new Error(
      "Could not find the lavish-axi dependency - run `npm install` in the docmanager-axi installation",
    );
    err.code = "LAVISH_NOT_FOUND";
    throw err;
  }

  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const binRelative = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["lavish-axi"];
  if (!binRelative) {
    const err = new Error("lavish-axi is installed but its package.json has no recognizable bin entry");
    err.code = "LAVISH_NOT_FOUND";
    throw err;
  }

  const cliPath = join(dirname(pkgPath), binRelative);
  if (!existsSync(cliPath)) {
    const err = new Error(`lavish-axi's own CLI entry is missing at "${cliPath}"`);
    err.code = "LAVISH_NOT_FOUND";
    throw err;
  }
  return cliPath;
}

// Matches the UI's own downloadFileName() convention exactly (app.js) - one
// naming rule for "a tracked version materialized as a plain file",
// wherever that happens.
export function editFileName(syntheticPath, hash) {
  const base = syntheticPath.replace(/^\/+/, "").replace(/\//g, "-") || "document";
  return `${base}-${hash.slice(0, 8)}.html`;
}
