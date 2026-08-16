import open from "open";
import { runAxiCli, AxiError, installSessionStartHooks } from "axi-sdk-js";
import { VERSION } from "./version.js";
import { ensureCoreRunning, coreStatus, stopCore } from "./core/lifecycle.js";
import { coreClient } from "./cli/client.js";

const TOP_LEVEL_HELP = `docmanager - manage and version HTML documents on your local machine

Usage:
  docmanager                          Show tracked documents and current state
  docmanager track <path>... [--as <p>] [--relink]
                                       Start tracking one or more files and/or folders (folders
                                       are tracked recursively). --as only applies to a single
                                       file. --relink connects to an existing family pulled from
                                       a snapshot with no local mapping yet
  docmanager link <fromId> <toId>     Declare that toId supersedes fromId
  docmanager untrack <id>...          Stop tracking one or more documents (does not delete the real files)
  docmanager families                 List tracked document families
  docmanager families view <id>       Show one family's version history
  docmanager families diff <id> <hashA> <hashB>
                                       Show what changed between two versions
  docmanager families revert <id> <hash>
                                       Make an older version current again (docmanager's history only -
                                       never touches the real file on disk)
  docmanager families delete-version <id> <hash>
                                       Permanently remove one version's record (not the whole document -
                                       see untrack for that). Refuses on a family's only remaining version
  docmanager families rename <id> <newSyntheticPath>
                                       Change a tracked document's synthetic path, keeping its full history
  docmanager families tags <id> [--set "a,b"] [--add <tag>] [--remove <tag>]
                                       View or change a family's tags (no flags shows current tags)
  docmanager status                   Reconcile and show current tracked state
  docmanager search <query>           Keyword search over tracked documents' titles and text (current
                                       version only, not semantic search)
  docmanager settings get             Show current settings
  docmanager settings set --snapshot-remote <url>   Set the snapshot git remote
  docmanager snapshot push            Push the local store to the snapshot remote
  docmanager snapshot pull            Pull the snapshot remote (clones fresh on a new machine)
  docmanager ui                       Open the local web UI
  docmanager setup hooks              Install session-start ambient context for your agent
  docmanager setup ssh                Check whether SSH auth actually works for an SSH-style snapshot
                                       remote (read-only - never generates a key on its own)
  docmanager core start|status|stop   Manage the core service directly
  docmanager doctor                   Check git/store/index/local-state health, auto-repair what's safe to
  docmanager --version                Print the version
  docmanager --help                   Show this help`;

