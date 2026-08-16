# docmanager-axi

Manages and versions the HTML documents on your machine: track a file, and every real edit to it becomes a new version automatically, the way git tracks commits, but purpose-built for HTML rather than source code. Snapshot the whole thing to a git remote you control and pull it back down on another machine, with no dependency on that machine's file layout.

This tool manages and versions documents. It does not edit them - that's a job for a different tool.

Everything runs locally, bound to loopback only. Nothing leaves your machine except when you explicitly push a snapshot to a git remote you configure yourself.

Full design rationale and the phased build plan are in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Status

v1, functionally complete against its own design: tracking, automatic version capture, a local web UI, cross-machine snapshot sync, and agent session integration all work and have been verified end to end, including two-machine sync scenarios (clone, relink, merge, conflict). Verification so far has been on macOS only - Windows and Ubuntu are believed compatible (pure Node APIs, cross-platform dependencies throughout) but not yet actually run there. Not yet published to npm.

## Prerequisites

- Node.js 20 or later.
- `git`, already installed and on `PATH`. The content store is a real git repository under the hood; this is not optional.

If `git` is missing, `docmanager` fails with a clear error rather than a raw stack trace. If an agent is setting this up on your behalf, it should tell you `git` is missing and ask before running any install command - never install it silently.

## Install

Not published to npm yet - clone this repository and link it locally instead:

```sh
git clone git@github.com:adeeshsharma/docmanager-axi.git
cd docmanager-axi
npm install
npm link          # puts `docmanager` on PATH, backed by this checkout
```

`npm link` gives the same `docmanager <command>` experience the eventual `npm install -g docmanager-axi` will, just pointed at your local checkout instead of the registry. Don't want a global link? Run everything as `node bin/docmanager.js <command>` from inside the checkout instead - identical behavior either way.

## Quick start

```sh
docmanager track ./report.html          # start tracking a document
docmanager status                       # see what's tracked, reconciled against disk
docmanager families                     # list tracked documents
docmanager families view <id>           # one document's version history
docmanager search "quarterly numbers"   # keyword search across everything tracked
docmanager ui                           # open the local web UI
```

Edit a tracked file and save it. The next `docmanager status` (or opening/refocusing the UI) automatically records it as a new version - no confirmation needed, since there's nothing ambiguous about a change to a file you already told it to track.

If two separately-tracked files turn out to be the same document at different points in time:

```sh
docmanager link <olderId> <newerId>     # newerId supersedes olderId
```

docmanager never guesses this connection on its own, but it will nudge: `docmanager families`/`status` flags a `possibleDuplicates` entry when two separately-tracked documents share a normalized title or near-identical structure. It's a cheap heuristic, not a determination - review it and run `link` yourself if it's really the same document.

See what changed between two versions, or make an older one current again:

```sh
docmanager families diff <id> <hashA> <hashB>    # a line diff, computed on normalized content
docmanager families revert <id> <hash>           # makes that version current again
```

`revert` only changes docmanager's own history - it never edits the real file on disk. If the real file still holds newer content afterward, the next `status` reports it as behind, the same way a change pulled in from another machine would.

The CLI's diff is a source-line diff, for scripting and precision. The UI's "Compare versions" button opens a dedicated view with a "Rendered" option too: both versions shown as actual pages side by side, changed blocks (paragraphs, list items, headings...) highlighted red and green, scrolling both sides together - for reading what changed, not auditing markup.

Want to permanently discard a specific version instead of just moving past it?

```sh
docmanager families delete-version <id> <hash>
```

This removes just that version's own record - not the whole document (`untrack` does that) - and heals the history around it so nothing is left pointing at a version that no longer exists. It refuses if it's the only version a family has left.

Everyday housekeeping: rename a document's synthetic path without losing any history, or attach free-form tags to it.

```sh
docmanager families rename <id> <newSyntheticPath>
docmanager families tags <id> --set "draft, q3"     # replaces the whole tag set
docmanager families tags <id> --add internal        # adds one tag
docmanager families tags <id> --remove draft         # removes one tag
docmanager families tags <id>                        # shows current tags, no flags needed
```

Tags are indexed for search too - `docmanager search draft` finds a document by tag the same way it finds one by title or body text. The UI's document view has the same two actions: a pencil icon next to the title to rename, tag chips underneath it to add or remove tags, and a "Download" button next to "Open in new tab" to save a specific version as a file. The sidebar list also supports selecting multiple documents at once for a bulk untrack.

## Syncing across machines

```sh
docmanager settings set --snapshot-remote <git-url>
docmanager snapshot push                # push the local store
docmanager snapshot pull                # pull it down elsewhere - clones fresh on a new machine
```

On a brand-new machine, `snapshot pull` reconstructs your full document and version history immediately. The one manual step: reconnecting a synthetic path to a live file on that machine.

```sh
docmanager track ./report.html --as /report --relink
```

`--relink` is required specifically because the tool never guesses that a file on a new machine is the same as one from a snapshot - that's always your call. Once relinked, ordinary edits are captured automatically again.

A genuine sync conflict (the same document changed differently on two machines before syncing) is never auto-resolved: the pull aborts cleanly, nothing local is touched, and you resolve it with git directly in `~/.docmanager/store`.

### A fresh machine with no git auth configured yet

If the remote is HTTPS and this machine doesn't already have a credential helper set up:

