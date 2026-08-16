import { spawn, spawnSync } from "node:child_process";

export class GitUnavailableError extends Error {
  constructor() {
    super(
      "git is required but was not found on this machine. See the README's setup instructions - " +
        "an agent following them must get your explicit approval before installing anything.",
    );
    this.name = "GitUnavailableError";
    this.code = "GIT_UNAVAILABLE";
  }
}

let checked = false;

export function assertGitAvailable() {
  if (checked) return;
  const result = spawnSync("git", ["--version"], { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    throw new GitUnavailableError();
  }
  checked = true;
}

export function runGit(cwd, args) {
  assertGitAvailable();
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`git ${args.join(" ")} failed (exit ${code}): ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}
