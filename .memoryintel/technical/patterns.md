## Design Patterns
_Imported verbatim from `memory-bank/systemPatterns.md` on 2026-08-29 — not yet re-filed into per-section structure; treat as raw source material for the next real update._

# System patterns

Full detail and rationale for every pattern below lives in `ARCHITECTURE.md` — this file is a working summary for a fresh session, re-read the source doc before implementing anything non-trivial against it.

## Three-layer architecture, one source of truth

- **Core service**: a long-running local daemon, the only process that writes to storage. Owns the git-backed content store, the derived SQLite index, and settings. Exposes a loopback HTTP API and serves the UI's static assets.
- **UI**: a local web app, browser tab (no Electron/Tauri in v1). Talks directly to the core for structured, deterministic actions — settings, tracking, browsing. Never routes through the agent for these.
- **CLI**: what the agent shells out to, built on `axi-sdk-js`. Thin HTTP client to the core. The agent is the layer for judgment/natural-language operations, not persistence.

## Patterns adopted from `axi-sdk-js` (used out of the box, not extended)

- `runAxiCli()` — command-first dispatch, TOON serialization, structured `AxiError`s, `--help`/`--version`, a free `update` self-updater.
- `axi-sdk-js/fast-path`'s `tryFastPath()` — answers `-v`/`-V`/`--version` from a leaf module before the real command graph loads via dynamic `import()`. `VERSION` must live in a leaf module (node builtins only) or the fast path buys nothing.
- `installSessionStartHooks()` — wired from an explicit `docmanager setup hooks` command, not automatically. Used for real value here, not just compliance: session start can show tracked families and any pending version-link suggestions.
- Everything else (HTTP server, storage, UI) is docmanager's own code that `axi-sdk-js`'s command handlers call into. There is nothing to fork or subclass in the SDK itself.

## Core service process lifecycle

