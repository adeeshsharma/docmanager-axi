import { createServer as createHttpServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../version.js";
import { trackPaths, untrackFamilies, renameTrackedDocument } from "./track.js";
import { mergeFamilies, readContent, revertToVersion, deleteVersion, setFamilyTags } from "./store.js";
import { listFolders, getFolder, createFolder, renameFolder, reparentFolder, deleteFolder } from "./folders.js";
import { diffVersions, renderHighlightedContent } from "./diff.js";
import { rebuildIndex, listFamiliesFromIndex, getFamilyFromIndex, searchFamilies } from "./index.js";
import { reconcile } from "./reconcile.js";
import { suggestLinks } from "./suggest.js";
import { runDoctor } from "./doctor.js";
import { runGc } from "./maintenance.js";
import { checkSshSetup } from "./ssh-check.js";
import { getSettings, updateSettings } from "./settings.js";
import { subscribe, unsubscribe, broadcast } from "./events.js";
import { pushSnapshot, pullSnapshot } from "./snapshot.js";
import { syncSnapshot } from "./sync.js";
import { markActivity } from "./activity.js";
import { requestShutdown } from "./shutdown.js";

export const SERVICE_NAME = "docmanager-core";

const CLIENT_ERROR_CODES = new Set([
  "FILE_NOT_FOUND",
  "PATH_ALREADY_MAPPED",
  "FAMILY_PATH_EXISTS",
  "FAMILY_NOT_FOUND",
  "VERSION_NOT_FOUND",
  "CANNOT_DELETE_LAST_VERSION",
  "VERSION_STILL_LIVE",
  "SAME_FAMILY",
  "NO_ROOT_VERSION",
  "UNKNOWN_SETTING",
  "NO_REMOTE_CONFIGURED",
  "NOTHING_TO_PUSH",
  "PUSH_REJECTED",
  "SYNC_CONFLICT",
  "SSH_AUTH_FAILED",
  "CLONE_FAILED",
  "FETCH_FAILED",
  "NO_PATHS",
  "AS_REQUIRES_SINGLE_FILE",
  "BAD_REQUEST",
  "PRIVACY_NOT_ACKNOWLEDGED",
  "NOTHING_TO_CLEAN",
  "FOLDER_NOT_FOUND",
  "FOLDER_NOT_EMPTY",
  "FOLDER_CYCLE",
]);

function statusForError(err) {
  return CLIENT_ERROR_CODES.has(err.code) ? 400 : 500;
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("Request body is not valid JSON"), { code: "BAD_REQUEST" }));
      }
    });
    req.on("error", reject);
  });
}

function redactSettings(settings) {
  const { snapshotRemoteToken, ...rest } = settings;
  return { ...rest, snapshotRemoteTokenSet: Boolean(snapshotRemoteToken) };
}

async function reconcileAndMaybeRebuild() {
  const results = await reconcile();
  if (results.some((r) => r.status === "new-version-captured")) {
    rebuildIndex();
    broadcast("families-changed");
  }
  return results;
}