function parseFlags(args, allowedFlags, booleanFlags = []) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (!allowedFlags.includes(name)) {
        throw new AxiError(`unknown flag --${name}`, "VALIDATION_ERROR", [
          `valid flags: ${allowedFlags.map((f) => `--${f}`).join(", ") || "(none)"}`,
        ]);
      }
      if (booleanFlags.includes(name)) {
        flags[name] = true;
      } else {
        flags[name] = args[i + 1];
        i++;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function familySummary(family) {
  return {
    id: family.id,
    syntheticPath: family.syntheticPath,
    title: family.title,
    versionCount: family.versionCount ?? Object.keys(family.versions ?? {}).length,
    headVersion: family.headVersion,
    ...(family.tags && family.tags.length > 0 ? { tags: family.tags } : {}),
  };
}

// Translates errors surfaced from the core (real codes/messages, per
// client.js) into AxiError so they get the SDK's structured rendering and a
// non-zero exit code, instead of collapsing into a generic "UNKNOWN" code -
// runAxiCli only special-cases errors that are genuinely AxiError instances.
const ERROR_SUGGESTIONS = {
  FILE_NOT_FOUND: ["Check the path and try again"],
  PATH_ALREADY_MAPPED: ["Run `docmanager families` to see what it's already tracked as"],
  FAMILY_PATH_EXISTS: ["Choose a different --as synthetic path, or link to the existing family instead"],
  FAMILY_NOT_FOUND: ["Run `docmanager families` to see valid ids"],
  VERSION_NOT_FOUND: ["Run `docmanager families view <id>` to see valid version hashes"],
  CANNOT_DELETE_LAST_VERSION: ["Run `docmanager untrack <id>` to stop tracking the whole document instead"],
  SAME_FAMILY: ["fromId and toId must be two different families"],
  NO_ROOT_VERSION: ["Run `docmanager families view <id>` to inspect the family first"],
  NO_REMOTE_CONFIGURED: ["Run `docmanager settings set --snapshot-remote <url>` first"],
  NO_PATHS: ["docmanager track <path>... [--as <syntheticPath>] [--relink]"],
  AS_REQUIRES_SINGLE_FILE: ["--as only works when tracking exactly one file, drop it for folders or multiple paths"],
  NOTHING_TO_PUSH: ["Run `docmanager track <path>` first"],
  PUSH_REJECTED: ["Run `docmanager snapshot pull` first, then push again"],
  SYNC_CONFLICT: ["Resolve the conflict directly with git in ~/.docmanager/store, then pull again"],
  SSH_AUTH_FAILED: ["Run `docmanager setup ssh` to check your SSH key setup for this remote"],
  CLONE_FAILED: ["Run `docmanager setup ssh` if this is an SSH remote, or check the URL and your network connection"],
  FETCH_FAILED: ["Run `docmanager setup ssh` if this is an SSH remote, or check the URL and your network connection"],
};

function toAxiError(err) {
  if (err instanceof AxiError) return err;
  return new AxiError(err.message, err.code ?? "UNKNOWN", ERROR_SUGGESTIONS[err.code] ?? []);
}

async function coreCommand(args) {
  const [sub] = args;

  if (sub === "start") {
    const { pid, port } = await ensureCoreRunning();
    return {
      core: "running",
      pid,
      port,
      help: ["Run `docmanager core status` to check again", "Run `docmanager core stop` to stop it"],
    };
  }

  if (sub === "status") {
    const result = await coreStatus();
    if (result.running) {
      return {
        core: "running",
        pid: result.pid,
        port: result.port,
        ...(result.stale
          ? {
              note: `running an older version (${result.version}) than this CLI (${VERSION}) - it will restart itself automatically the next time any docmanager command needs it`,
            }
          : {}),
      };
    }
    return { core: "not running", help: ["Run `docmanager core start` to start it"] };
  }

  if (sub === "stop") {
    const result = await stopCore();
    if (result.stopped) {
      return { core: "stopped", pid: result.pid };
    }
    return { core: "already stopped" };
  }

  throw new AxiError(`Unknown core command: ${sub ?? "(none)"}`, "VALIDATION_ERROR", [
    "docmanager core start|status|stop",
  ]);
}

async function trackCommand(args) {
  const { flags, positional } = parseFlags(args, ["as", "relink"], ["relink"]);
  if (positional.length === 0) {
    throw new AxiError("at least one path is required", "VALIDATION_ERROR", [
      "docmanager track <path>... [--as <syntheticPath>] [--relink]",
    ]);
  }

  let results, summary;
  try {
    ({ results, summary } = await coreClient.trackDocuments(positional, flags.as, flags.relink));
  } catch (err) {
    throw toAxiError(err);
  }

  // The overwhelmingly common case is one path, one file, no error - keep
  // that simple and direct instead of a batch summary nobody needs to read
  // for it.
  if (positional.length === 1 && results.length === 1) {
    const [r] = results;
    if (r.status !== "error" && r.status !== "no-html-files-found") {
      return {
        tracked: r.family.syntheticPath,
        id: r.family.id,
        ...(r.status === "already-tracked" ? { note: "already tracked, no changes made" } : {}),
        ...(r.status === "relinked" ? { note: "relinked to an existing family from a snapshot" } : {}),
        help: [
          "Run `docmanager families` to see all tracked documents",
          `Run \`docmanager families view ${r.family.id}\` for its version history`,
        ],
      };
    }
  }

  const tracked = results.filter((r) => r.status === "tracked");
  const alreadyTracked = results.filter((r) => r.status === "already-tracked");
  const relinked = results.filter((r) => r.status === "relinked");
  const noHtmlFilesFound = results.filter((r) => r.status === "no-html-files-found");
  const errors = results.filter((r) => r.status === "error");

  const output = {
    summary: `${summary.trackedCount} tracked, ${summary.alreadyTrackedCount} already tracked, ${summary.relinkedCount} relinked, ${summary.errorCount} failed`,
    help: ["Run `docmanager families` to see all tracked documents"],
  };
  if (tracked.length > 0) output.tracked = tracked.map((r) => r.family.syntheticPath);
  if (alreadyTracked.length > 0) output.alreadyTracked = alreadyTracked.map((r) => r.family.syntheticPath);
  if (relinked.length > 0) output.relinked = relinked.map((r) => r.family.syntheticPath);
  if (noHtmlFilesFound.length > 0) output.noHtmlFilesFound = noHtmlFilesFound.map((r) => r.path);
  if (errors.length > 0) output.errors = errors.map((r) => ({ path: r.path, error: r.error, code: r.code }));
  return output;
}

async function untrackCommand(args) {
  const { positional } = parseFlags(args, []);
  if (positional.length === 0) {
    throw new AxiError("at least one id is required", "VALIDATION_ERROR", [
      "docmanager untrack <id>...",
      "Run `docmanager families` to see valid ids",
    ]);
  }

  let results, summary;
  try {
    ({ results, summary } = await coreClient.untrackDocuments(positional));
  } catch (err) {
    throw toAxiError(err);
  }

  const untracked = results.filter((r) => r.status === "untracked");
  const errors = results.filter((r) => r.status === "error");

  const output = {
    summary: `${summary.untrackedCount} untracked, ${summary.errorCount} failed`,
    help: ["Run `docmanager families` to see what's still tracked"],
  };
  if (untracked.length > 0) output.untracked = untracked.map((r) => r.syntheticPath);
  if (errors.length > 0) output.errors = errors.map((r) => ({ id: r.id, error: r.error, code: r.code }));
  return output;
}

async function linkCommand(args) {
  const { positional } = parseFlags(args, []);
  const [fromId, toId] = positional;
  if (!fromId || !toId) {
    throw new AxiError("fromId and toId are both required", "VALIDATION_ERROR", [
      "docmanager link <fromId> <toId>  (toId supersedes fromId)",
    ]);
  }

  let family;
  try {
    ({ family } = await coreClient.link(fromId, toId));
  } catch (err) {
    throw toAxiError(err);
  }
  return {
    linked: true,
    family: familySummary(family),
    help: [`Run \`docmanager families view ${family.id}\` to see the merged version history`],
  };
}

// Detail views can legitimately be large - truncate rather than either
// silently dumping unbounded terminal output or refusing to show anything,
// matching this project's own AXI output discipline elsewhere.
const DIFF_TEXT_MAX_CHARS = 4000;

function formatDiffText(parts) {
  const lines = [];
  for (const part of parts) {
    const prefix = part.added ? "+ " : part.removed ? "- " : "  ";
    for (const line of part.value.split("\n")) {
      if (line.length > 0) lines.push(prefix + line);
    }
  }
  const text = lines.join("\n");
  if (text.length <= DIFF_TEXT_MAX_CHARS) return text;
  return `${text.slice(0, DIFF_TEXT_MAX_CHARS)}\n... (truncated, ${text.length} chars total)`;
}

async function familiesCommand(args) {
  const [sub, id] = args;

  if (sub === "view") {
    if (!id) {
      throw new AxiError("id is required", "VALIDATION_ERROR", ["docmanager families view <id>"]);
    }
    let family;
    try {
      ({ family } = await coreClient.getFamily(id));
    } catch (err) {
      throw toAxiError(err);
    }
    return {
      family: {
        id: family.id,
        syntheticPath: family.syntheticPath,
        title: family.title,
        headVersion: family.headVersion,
        tags: family.tags ?? [],
      },
      versions: family.versions,
    };
  }

  if (sub === "revert") {
    const hash = args[2];
    if (!id || !hash) {
      throw new AxiError("id and hash are both required", "VALIDATION_ERROR", [
        "docmanager families revert <id> <hash>",
        "Run `docmanager families view <id>` to see valid hashes",
      ]);
    }
    let changed, family;
    try {
      ({ changed, family } = await coreClient.revertVersion(id, hash));
    } catch (err) {
      throw toAxiError(err);
    }
    return {
      reverted: changed,
      ...(changed ? {} : { note: "already at this version, no changes made" }),
      family: familySummary(family),
      help: [
        `Run \`docmanager families view ${family.id}\` to see the full history`,
        "This only changes docmanager's own history - the real file on disk is never touched",
      ],
    };
  }

  if (sub === "delete-version") {
    const hash = args[2];
    if (!id || !hash) {
      throw new AxiError("id and hash are both required", "VALIDATION_ERROR", [
        "docmanager families delete-version <id> <hash>",
        "Run `docmanager families view <id>` to see valid hashes",
      ]);
    }
    let family;
    try {
      ({ family } = await coreClient.deleteVersion(id, hash));
    } catch (err) {
      throw toAxiError(err);
    }
    return {
      deleted: hash,
      family: familySummary(family),
      help: [
        `Run \`docmanager families view ${family.id}\` to see the remaining history`,
        "The underlying content is not deleted from the store, only this version's own record",
      ],
    };
  }

  if (sub === "rename") {
    const newSyntheticPath = args[2];
    if (!id || !newSyntheticPath) {
      throw new AxiError("id and newSyntheticPath are both required", "VALIDATION_ERROR", [
        "docmanager families rename <id> <newSyntheticPath>",
      ]);
    }
    let changed, family;
    try {
      ({ changed, family } = await coreClient.renameFamily(id, newSyntheticPath));
    } catch (err) {
      throw toAxiError(err);
    }
    return {
      renamed: changed,
      ...(changed ? {} : { note: "already at this synthetic path, no changes made" }),
      family: familySummary(family),
      help: [`Run \`docmanager families view ${family.id}\` to confirm`],
    };
  }

  if (sub === "tags") {
    if (!id) {
      throw new AxiError("id is required", "VALIDATION_ERROR", [
        'docmanager families tags <id> [--set "a,b"] [--add <tag>] [--remove <tag>]',
      ]);
    }
    const { flags } = parseFlags(args.slice(2), ["set", "add", "remove"]);

    let family;
    try {
      ({ family } = await coreClient.getFamily(id));
    } catch (err) {
      throw toAxiError(err);
    }

    if (flags.set === undefined && flags.add === undefined && flags.remove === undefined) {
      return { family: { id: family.id, syntheticPath: family.syntheticPath }, tags: family.tags ?? [] };
    }

    let tags = family.tags ?? [];
    if (flags.set !== undefined) {
      tags = flags.set
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
    }
    if (flags.add !== undefined && !tags.includes(flags.add)) {
      tags = [...tags, flags.add];
    }
    if (flags.remove !== undefined) {
      tags = tags.filter((t) => t !== flags.remove);
    }

    try {
      ({ family } = await coreClient.setFamilyTags(id, tags));
    } catch (err) {
      throw toAxiError(err);
    }
    return {
      family: { id: family.id, syntheticPath: family.syntheticPath },
      tags: family.tags,
    };
  }

  if (sub === "diff") {
    const hashA = args[2];
    const hashB = args[3];
    if (!id || !hashA || !hashB) {
      throw new AxiError("id, hashA, and hashB are all required", "VALIDATION_ERROR", [
        "docmanager families diff <id> <hashA> <hashB>",
        "Run `docmanager families view <id>` to see valid hashes",
      ]);
    }
    let diffResult;
    try {
      diffResult = await coreClient.getFamilyDiff(id, hashA, hashB);
    } catch (err) {
      throw toAxiError(err);
    }
    const hasChanges = diffResult.parts.some((p) => p.added || p.removed);
    return {
      family: diffResult.family,
      from: diffResult.from,
      to: diffResult.to,
      diff: hasChanges ? formatDiffText(diffResult.parts) : "no differences (both versions normalize to the same content)",
    };
  }

  if (sub !== undefined) {
    throw new AxiError(`Unknown families command: ${sub}`, "VALIDATION_ERROR", [
      "docmanager families",
      "docmanager families view <id>",
      "docmanager families diff <id> <hashA> <hashB>",
      "docmanager families revert <id> <hash>",
      "docmanager families delete-version <id> <hash>",
      "docmanager families rename <id> <newSyntheticPath>",
      'docmanager families tags <id> [--set "a,b"] [--add <tag>] [--remove <tag>]',
    ]);
  }

  const { families, reconciled, suggestedLinks } = await coreClient.listFamilies();
  if (families.length === 0) {
    return {
      families: "0 tracked documents found",
      help: ["Run `docmanager track <path>` to start tracking a document"],
    };
  }

  const changed = reconciled.filter((r) => r.status === "new-version-captured");
  const missing = reconciled.filter((r) => r.status === "missing");
  const behindHead = reconciled.filter((r) => r.status === "behind-head");
  const corrupt = reconciled.filter((r) => r.status === "corrupt");
  const orphanedMapping = reconciled.filter((r) => r.status === "orphaned-mapping");
  const result = {
    count: `${families.length} tracked`,
    families: families.map(familySummary),
    help: [
      "Run `docmanager families view <id>` for a family's version history",
      "Run `docmanager track <path>` to track another document",
    ],
  };
  if (changed.length > 0) {
    result.newVersionsCaptured = changed.map((r) => r.syntheticPath);
  }
  if (missing.length > 0) {
    result.missingOnDisk = missing.map((r) => r.syntheticPath);
  }
  if (behindHead.length > 0) {
    result.behindHead = behindHead.map((r) => r.syntheticPath);
    result.help.push(
      "behindHead means a newer version arrived from another machine (e.g. via snapshot pull) - the local file on this machine hasn't caught up yet",
    );
  }
  if (corrupt.length > 0) {
    result.corrupt = corrupt.map((r) => r.syntheticPath);
    result.help.push("corrupt means that family's own record could not be read - run `docmanager doctor` for detail");
  }
  if (orphanedMapping.length > 0) {
    result.orphanedMapping = orphanedMapping.map((r) => r.syntheticPath);
    result.help.push(
      "orphanedMapping means this machine still points a real file at a family that no longer exists - run `docmanager doctor` to clean it up",
    );
  }
  if (suggestedLinks && suggestedLinks.length > 0) {
    // Suggestion-only, per the exact boundary systemPatterns.md draws - a
    // title or structural match between two SEPARATE families is a nudge,
    // never an automatic link. The agent/user still has to run `link`.
    result.possibleDuplicates = suggestedLinks.map((s) => ({
      a: s.a.syntheticPath,
      aId: s.a.id,
      b: s.b.syntheticPath,
      bId: s.b.id,
      reasons: s.reasons,
    }));
    result.help.push(
      "possibleDuplicates are a cheap heuristic nudge, never auto-linked - review and run `docmanager link <fromId> <toId>` if they really are the same document",
    );
  }
  return result;
}

async function statusCommand() {
  return familiesCommand([]);
}

async function settingsCommand(args) {
  const [sub] = args;

  if (sub === "get") {
    const settings = await coreClient.getSettings();
    return { settings };
  }

  if (sub === "set") {
    const { flags } = parseFlags(args.slice(1), ["snapshot-remote", "snapshot-remote-token"]);
    if (flags["snapshot-remote"] === undefined && flags["snapshot-remote-token"] === undefined) {
      throw new AxiError("--snapshot-remote or --snapshot-remote-token is required", "VALIDATION_ERROR", [
        "docmanager settings set --snapshot-remote <url>",
        "docmanager settings set --snapshot-remote-token <token>",
      ]);
    }
    const patch = {};
    if (flags["snapshot-remote"] !== undefined) patch.snapshotRemote = flags["snapshot-remote"];
    // Only meaningful for an HTTPS-style remote - see snapshot.js's
    // authArgs(). An empty value clears a previously-set token.
    if (flags["snapshot-remote-token"] !== undefined) {
      patch.snapshotRemoteToken = flags["snapshot-remote-token"] || null;
    }
    const settings = await coreClient.updateSettings(patch);
    return { settings, help: ["Run `docmanager snapshot push` to push the current store there"] };
  }

  throw new AxiError(`Unknown settings command: ${sub ?? "(none)"}`, "VALIDATION_ERROR", [
    "docmanager settings get",
    "docmanager settings set --snapshot-remote <url>",
    "docmanager settings set --snapshot-remote-token <token>",
  ]);
}

async function snapshotCommand(args) {
  const [sub] = args;

  if (sub === "push") {
    try {
      await coreClient.pushSnapshot();
    } catch (err) {
      throw toAxiError(err);
    }
    return { snapshot: "pushed" };
  }

  if (sub === "pull") {
    let result;
    try {
      result = await coreClient.pullSnapshot();
    } catch (err) {
      throw toAxiError(err);
    }
    return {
      snapshot: result.mode === "clone" ? "cloned fresh" : "pulled and merged",
      help: ["Run `docmanager families` to see what's now tracked"],
    };
  }

  throw new AxiError(`Unknown snapshot command: ${sub ?? "(none)"}`, "VALIDATION_ERROR", [
    "docmanager snapshot push",
    "docmanager snapshot pull",
  ]);
}

// Never suggests docmanager itself generate a key - that's a real,
// system-level change (the same class of action as installing git,
// ARCHITECTURE.md section 3.2), and always needs the user's own explicit,
// in-the-moment approval, never taken autonomously.
async function setupSshCommand() {
  const result = await coreClient.checkSsh();

  if (!result.remoteConfigured) {
    return {
      ssh: "no snapshot remote configured yet",
      help: ["Run `docmanager settings set --snapshot-remote <url>` first"],
    };
  }
  if (!result.isSshRemote) {
    return {
      ssh: "the configured remote is not an SSH-style URL",
      help: [
        "SSH keys only apply to an SSH-style remote (e.g. git@github.com:you/repo.git)",
        "For an HTTPS remote, use `docmanager settings set --snapshot-remote-token <token>` instead",
      ],
    };
  }

  const output = { host: result.host, keysFound: result.keys.map((k) => k.path) };

  if (result.keys.length === 0) {
    return {
      ...output,
      ssh: "no SSH key found on this machine",
      help: [
        "Generating a new SSH key is a real change to this machine - ask your agent to run `ssh-keygen -t ed25519` only after you've explicitly approved it; docmanager never does this on its own",
        `Once you have a key, add its public half to ${result.host}'s SSH settings, then run \`docmanager setup ssh\` again to verify`,
      ],
    };
  }

  output.publicKeys = result.keys.map((k) => ({ path: k.path, publicKey: k.publicKey }));

  if (result.connection.status === "ok") {
    output.ssh = `connected successfully to ${result.host}`;
  } else if (result.connection.status === "failed") {
    output.ssh = `could not authenticate to ${result.host} with the key(s) found on this machine`;
    output.help = [`Add one of the public keys above to ${result.host}'s SSH settings if you haven't already`];
  } else {
    output.ssh = "connection attempt completed, but the result could not be classified";
    output.detail = result.connection.output;
  }
  return output;
}

async function setupCommand(args) {
  const [sub] = args;

  if (sub === "ssh") {
    return setupSshCommand();
  }

  if (sub !== "hooks") {
    throw new AxiError(`Unknown setup command: ${sub ?? "(none)"}`, "VALIDATION_ERROR", [
      "docmanager setup hooks",
      "docmanager setup ssh",
    ]);
  }

  const errors = [];
  // The entrypoint is bin/docmanager.js, which matches neither of
  // installSessionStartHooks()'s auto-inference patterns (dist/bin/<name>.js,
  // or a dot-free filename) - explicit marker/binaryNames/distEntrypoints are
  // required, not optional, or its own safety policy refuses to install
  // anything at all for an entrypoint shape it doesn't recognize.
  installSessionStartHooks({
    marker: "docmanager",
    binaryNames: ["docmanager"],
    distEntrypoints: ["bin/docmanager.js"],
    onError: (message) => errors.push(message),
  });

  if (errors.length > 0) {
    return { setup: "hooks installed with some issues", errors };
  }
  return {
    setup: "hooks installed or already up to date",
    help: [
      "A new Claude Code, Codex, or OpenCode session now opens with tracked documents already in context",
    ],
  };
}

async function searchCommand(args) {
  const { positional } = parseFlags(args, []);
  if (positional.length === 0) {
    throw new AxiError("a search query is required", "VALIDATION_ERROR", ["docmanager search <query>"]);
  }
  const query = positional.join(" ");

  let results;
  try {
    ({ results } = await coreClient.search(query));
  } catch (err) {
    throw toAxiError(err);
  }

  if (results.length === 0) {
    return {
      results: `0 documents found for "${query}"`,
      help: ["Try fewer or different words", "Run `docmanager families` to browse everything tracked"],
    };
  }
  return {
    count: `${results.length} match${results.length === 1 ? "" : "es"}`,
    results: results.map((r) => ({
      id: r.id,
      syntheticPath: r.syntheticPath,
      title: r.docTitle,
      snippet: r.snippet,
    })),
    help: ["Run `docmanager families view <id>` for a match's full version history"],
  };
}

async function doctorCommand() {
  const report = await coreClient.runDoctor();
  const problems = report.checks.filter((c) => c.status === "error" || c.status === "warning");
  const repaired = report.checks.filter((c) => c.status === "repaired");
  const output = {
    status: report.status,
    checks: report.checks.map((c) => ({ name: c.name, status: c.status, message: c.message })),
  };
  if (problems.length > 0) {
    output.problems = problems.map((c) => ({ name: c.name, details: c.details }));
    output.help = ["Problems here are reported, not auto-fixed - they may represent real document data and need your own judgment"];
  }
  if (repaired.length > 0) {
    output.repaired = repaired.map((c) => ({ name: c.name, details: c.details }));
  }
  return output;
}

async function uiCommand() {
  const { port } = await ensureCoreRunning();
  const url = `http://127.0.0.1:${port}/`;
  try {
    await open(url);
    return { ui: "opened in your default browser", url };
  } catch {
    // No GUI available (e.g. an SSH session) - print the URL instead of
    // failing, per ARCHITECTURE.md section 5.
    return { ui: "core running, no browser available to open automatically", url, help: [`Open ${url} manually`] };
  }
}

export async function main() {
  await runAxiCli({
    description: "Manage and version HTML documents on your local machine",
    version: VERSION,
    argv: process.argv.slice(2),
    topLevelHelp: TOP_LEVEL_HELP,
    home: async () => {
      const status = await coreStatus();
      if (!status.running) {
        return {
          docmanager: "core not running",
          help: ["Run `docmanager core start` to start it", "Run `docmanager track <path>` to begin"],
        };
      }
      const { families, reconciled } = await coreClient.listFamilies();
      const changed = reconciled.filter((r) => r.status === "new-version-captured");
      return {
        docmanager: families.length === 0 ? "no documents tracked yet" : `${families.length} tracked`,
        core: `running (pid ${status.pid}, port ${status.port})`,
        ...(changed.length > 0 ? { newVersionsCaptured: changed.map((r) => r.syntheticPath) } : {}),
        help: [
          "Run `docmanager track <path>` to start tracking a document",
          "Run `docmanager families` to see all tracked documents",
        ],
      };
    },
    commands: {
      core: coreCommand,
      track: trackCommand,
      untrack: untrackCommand,
      link: linkCommand,
      families: familiesCommand,
      status: statusCommand,
      settings: settingsCommand,
      snapshot: snapshotCommand,
      setup: setupCommand,
      ui: uiCommand,
      doctor: doctorCommand,
      search: searchCommand,
    },
  });
}
