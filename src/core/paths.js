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

// Working copies materialized for handing a specific version off to an
// external editor (Lavish Editor) - a predictable, docmanager-owned
// location rather than making the caller invent a path. Deliberately
// separate from the store itself: these are disposable scratch files, never
// synced, never part of the content-addressed history.
export function editDir() {
  return join(docmanagerHome(), "edit");
}