const ROUTES = [
  {
    method: "GET",
    pattern: /^\/health$/,
    handler: async () => ({
      status: 200,
      body: { service: SERVICE_NAME, version: VERSION, pid: process.pid },
    }),
  },
  {
    method: "GET",
    pattern: /^\/families$/,
    handler: async () => {
      const reconciled = await reconcileAndMaybeRebuild();
      return {
        status: 200,
        body: { families: listFamiliesFromIndex(), reconciled, suggestedLinks: suggestLinks() },
      };
    },
  },
  {
    method: "GET",
    pattern: /^\/families\/([^/]+)$/,
    handler: async (req, match) => {
      await reconcileAndMaybeRebuild();
      const family = getFamilyFromIndex(match[1]);
      if (!family) {
        return {
          status: 404,
          body: { error: `No family with id "${match[1]}"`, code: "FAMILY_NOT_FOUND" },
        };
      }
      return { status: 200, body: { family } };
    },
  },
  {
    method: "POST",
    pattern: /^\/documents\/track$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      if (!Array.isArray(body.paths) || body.paths.length === 0) {
        return { status: 400, body: { error: "paths (a non-empty array) is required" } };
      }
      const { results, summary } = await trackPaths(body.paths, {
        as: body.as,
        relink: body.relink,
      });
      if (summary.trackedCount > 0 || summary.relinkedCount > 0) {
        rebuildIndex();
        broadcast("families-changed");
      }
      return { status: 200, body: { results, summary } };
    },
  },
  {
    method: "POST",
    pattern: /^\/documents\/untrack$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      if (!Array.isArray(body.ids) || body.ids.length === 0) {
        return { status: 400, body: { error: "ids (a non-empty array) is required" } };
      }
      const { results, summary } = await untrackFamilies(body.ids);
      if (summary.untrackedCount > 0) {
        rebuildIndex();
        broadcast("families-changed");
      }
      return { status: 200, body: { results, summary } };
    },
  },
  {
    method: "POST",
    pattern: /^\/families\/([^/]+)\/revert$/,
    handler: async (req, match) => {
      const body = await readJsonBody(req);
      if (!body.hash) {
        return { status: 400, body: { error: "hash is required" } };
      }
      const { changed } = await revertToVersion(match[1], body.hash);
      if (changed) {
        rebuildIndex();
        broadcast("families-changed");
      }
      // Returned in the same shape GET /families/:id already uses (an
      // array of versions, not store.js's raw hash-keyed object) - the UI
      // renders this response directly rather than always re-fetching, so
      // the shape has to match what renderTimeline()/populateCompareSelects()
      // actually expect.
      return { status: 200, body: { changed, family: getFamilyFromIndex(match[1]) } };
    },
  },
  {
    method: "POST",
    pattern: /^\/families\/([^/]+)\/rename$/,
    handler: async (req, match) => {
      const body = await readJsonBody(req);
      if (!body.syntheticPath || typeof body.syntheticPath !== "string") {
        return { status: 400, body: { error: "syntheticPath is required" } };
      }
      const { changed } = await renameTrackedDocument(match[1], body.syntheticPath);
      if (changed) {
        rebuildIndex();
        broadcast("families-changed");
      }
      // Same reasoning as the revert/delete-version routes: return the
      // index-derived, array-shaped family the UI renders directly.
      return { status: 200, body: { changed, family: getFamilyFromIndex(match[1]) } };
    },
  },
  {
    method: "POST",
    pattern: /^\/families\/([^/]+)\/tags$/,
    handler: async (req, match) => {
      const body = await readJsonBody(req);
      if (!Array.isArray(body.tags)) {
        return { status: 400, body: { error: "tags (an array) is required" } };
      }
      await setFamilyTags(match[1], body.tags);
      rebuildIndex();
      broadcast("families-changed");
      return { status: 200, body: { family: getFamilyFromIndex(match[1]) } };
    },
  },
  {
    method: "GET",
    pattern: /^\/folders$/,
    handler: async () => ({ status: 200, body: { folders: listFolders() } }),
  },
  {
    method: "POST",
    pattern: /^\/folders$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      if (!body.name || typeof body.name !== "string") {
        return { status: 400, body: { error: "name is required" } };
      }
      const folder = await createFolder({ name: body.name, parentId: body.parentId ?? null });
      broadcast("families-changed");
      return { status: 200, body: { folder } };
    },
  },
  {
    method: "POST",
    pattern: /^\/folders\/([^/]+)\/rename$/,
    handler: async (req, match) => {
      const body = await readJsonBody(req);
      if (!body.name || typeof body.name !== "string") {
        return { status: 400, body: { error: "name is required" } };
      }
      const { changed, folder } = await renameFolder(match[1], body.name);
      if (changed) broadcast("families-changed");
      return { status: 200, body: { changed, folder } };
    },
  },
  {
    method: "POST",
    pattern: /^\/folders\/([^/]+)\/move$/,
    handler: async (req, match) => {
      const body = await readJsonBody(req);
      const { changed, folder } = await reparentFolder(match[1], body.parentId ?? null);
      if (changed) broadcast("families-changed");
      return { status: 200, body: { changed, folder } };
    },
  },
  {
    method: "DELETE",
    pattern: /^\/folders\/([^/]+)$/,
    handler: async (req, match) => {
      const folder = await deleteFolder(match[1]);
      broadcast("families-changed");
      return { status: 200, body: { folder } };
    },
  },
  {
    method: "DELETE",
    pattern: /^\/families\/([^/]+)\/versions\/([^/]+)$/,
    handler: async (req, match) => {
      await deleteVersion(match[1], match[2]);
      rebuildIndex();
      broadcast("families-changed");
      // Same reasoning as the revert route above: return the index-derived,
      // array-shaped family the UI actually renders directly, not
      // store.js's raw hash-keyed object.
      return { status: 200, body: { family: getFamilyFromIndex(match[1]) } };
    },
  },
  {
    method: "GET",
    pattern: /^\/families\/([^/]+)\/diff$/,
    handler: async (req, match) => {
      const url = new URL(req.url, "http://localhost");
      const a = url.searchParams.get("a");
      const b = url.searchParams.get("b");
      if (!a || !b) {
        return { status: 400, body: { error: "query params a and b (both version hashes) are required" } };
      }
      return { status: 200, body: diffVersions(match[1], a, b) };
    },
  },
  {
    method: "POST",
    pattern: /^\/link$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      if (!body.fromId || !body.toId) {
        return { status: 400, body: { error: "fromId and toId are both required" } };
      }
      const family = await mergeFamilies(body.fromId, body.toId);
      rebuildIndex();
      broadcast("families-changed");
      return { status: 200, body: { family } };
    },
  },
  {
    method: "GET",
    pattern: /^\/search$/,
    handler: async (req) => {
      await reconcileAndMaybeRebuild();
      const url = new URL(req.url, "http://localhost");
      const q = url.searchParams.get("q") ?? "";
      return { status: 200, body: { results: searchFamilies(q) } };
    },
  },
  {
    method: "GET",
    pattern: /^\/doctor$/,
    handler: async () => ({ status: 200, body: await runDoctor() }),
  },
  {
    method: "POST",
    pattern: /^\/maintenance\/gc$/,
    handler: async () => ({ status: 200, body: await runGc() }),
  },
  {
    method: "GET",
    pattern: /^\/ssh-check$/,
    handler: async () => ({ status: 200, body: checkSshSetup() }),
  },
  // A secret with nowhere good to go once it's left this machine's own
  // settings file - never echo the real token back over the read API,
  // only whether one is currently configured. settings.js itself stores
  // and returns it plainly (snapshot.js needs the real value to actually
  // authenticate); this is the actual redaction boundary.
  {
    method: "GET",
    pattern: /^\/settings$/,
    handler: async () => ({ status: 200, body: redactSettings(getSettings()) }),
  },
  {
    method: "PUT",
    pattern: /^\/settings$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      return { status: 200, body: redactSettings(updateSettings(body)) };
    },
  },
  {
    method: "POST",
    pattern: /^\/snapshot\/push$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      return { status: 200, body: await pushSnapshot({ acknowledgePrivacy: Boolean(body.acknowledgePrivacy) }) };
    },
  },
  {
    method: "POST",
    pattern: /^\/snapshot\/pull$/,
    handler: async () => {
      // pullSnapshot() already rebuilds the index itself (both the clone
      // and merge paths change the store) - just broadcast here.
      const result = await pullSnapshot();
      broadcast("families-changed");
      return { status: 200, body: result };
    },
  },
  {
    method: "POST",
    pattern: /^\/snapshot\/sync$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      const result = await syncSnapshot({
        dryRun: Boolean(body.dryRun),
        autoLink: body.autoLink !== false,
      });
      // syncSnapshot() already rebuilds the index itself for anything it
      // actually persists - a dry run changes nothing, so no broadcast.
      if (!body.dryRun) broadcast("families-changed");
      return { status: 200, body: result };
    },
  },
  {
    method: "POST",
    pattern: /^\/core\/stop$/,
    handler: async () => {
      // The response has to actually reach the client before this process
      // starts closing connections out from under it - requestShutdown()
      // runs on the next tick, after sendJson() has hand off the response
      // bytes to the socket.
      setImmediate(() => requestShutdown("ui-requested"));
      return { status: 200, body: { stopping: true } };
    },
  },
];

