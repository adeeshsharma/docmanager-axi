import { homedir } from "node:os";
import { join } from "node:path";

// Overridable so multiple independent "machines" can be simulated in tests
// (and so tests never touch the real ~/.docmanager on the dev machine).
export function docmanagerHome() {
  return process.env.DOCMANAGER_HOME || join(homedir(), ".docmanager");
}

export function lockFilePath() {
  return join(docmanagerHome(), "core.lock");
}

export function logFilePath() {
  return join(docmanagerHome(), "core.log");
}