- Started lazily by the first CLI command or UI launch that needs it; stays running until `docmanager core stop` or a reboot. No idle timeout in v1.
- Singleton enforcement via an **exclusive-create** lock file at `~/.docmanager/core.lock` (not check-then-write, which races). An existing lock entry is only trusted after a `/health` call confirms **service identity**, not just PID liveness — PIDs get reused after a reboot, so liveness alone is not proof of ownership.
- Binds to `127.0.0.1` on a port chosen at startup, persisted alongside the lock file so a restart tries to reacquire the same port (keeps an already-open UI tab working); falls back to a new port only on conflict.
- Logs to `~/.docmanager/core.log` (it's detached from any terminal — a crash would otherwise be invisible). `~/.docmanager` is created with user-only (0700) permissions, since it holds document content.
- Detached-spawn semantics are tested explicitly on Mac, Windows, and Ubuntu — Node does not fully abstract this away.

## Storage

- **Content + metadata (synced)**: a git repo at `~/.docmanager/store`. Content is addressed by hash (never the original filename — sidesteps Windows path-length/reserved-character/case-insensitivity issues). Metadata is one JSON file per document family (title, versions, supersedes edges, synthetic logical path), plain-text so normal git merges resolve cleanly across machines. `.gitattributes` disables line-ending normalization so a Windows checkout can't silently change a stored file's hash.
- **Local index (derived, never synced)**: SQLite (`better-sqlite3`) at `~/.docmanager/index.db`, rebuilt from the JSON metadata on startup/after a pull/after a local write. Rebuild writes to a temp file and swaps it in, so a concurrent read never sees a half-written index.
- **Local machine state (never synced)**: `~/.docmanager/local-state.json` maps each synthetic logical path to wherever its source file lives *on this machine*. This is what makes the system independent of any one machine's file layout — the synthetic path travels in the snapshot, the real path never does. Each real path maps to at most one synthetic path per machine.
- The core **serializes all writes**, including git operations, through a single-writer queue — concurrent git operations against one working tree corrupt it.
- **Git dependency**: shells out to the system `git` binary (real remotes/auth/merge behavior, no bundled reimplementation). If missing, the core fails with a structured error pointing at README setup instructions rather than a raw error. **Any autonomous install action an agent takes from those instructions requires explicit user approval first — never installed silently, git included.**

## Version capture semantics — two different mechanisms, don't conflate them

1. **Suggestion-only** (different, previously unrelated files that might belong together): cheap heuristics (title match, structural hash) may nudge the user, never auto-link. Genuinely ambiguous, stays out of v1's automatic path entirely.
2. **Automatic, no confirmation** (an already-tracked synthetic path whose content hash no longer matches its last recorded version): there is no inference here, since the family is already known — it's automatically recorded as the family's newest version. Detection is **triggered, not passive**: it happens as a side effect of any read that reports tracked state (`GET /families`, `docmanager status`, or the UI loading / regaining focus). No separate reconcile command exists — folding the check into existing read paths means the UI reflects reality just by being looked at, not by a remembered extra step.
Unrelated load-bearing gotcha in the same file (highlight-render.js): a Range boundary from a real user selection (not a hand-constructed Range) frequently lands on an ELEMENT container, not a text node - a triple-click "select this line" is the common case. Resolving that boundary must never assume the element's child at that offset is itself another element to walk into for a text descendant - it can be a bare text node directly, and createTreeWalker(thatTextNode, SHOW_TEXT).nextNode() will never return it (a TreeWalker only yields descendants of its root, never the root itself). Handle the bare-text-node case directly instead of always walking. Separately, the out-of-bounds "boundary is after every child" fallback must resolve to the LAST text descendant of the fallback child, not the first - a fallback child can be a multi-descendant element (e.g. a paragraph with a link in the middle: text, <a>, text), and the first descendant's own length is not the end of the whole element.
## Security posture for a loopback server

Binding to `127.0.0.1` stops network access but not a malicious browser tab on the same machine — browsers don't block a page from calling `http://127.0.0.1` (the same mechanism behind DNS-rebinding attacks). The core checks the `Origin` header on every request: rejects any Origin that isn't the UI's own, accepts requests with no Origin at all (how the CLI's own HTTP client calls in, since only browsers send one).
The reading pane's sandboxed iframe (sandbox="allow-scripts", no allow-same-origin) and a standalone "Open in new tab" browser tab both receive the exact same served, rendered content and the exact same injected client-side script - the script itself detects which context it's running in via `window.parent === window` (true only when there's no enclosing iframe) and picks postMessage-to-parent vs. direct same-origin fetch() accordingly, rather than the server building two different variants of the injected script. This is the general pattern for any future injected behavior that needs to work identically in both contexts: branch at runtime inside one script, don't fork the script itself.
## Snapshot / cross-machine sync

- `snapshot push`/`snapshot pull` are just `git push`/`git fetch+merge` against the store repo, reusing the same git dependency as the version-diffing engine.
- First run initializes the store as a fresh git repo; a first pull on a machine with no local store clones instead of assuming one exists; a first push to an empty remote makes the initial commit.
- Pull never discards unpushed local changes — surfaces a conflict instead of overwriting.
- Auth to the remote is whatever the machine's existing git setup already provides; docmanager manages no credentials of its own. The remote's privacy is entirely the user's responsibility.
- Relinking a synthetic path to a live file on a new machine stays a deliberate manual step — the tool never guesses that a file on a new machine is the same as one from a snapshot.

## Known architectural risks

1. Native dependency distribution: `better-sqlite3` prebuilds need to actually cover Mac/Windows/Ubuntu in CI, not just be assumed to.
2. Detached-process spawn/kill semantics differ across platforms (Windows especially) — needs real per-platform verification, not just Node-abstracts-it-away assumptions.
3. HTML normalization (for diffing) needs a lenient, real-world-tolerant parser — most HTML in the wild isn't strictly well-formed.
4. `git` as an external prerequisite is a real install-time dependency, mitigated by a structured error + README instructions, but not eliminated.
## Anti-Patterns