const SSE_HEARTBEAT_INTERVAL_MS = Number(process.env.DOCMANAGER_SSE_HEARTBEAT_INTERVAL_MS) || 20000;

// SSE - kept separate from ROUTES since it takes over the response instead
// of returning a JSON body.
function handleEvents(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(":\n\n"); // establish the stream immediately
  subscribe(res);

  // Without traffic, a connection can sit completely silent for as long as
  // the browser tab stays open and nothing changes - real idle-connection
  // timeouts (browser, OS, a local proxy) can and do close a truly silent
  // stream. A periodic comment line keeps bytes flowing so nothing in the
  // path between browser and server ever has a reason to think it's dead.
  const heartbeat = setInterval(() => {
    res.write(":\n\n");
    // An open, connected UI tab is a real signal of use even with no new
    // requests in between - each heartbeat tick counts as activity so the
    // idle timeout never fires while a tab is genuinely still open.
    markActivity();
  }, SSE_HEARTBEAT_INTERVAL_MS);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe(res);
  });
}

// A content hash comes straight from the URL, untrusted input, and
// store.js's readContent() builds a filesystem path from it with no
// validation of its own - a strict format check here is what actually
// stops a path-traversal attempt before it ever reaches the filesystem,
// not just a nicety. Real sha256 output is 64 lowercase hex characters,
// nothing else is ever a legitimate hash.
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

