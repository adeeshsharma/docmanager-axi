import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createSkillMarkdown } from "../src/skill.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillPath = join(projectRoot, "skills", "docmanager", "SKILL.md");

const generated = createSkillMarkdown();
const checkOnly = process.argv.includes("--check");

if (checkOnly) {
  if (!existsSync(skillPath) || readFileSync(skillPath, "utf8") !== generated) {
    console.error(`build-skill --check: ${skillPath} is missing or stale - run \`npm run build:skill\``);
    process.exit(1);
  }
  console.log("build-skill --check: up to date");
  process.exit(0);
}

mkdirSync(dirname(skillPath), { recursive: true });
writeFileSync(skillPath, generated);
console.log(`build-skill: wrote ${skillPath}`);
