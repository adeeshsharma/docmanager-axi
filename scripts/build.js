import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The UI has no framework and no bundler - "build" is just copying the
// static assets into dist/ui, which server.js prefers over src/ui when it
// exists (see server.js's uiAssetsDir()). Keeping this a plain file copy is
// deliberate: it means publishing never depends on a bundler toolchain that
// isn't otherwise needed anywhere else in this project.
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcUi = join(projectRoot, "src", "ui");
const distUi = join(projectRoot, "dist", "ui");

if (!existsSync(srcUi)) {
  console.error(`build: ${srcUi} does not exist`);
  process.exit(1);
}

rmSync(distUi, { recursive: true, force: true });
mkdirSync(distUi, { recursive: true });
cpSync(srcUi, distUi, { recursive: true });

console.log(`build: copied ${srcUi} -> ${distUi}`);
