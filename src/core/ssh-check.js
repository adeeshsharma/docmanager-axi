import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSettings } from "./settings.js";

// Read-only, on purpose. Generating a new SSH key is a real, system-level
// change to the user's machine - the same class of action as installing
// `git` (ARCHITECTURE.md section 3.2), which already requires the user's
// own explicit approval every time, never taken autonomously. This module
// only ever reads existing key material and probes connectivity; it never
// writes to ~/.ssh and never shells out to ssh-keygen. If no key exists,
// the agent may offer to generate one with the shell access it already
// has, but only after the user says yes - not something docmanager itself
// should own or automate.

const KEY_TYPES = ["id_ed25519", "id_ecdsa", "id_rsa"];

function sshDir() {
  return join(homedir(), ".ssh");
}

function findPublicKeys() {
  return KEY_TYPES.map((name) => join(sshDir(), `${name}.pub`))
    .filter((path) => existsSync(path))
    .map((path) => ({ path, publicKey: readFileSync(path, "utf8").trim() }));
}

// git@github.com:user/repo.git -> github.com
// ssh://git@github.com/user/repo.git -> github.com
export function extractSshHost(url) {
  const scpMatch = url.match(/^[^@/]+@([^:/]+):/);
  if (scpMatch) return scpMatch[1];
  const sshUrlMatch = url.match(/^ssh:\/\/[^@/]+@([^/]+)/);
  if (sshUrlMatch) return sshUrlMatch[1];
  return null;
}

export function isSshRemote(url) {
  return extractSshHost(url) !== null;
}

// GitHub (and most modern git hosts) intentionally deny shell access even
// on a fully successful SSH auth, replying over stderr and exiting non-zero
// regardless - so success has to be read from the message text, not the
// exit code. Real, well-known wording, not something invented here.
export function classifyConnectionOutput(output) {
  if (/successfully authenticated/i.test(output)) return "ok";
  if (/permission denied|could not read from remote repository/i.test(output)) return "failed";
  return "unknown";
}

function testConnection(host) {
  const result = spawnSync("ssh", ["-T", `git@${host}`, "-o", "BatchMode=yes", "-o", "ConnectTimeout=8"], {
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { status: classifyConnectionOutput(output), output };
}

/**
 * Diagnostic snapshot of whether SSH is actually going to work for the
 * currently-configured snapshot remote. Never mutates anything - not the
 * filesystem, not ~/.ssh, not git config.
 */
export function checkSshSetup() {
  const { snapshotRemote } = getSettings();
  const keys = findPublicKeys();

  if (!snapshotRemote) {
    return { remoteConfigured: false, isSshRemote: false, host: null, keys, connection: null };
  }

  const host = extractSshHost(snapshotRemote);
  if (!host) {
    return { remoteConfigured: true, isSshRemote: false, host: null, keys, connection: null };
  }

  const connection = testConnection(host);
  return { remoteConfigured: true, isSshRemote: true, host, keys, connection };
}