```sh
docmanager settings set --snapshot-remote-token <token>
```

Stored locally only, never part of a snapshot, sent only on the actual push/pull request - `docmanager settings get` never shows the value back, only whether one is saved.

If the remote is SSH (`git@host:...`), the token above does nothing - authentication comes from this machine's own SSH key. Check whether that's actually working:

```sh
docmanager setup ssh
```

Read-only: it looks for an existing key and tests the connection, but never generates one. If none is found, generating a new SSH key is a real change to your machine - your agent should only do that with your explicit go-ahead, not on its own.

## Agent session integration

```sh
docmanager setup hooks
```

Installs a session-start hook for Claude Code, Codex, or OpenCode (whichever is present), so a new agent session opens already knowing what documents are tracked, rather than needing to be told.

An installable Agent Skill is also available for agents or harnesses that don't support session-start hooks:

```sh
npx skills add adeeshsharma/docmanager-axi --skill docmanager
```

The skill and the session hook teach an agent the same thing; use whichever your setup supports, or both.

## The background service

The first `docmanager` command you run starts a small background process automatically - there is no separate start step. It keeps running across further commands so it never has to cold-start each time, and stops itself automatically after a long period of no activity (several hours by default), so a process you started once and forgot about doesn't run forever. An open UI tab counts as real activity on its own, so the timeout never fires while you're actually using it.

You can also stop it immediately, either from the UI's Settings page or with `docmanager core stop`. Either way, the next command from you, an agent, or the UI starts it again automatically - nothing needs to be told it happened.

After an `npm update` (or any upgrade), an already-running background process keeps executing the old code it loaded at startup - it has no way to notice new files landing on disk while it's still running. `docmanager` detects this automatically (comparing the running core's own reported version against the CLI's) and restarts it transparently the next time it's needed, so you never end up silently running stale code after an upgrade. `docmanager core status` reports it plainly if you check while it's in that state, even though it hasn't restarted itself yet.

## Appearance

The UI follows your system's light/dark preference by default. To override it, go to Settings → Appearance and pick System, Light, or Dark. This is a display preference for this browser only - it's never sent to the core or included in a snapshot.

## Command reference

| Command | Does |
|---|---|
| `docmanager` | Show current state: core status, tracked document count |
| `docmanager track <path>... [--as <name>] [--relink]` | Start tracking one or more files and/or folders (folders are tracked recursively, skipping vendor/build directories such as `node_modules`, `.git`, `dist`) |
| `docmanager untrack <id>...` | Stop tracking one or more documents (does not delete the real files) |
| `docmanager link <fromId> <toId>` | Declare that `toId` supersedes `fromId` |
| `docmanager families` | List tracked documents |
| `docmanager families view <id>` | One document's full version history |
| `docmanager search <query>` | Keyword search over tracked documents' paths, titles, and text (not semantic search) |
| `docmanager families diff <id> <hashA> <hashB>` | Show what changed between two versions |
| `docmanager families revert <id> <hash>` | Make an older version current again (docmanager's history only, real file untouched) |
| `docmanager families delete-version <id> <hash>` | Permanently discard one version's record (not the whole document - see `untrack`) |
| `docmanager families rename <id> <newSyntheticPath>` | Change a document's synthetic path, keeping its full history |
| `docmanager families tags <id> [--set "a,b"] [--add <tag>] [--remove <tag>]` | View or change a document's tags (no flags shows current tags) |
| `docmanager status` | Reconcile and show current tracked state |
| `docmanager settings get` / `set --snapshot-remote <url>` / `set --snapshot-remote-token <token>` | Read or write settings (the token is never echoed back by `get`) |
| `docmanager snapshot push` / `pull` | Sync the store with the configured remote |
| `docmanager ui` | Open the local web UI |
| `docmanager setup hooks` | Install agent session-start integration |
| `docmanager setup ssh` | Read-only SSH auth check for the configured remote - never generates a key |
| `docmanager core start` / `status` / `stop` | Manage the background service directly |
| `docmanager doctor` | Check git/store/index/local-state health; auto-repairs what's safe to, reports the rest |
| `docmanager update [--check]` | Self-update (built in, no per-tool code) |

Every command's full flag reference is available via `--help`, e.g. `docmanager track --help`.

## How it works, briefly

A long-running local service (started automatically on first use) owns all state: a content-addressed git repository for document content and version history, plus a local SQLite index for fast queries. A local web UI and the `docmanager` CLI are both clients of that one service, so an action taken in the UI and an action taken by an agent through the CLI are always looking at the same, immediately-consistent state. Full detail in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Development

```sh
npm install
npm run build     # copies src/ui into dist/ui; server.js serves dist/ui when present, src/ui otherwise
npm test          # node's built-in test runner - store, tracking, reconcile, snapshot sync, and a real CLI smoke test
node bin/docmanager.js --help
```

No bundler, no framework for the CLI, core, or UI - all plain Node/HTML/CSS/JS, deliberately, to keep the published package small. `npm test` uses `DOCMANAGER_HOME`/`DOCMANAGER_PORT` overrides internally to fully isolate itself from any real, already-running core on this machine - safe to run alongside normal use. CI (`.github/workflows/ci.yml`) runs the same suite plus `npm run build` and `npm pack --dry-run` on macOS, Windows, and Ubuntu.

## License

[MIT](./LICENSE)
