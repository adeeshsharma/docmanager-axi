import { ensureCoreRunning } from "../core/lifecycle.js";

async function request(method, path, body) {
  const { port } = await ensureCoreRunning();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let json = null;
  try {
    json = await res.json();
  } catch {
    // Non-JSON or empty body - fall through, ok/error handled below.
  }

  if (!res.ok) {
    // Surface the server's real error message and code, not just the bare
    // HTTP status - a discarded server error message is a real, documented
    // gotcha from this exact CLI-thin-client-to-a-local-server pattern.
    const message = json?.error ?? `Request to docmanager core failed with status ${res.status}`;
    const err = new Error(message);
    err.code = json?.code;
    err.status = res.status;
    throw err;
  }

  return json;
}

// Separate from request() above on purpose: /content/:hash returns raw HTML
// text, not JSON - request()'s res.json() would throw on it and silently
// swallow the real body (the catch block there exists for a genuinely empty
// response, not this).
async function requestRaw(path) {
  const { port } = await ensureCoreRunning();
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!res.ok) {
    let json = null;
    try {
      json = await res.json();
    } catch {
      // Non-JSON error body - fall through with json still null.
    }
    const message = json?.error ?? `Request to docmanager core failed with status ${res.status}`;
    const err = new Error(message);
    err.code = json?.code;
    err.status = res.status;
    throw err;
  }
  return res.text();
}

export const coreClient = {
  trackDocuments: (paths, as, relink) => request("POST", "/documents/track", { paths, as, relink }),
  untrackDocuments: (ids) => request("POST", "/documents/untrack", { ids }),
  link: (fromId, toId) => request("POST", "/link", { fromId, toId }),
  revertVersion: (id, hash) => request("POST", `/families/${id}/revert`, { hash }),
  deleteVersion: (id, hash) => request("DELETE", `/families/${id}/versions/${encodeURIComponent(hash)}`),
  renameFamily: (id, syntheticPath) => request("POST", `/families/${id}/rename`, { syntheticPath }),
  setFamilyTags: (id, tags) => request("POST", `/families/${id}/tags`, { tags }),
  listFolders: () => request("GET", "/folders"),
  createFolder: (name, parentId) => request("POST", "/folders", { name, parentId }),
  renameFolder: (id, name) => request("POST", `/folders/${id}/rename`, { name }),
  moveFolder: (id, parentId) => request("POST", `/folders/${id}/move`, { parentId }),
  deleteFolder: (id) => request("DELETE", `/folders/${id}`),
  moveDocuments: (ids, folderId) => request("POST", "/documents/move", { ids, folderId }),
  getFamilyDiff: (id, hashA, hashB) =>
    request("GET", `/families/${id}/diff?a=${encodeURIComponent(hashA)}&b=${encodeURIComponent(hashB)}`),
  listFamilies: () => request("GET", "/families"),
  search: (query) => request("GET", `/search?q=${encodeURIComponent(query)}`),
  getFamily: (id) => request("GET", `/families/${id}`),
  getSettings: () => request("GET", "/settings"),
  updateSettings: (patch) => request("PUT", "/settings", patch),
  pushSnapshot: (acknowledgePrivacy = false) => request("POST", "/snapshot/push", { acknowledgePrivacy }),
  pullSnapshot: () => request("POST", "/snapshot/pull"),
  syncSnapshot: (dryRun = false, autoLink = true) => request("POST", "/snapshot/sync", { dryRun, autoLink }),
  runDoctor: () => request("GET", "/doctor"),
  runGc: () => request("POST", "/maintenance/gc"),
  exportContent: (hash) => requestRaw(`/content/${encodeURIComponent(hash)}`),
  checkSsh: () => request("GET", "/ssh-check"),
};
