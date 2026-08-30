## Product Overview
_Imported verbatim from `memory-bank/productContext.md` on 2026-08-29 — not yet re-filed into per-section structure; treat as raw source material for the next real update._

# Product context

## Why this exists

Markdown workflows have shifted to HTML. A user iterating on a document — with an editing tool, with an agent, by hand — ends up with a folder full of files that are really one document at different points in time: `report.html`, `report_v2.html`, `report_final.html`, `report_final_ACTUAL.html`. Nothing on the system tracks which one is current, how they relate, or what changed between them. This gets worse, not better, over time, and worse still once the same user is working across more than one machine.

Existing AXIs solve a different problem. Lavish Editor lets a human annotate and iteratively edit a static HTML artifact with an agent. Reactive-Axi extends that to a live running app. Neither one helps once the session ends and the output just becomes another file on disk, indistinguishable from the other nine versions of itself sitting in the same folder.

## The problem being solved

- **Version sprawl with no lineage.** Multiple files are the same document, but nothing records that relationship or which one supersedes which.
- **No cross-machine continuity.** A user working from a personal machine and one or more work machines has no way to carry document history between them, since everything today lives only on whichever machine last touched the file.
- **Manual tracking doesn't scale.** Filenames and folder conventions ("_v2", "_final") are a weak, error-prone substitute for a real version model, and they carry no diff, no timestamp discipline, and no way to ask "what actually changed."

## Who this is for

A user (individual, not a team) with an AI coding/writing agent already in their workflow, who generates or edits HTML documents across sessions and machines and wants those documents managed the way source code is managed — tracked, versioned, diffable — without hand-rolling a naming convention or manually copying files between machines.

## UX goals

- **Tell it once, it remembers.** Declaring "track this" or "this supersedes that" should be the only manual step; everything else (capturing a new version when a tracked file changes, keeping the UI current) is automatic.
- **Never make the agent a bottleneck for the user's own structured actions.** Settings, tracking, and browsing are direct UI-to-core actions, not LLM turns. The agent is for judgment calls and natural language, not for saving a form field.
- **Show, don't describe.** A visual version graph per document family is the primary way the user understands document history — the same value `git log --graph` gives a developer, but for HTML documents a non-developer can use.
- **Move machines without losing history.** Pulling a snapshot on a new machine should feel like picking up exactly where the user left off, with no manual re-teaching of which file is which version.
- **Automatic where there's no real ambiguity, suggestion-only where there is.** A change to an already-tracked file is captured without asking. A newly noticed file that merely *resembles* an existing family is only ever suggested, never silently linked.
## Users

## Value Proposition
