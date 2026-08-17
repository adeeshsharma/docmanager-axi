---
name: docmanager
description: Manages and versions the user's HTML documents on their own machine - tracking files or whole folders, capturing new versions automatically when a tracked file changes, linking related documents into one version history, and syncing that history across machines through a git remote. Use when the user asks to track, organize, version, find, or sync HTML documents, or mentions docmanager.
---

# docmanager

Manages and versions HTML documents. It does not edit them, that is a separate tool's job. Runs entirely on the user's own machine, bound to loopback only.

## Invoking it

If `docmanager` is not on PATH, run it through npx instead of assuming a global install:

```sh
npx -y --package=docmanager-axi docmanager <command>
```

If it is already installed globally, `docmanager <command>` works directly. Either way, the first command run against it starts its background service automatically - there is no separate "start" step to remember, and no need to stop it when done, it stops itself after a long period of no activity.

## Prerequisite: git

The document store this tool uses is a real git repository. If `git` is not installed, docmanager fails with a clear error instead of a raw stack trace. Tell the user git is missing and ask before installing anything on their behalf, never install it silently.

## Core commands

- `docmanager track <path>... [--as <name>] [--relink]` - start tracking one or more files or folders in one call. A folder is tracked recursively for HTML files, skipping vendor/build directories like `node_modules`, `.git`, and `dist`. `--relink` reconnects a file to a document that already exists from a snapshot, and works in bulk on a whole folder at once, the normal way to reconnect an entire pulled snapshot on a new machine.
- `docmanager untrack <id>...` - stop tracking one or more documents. Removes the document's version history from docmanager; never deletes the real file on disk.
- `docmanager link <fromId> <toId>` - declare that `toId` supersedes `fromId`, merging two separately-tracked documents into one version history.
- `docmanager families` / `docmanager families view <id>` - list tracked documents, or show one document's full version history.
- `docmanager families diff <id> <hashA> <hashB>` - show what changed between two versions, computed on normalized content so whitespace/attribute-order noise never shows up as a fake change.
- `docmanager families revert <id> <hash>` - make an older version current again. Changes docmanager's own history only - it never edits the real file on disk. If the real file still holds newer content afterward, the next `status` reports it as behind, exactly like a change pulled in from another machine would.
- `docmanager families delete-version <id> <hash>` - permanently discard one version's own record, not the whole document (`untrack` does that). Heals the history around the deleted version so nothing is left pointing at it; refuses if it's a family's only remaining version.
- `docmanager families rename <id> <newSyntheticPath>` - change a tracked document's synthetic path, keeping its full version history.
- `docmanager families tags <id> [--set "a,b"] [--add <tag>] [--remove <tag>]` - view or change a document's free-form tags; no flags just shows the current ones. Tags are indexed for `search` too.
- `docmanager families export <id> <hash> --to <path>` - write one version's raw content to a real file on disk. Rarely needed directly - `docmanager families lavish` (below) already does this as part of opening a review session.
- `docmanager families lavish <id> <hash>` - export a version to a docmanager-owned working file and open it in Lavish Editor, in one step (see "Editing a version with Lavish Editor" below for the full workflow).
- `docmanager status` - reconciles every tracked file against disk and reports current state, including anything just captured as a new version.
- `docmanager search <query>` - keyword search over tracked documents' paths, titles, and text (current version only). Not semantic search - it won't find a document by meaning alone, only by words actually in it.
- `docmanager settings get` / `set --snapshot-remote <url>` / `set --snapshot-remote-token <token>` - read or set the git remote and, for an HTTPS remote on a machine with no credential helper configured, an access token. `get` never returns the token's real value, only whether one is saved.
- `docmanager snapshot push [--acknowledge-privacy]` / `pull` - sync the document store with the configured remote. Pull clones fresh on a machine that has nothing local yet. The remote's privacy is entirely the user's own responsibility - docmanager adds no access control of its own - so the very first push on a machine refuses until `--acknowledge-privacy` confirms that; a one-time flag, never asked again after.
- `docmanager setup ssh` - read-only check of whether SSH auth actually works for an SSH-style remote (checks for an existing key, tests the connection). Never generates a key or writes to `~/.ssh` - if no key exists, generating one is a real change to the user's machine and needs their explicit approval first, the same rule as installing `git`.
- `docmanager ui` - opens the local web interface for reading tracked documents and their version history.
- `docmanager doctor` - checks git availability, store/index health, and document integrity. Auto-repairs what's safe to (a stale internal index, a leftover pointer to an already-gone document); only ever reports anything that could be real data loss, never touches it automatically.
- `docmanager reset --confirm` - permanently deletes the entire `~/.docmanager` directory: every tracked document's full version history, every setting, everything. No undo. Refuses outright without `--confirm`. **Never run this on your own initiative, even when it looks like the obvious fix for a tracking mistake** - the same rule as installing `git` or generating an SSH key. Propose it, explain exactly what it will delete, and only run it after the user says yes, every single time.
- `docmanager gc` - runs git's own housekeeping on the local store to compact history and reclaim disk space, since every version of every document is a git commit forever. Non-destructive (no document data is touched, unlike `reset`) and needs no approval-gating, but is opt-in - only run it when the user asks, not proactively.

## What matters beyond the commands themselves

- A change to an already-tracked file is captured as a new version automatically, the next time anything reads state (a `status` call, or the UI being opened or refocused). No confirmation is needed for this, it is not a guess, the document is already known.
- A newly noticed file is never assumed to be a version of an existing one. If two separately-tracked files turn out to be the same document, that has to be declared explicitly with `link`, never inferred. `docmanager families`/`status` may show a `possibleDuplicates` nudge (a cheap title or structural match between two documents) - it is only ever a suggestion, never acted on automatically.
- The web UI is for the user themselves to browse and manage documents by hand (reading history, comparing versions, renaming, tagging, bulk untracking). It is not something an agent drives on the user's behalf the way the CLI is.
- A setting changed in the UI takes effect immediately for the CLI too, since both talk to the same background service. There is no need to ask the user to also report a change they already made there.

## Editing a version with Lavish Editor

The web UI has an "Edit in Lavish" action on any version being viewed, which copies a ready-to-paste prompt for you - or the user may just ask directly to edit a specific tracked document (any version, not necessarily the current one) with Lavish Editor. Either way, this is the workflow:

1. Run `docmanager families lavish <id> <hash>`. This exports that exact version to a docmanager-owned working file and opens it in Lavish Editor, in one step - using docmanager's own bundled `lavish-axi` dependency internally (never `npx`, never a global install, so the version actually running is always the one docmanager was built and tested against). Its output tells you the exact file path and the exact `node <resolved-path> poll <file>` command to run next - **use that command verbatim**, don't substitute your own `lavish-axi`/`npx lavish-axi` invocation, or you may end up polling a different install than the one that opened the session. Keep polling, apply feedback, poll again, same discipline as any other Lavish session.
2. When the review session ends, run `docmanager track <path from step 1> --as <the document's syntheticPath> --relink` followed by `docmanager status`. This is what actually captures the edited result as the document's next version - not step 1, and nothing automatic happens while editing is in progress. Nothing is logged until you explicitly do this.

docmanager has no agent or polling loop of its own - it cannot start or drive a Lavish session by itself. This whole workflow only happens because you, the agent already in this conversation, carry it out end to end.

## Ambient context

Run `docmanager setup hooks` once, if the user wants it, to register a session-start hook (Claude Code, Codex, or OpenCode, whichever is present) so a new session already shows tracked documents without needing to ask.
