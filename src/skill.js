// Generated into skills/docmanager/SKILL.md by scripts/build-skill.js. Kept
// as one function so the skill can never drift from what docmanager
// actually does - if a command's behavior changes, this is the one place
// that needs updating, not a second, hand-maintained copy of the same
// information.
export function createSkillMarkdown() {
  return `---
name: docmanager
description: Manages and versions the user's HTML documents on their own machine - tracking files or whole folders, capturing new versions automatically when a tracked file changes, linking related documents into one version history, and syncing that history across machines through a git remote. Use when the user asks to track, organize, version, find, or sync HTML documents, or mentions docmanager.
---

# docmanager

Manages and versions HTML documents. It does not edit them, that is a separate tool's job. Runs entirely on the user's own machine, bound to loopback only.

## Invoking it

If \`docmanager\` is not on PATH, run it through npx instead of assuming a global install:

\`\`\`sh
npx -y --package=docmanager-axi docmanager <command>
\`\`\`

If it is already installed globally, \`docmanager <command>\` works directly. Either way, the first command run against it starts its background service automatically - there is no separate "start" step to remember, and no need to stop it when done, it stops itself after a long period of no activity.

## Prerequisite: git

The document store this tool uses is a real git repository. If \`git\` is not installed, docmanager fails with a clear error instead of a raw stack trace. Tell the user git is missing and ask before installing anything on their behalf, never install it silently.

## Core commands

- \`docmanager track <path>... [--as <name>] [--relink]\` - start tracking one or more files or folders in one call. A folder is tracked recursively for HTML files, skipping vendor/build directories like \`node_modules\`, \`.git\`, and \`dist\`. \`--relink\` reconnects a file to a document that already exists from a snapshot, and works in bulk on a whole folder at once, the normal way to reconnect an entire pulled snapshot on a new machine.
- \`docmanager untrack <id>...\` - stop tracking one or more documents. Removes the document's version history from docmanager; never deletes the real file on disk.
- \`docmanager link <fromId> <toId>\` - declare that \`toId\` supersedes \`fromId\`, merging two separately-tracked documents into one version history.
- \`docmanager families\` / \`docmanager families view <id>\` - list tracked documents, or show one document's full version history.
- \`docmanager families diff <id> <hashA> <hashB>\` - show what changed between two versions, computed on normalized content so whitespace/attribute-order noise never shows up as a fake change.
- \`docmanager families revert <id> <hash>\` - make an older version current again. Changes docmanager's own history only - it never edits the real file on disk. If the real file still holds newer content afterward, the next \`status\` reports it as behind, exactly like a change pulled in from another machine would.
- \`docmanager families delete-version <id> <hash>\` - permanently discard one version's own record, not the whole document (\`untrack\` does that). Heals the history around the deleted version so nothing is left pointing at it; refuses if it's a family's only remaining version.
- \`docmanager families rename <id> <newSyntheticPath>\` - change a tracked document's synthetic path, keeping its full version history.
- \`docmanager families tags <id> [--set "a,b"] [--add <tag>] [--remove <tag>]\` - view or change a document's free-form tags; no flags just shows the current ones. Tags are indexed for \`search\` too.
- \`docmanager status\` - reconciles every tracked file against disk and reports current state, including anything just captured as a new version.
- \`docmanager search <query>\` - keyword search over tracked documents' paths, titles, and text (current version only). Not semantic search - it won't find a document by meaning alone, only by words actually in it.
- \`docmanager settings get\` / \`set --snapshot-remote <url>\` / \`set --snapshot-remote-token <token>\` - read or set the git remote and, for an HTTPS remote on a machine with no credential helper configured, an access token. \`get\` never returns the token's real value, only whether one is saved.
- \`docmanager snapshot push\` / \`pull\` - sync the document store with the configured remote. Pull clones fresh on a machine that has nothing local yet.
- \`docmanager setup ssh\` - read-only check of whether SSH auth actually works for an SSH-style remote (checks for an existing key, tests the connection). Never generates a key or writes to \`~/.ssh\` - if no key exists, generating one is a real change to the user's machine and needs their explicit approval first, the same rule as installing \`git\`.
- \`docmanager ui\` - opens the local web interface for reading tracked documents and their version history.
- \`docmanager doctor\` - checks git availability, store/index health, and document integrity. Auto-repairs what's safe to (a stale internal index, a leftover pointer to an already-gone document); only ever reports anything that could be real data loss, never touches it automatically.

## What matters beyond the commands themselves

- A change to an already-tracked file is captured as a new version automatically, the next time anything reads state (a \`status\` call, or the UI being opened or refocused). No confirmation is needed for this, it is not a guess, the document is already known.
- A newly noticed file is never assumed to be a version of an existing one. If two separately-tracked files turn out to be the same document, that has to be declared explicitly with \`link\`, never inferred. \`docmanager families\`/\`status\` may show a \`possibleDuplicates\` nudge (a cheap title or structural match between two documents) - it is only ever a suggestion, never acted on automatically.
- The web UI is for the user themselves to browse and manage documents by hand (reading history, comparing versions, renaming, tagging, bulk untracking). It is not something an agent drives on the user's behalf the way the CLI is.
- A setting changed in the UI takes effect immediately for the CLI too, since both talk to the same background service. There is no need to ask the user to also report a change they already made there.

## Ambient context

Run \`docmanager setup hooks\` once, if the user wants it, to register a session-start hook (Claude Code, Codex, or OpenCode, whichever is present) so a new session already shows tracked documents without needing to ask.
`;
}