// Also kept separate from ROUTES: this serves raw HTML bytes for the
// reading pane's iframe to load, not a JSON body.
function handleContent(hash, res) {
  if (!CONTENT_HASH_PATTERN.test(hash)) {
    sendJson(res, 400, { error: "invalid content hash", code: "INVALID_CONTENT_HASH" });
    return;
  }
  const content = readContent(hash);
  if (!content) {
    sendJson(res, 404, { error: `No content for hash "${hash}"`, code: "CONTENT_NOT_FOUND" });
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(content);
}

// Serves one version's content annotated with block-level highlighting
// against another version, for the UI's side-by-side rendered comparison -
// raw HTML, same reasoning as handleContent() above, not a JSON body.
function handleContentDiff(hash, otherHash, mode, res) {
  if (!CONTENT_HASH_PATTERN.test(hash) || !CONTENT_HASH_PATTERN.test(otherHash)) {
    sendJson(res, 400, { error: "invalid content hash" });
    return;
  }
  if (mode !== "removed" && mode !== "added") {
    sendJson(res, 400, { error: "mode must be 'removed' or 'added'" });
    return;
  }
  const content = readContent(hash);
  const otherContent = readContent(otherHash);
  if (!content || !otherContent) {
    sendJson(res, 404, { error: "no content for one or both hashes" });
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(renderHighlightedContent(content, otherContent, mode));
}

function projectRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function uiAssetsDir() {
  const dist = join(projectRoot(), "dist", "ui");
  return existsSync(dist) ? dist : join(projectRoot(), "src", "ui");
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const STATIC_FILES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/style.css": "style.css",
};

function serveStatic(pathname, res) {
  const file = STATIC_FILES[pathname];
  if (!file) return false;
  const fullPath = join(uiAssetsDir(), file);
  if (!existsSync(fullPath)) return false;
  res.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(fullPath));
  return true;
}

// Loopback binding alone does not stop another origin (a browser tab on the
// same machine) from reaching this server - only the UI's own origin, served
// from this same server, is allowed to send an Origin header at all.
// Requests with no Origin header (the CLI's own HTTP client) are accepted.
export function createServer() {
  const server = createHttpServer(async (req, res) => {
    markActivity();
    const address = server.address();
    const allowedOrigin =
      address && typeof address === "object" ? `http://127.0.0.1:${address.port}` : null;
    const origin = req.headers.origin;
    if (origin && origin !== allowedOrigin) {
      sendJson(res, 403, { error: "origin not allowed" });
      return;
    }

    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && url.pathname === "/events") {
      handleEvents(req, res);
      return;
    }

    const contentDiffMatch =
      req.method === "GET" && url.pathname.match(/^\/content\/([^/]+)\/diff-against\/([^/]+)$/);
    if (contentDiffMatch) {
      handleContentDiff(contentDiffMatch[1], contentDiffMatch[2], url.searchParams.get("mode"), res);
      return;
    }

    const contentMatch = req.method === "GET" && url.pathname.match(/^\/content\/([^/]+)$/);
    if (contentMatch) {
      handleContent(contentMatch[1], res);
      return;
    }

    if (req.method === "GET" && serveStatic(url.pathname, res)) {
      return;
    }

    const route = ROUTES.find((r) => r.method === req.method && r.pattern.test(url.pathname));
    if (!route) {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    try {
      const match = url.pathname.match(route.pattern);
      const { status, body } = await route.handler(req, match);
      sendJson(res, status, body);
    } catch (err) {
      sendJson(res, statusForError(err), { error: err.message, code: err.code });
    }
  });
  return server;
}
