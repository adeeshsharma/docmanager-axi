# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project intends to follow [Semantic Versioning](https://semver.org/) once it reaches a first published release.

From the first real release onward, new entries below this point are generated automatically by [release-please](https://github.com/googleapis/release-please) from [Conventional Commits](https://www.conventionalcommits.org/) - see `RELEASING.md`. The `[Unreleased]` section below predates that and is hand-written, describing the full pre-release v1 feature set as a single snapshot rather than a per-commit log.

## [1.5.0](https://github.com/adeeshsharma/docmanager-axi/compare/docmanager-axi-v1.4.0...docmanager-axi-v1.5.0) (2026-09-04)


### Features

* unify highlighting and link navigation across the reading pane and standalone tabs ([#19](https://github.com/adeeshsharma/docmanager-axi/issues/19)) ([ab10cd6](https://github.com/adeeshsharma/docmanager-axi/commit/ab10cd67dcd1bdb74bcd246630857db7a24bd042))

## [1.4.0](https://github.com/adeeshsharma/docmanager-axi/compare/docmanager-axi-v1.3.1...docmanager-axi-v1.4.0) (2026-09-04)


### Features

* add --sync-file to revert, resolving the can't-delete-old-version friction ([#20](https://github.com/adeeshsharma/docmanager-axi/issues/20)) ([0c761ba](https://github.com/adeeshsharma/docmanager-axi/commit/0c761ba4f01457e876cef9a693b9c12ad1014552))

## [1.3.1](https://github.com/adeeshsharma/docmanager-axi/compare/docmanager-axi-v1.3.0...docmanager-axi-v1.3.1) (2026-09-04)


### Bug Fixes

* correct highlight boundary normalization for element-container selections ([#17](https://github.com/adeeshsharma/docmanager-axi/issues/17)) ([fc48229](https://github.com/adeeshsharma/docmanager-axi/commit/fc48229e2b24d97fa111d2a9f480bead77c655a2))

## [1.3.0](https://github.com/adeeshsharma/docmanager-axi/compare/docmanager-axi-v1.2.1...docmanager-axi-v1.3.0) (2026-09-04)


### Features

* cross-document link resolution and per-version text highlights ([#15](https://github.com/adeeshsharma/docmanager-axi/issues/15)) ([c6805a6](https://github.com/adeeshsharma/docmanager-axi/commit/c6805a69915f9eefc98668ce7c6700bdea517b3a))

## [1.2.1](https://github.com/adeeshsharma/docmanager-axi/compare/docmanager-axi-v1.2.0...docmanager-axi-v1.2.1) (2026-08-30)


### Bug Fixes

* retire a family's previous Lavish scratch mapping on relink ([#12](https://github.com/adeeshsharma/docmanager-axi/issues/12)) ([e6bd421](https://github.com/adeeshsharma/docmanager-axi/commit/e6bd421fbd8d7d39f0e6297035876b955edb3b9c))

## [1.2.0](https://github.com/adeeshsharma/docmanager-axi/compare/docmanager-axi-v1.1.0...docmanager-axi-v1.2.0) (2026-08-30)


### Features

* folders - organize tracked documents into a nested hierarchy ([#8](https://github.com/adeeshsharma/docmanager-axi/issues/8)) ([038c888](https://github.com/adeeshsharma/docmanager-axi/commit/038c88874345f5cbf75f3082f44e90abc8f1296b))

## [1.1.0](https://github.com/adeeshsharma/docmanager-axi/compare/docmanager-axi-v1.0.0...docmanager-axi-v1.1.0) (2026-08-21)


### Features

* add docmanager sync command and redesign the web UI ([#6](https://github.com/adeeshsharma/docmanager-axi/issues/6)) ([22865ca](https://github.com/adeeshsharma/docmanager-axi/commit/22865cafead3c5890ff7b239d6b60d80a75d3e9b))

## 1.0.0 (2026-08-17)


### Bug Fixes

* deleting a version could resurrect it on the next reconcile ([#3](https://github.com/adeeshsharma/docmanager-axi/issues/3)) ([0739d39](https://github.com/adeeshsharma/docmanager-axi/commit/0739d3962870b4df402c3d57c1c947f448cea525))

## [Unreleased]

Not yet published to npm - see `RELEASING.md` for what that involves. Everything below is the full v1 feature set as it currently stands.

### Added

- Track HTML documents by content, not filesystem path: a synthetic path (like a git repo path) identifies a document family across renames and machines, with automatic version capture on any change to an already-tracked file, and only ever a suggestion (never an auto-link) for a newly noticed file that merely resembles an existing one.
- `docmanager track` / `status` / `families` (`view`, `diff`, `revert`, `delete-version`, `export`, `rename`, `tags`, `lavish`) / `untrack` / `search` - the full CLI surface for tracking, inspecting, and managing document history.
- A local web UI (`docmanager ui`) for browsing tracked documents, reading version history, comparing versions side by side, and bulk actions - live-updating via SSE, no manual refresh needed.
- Cross-machine sync via a git remote you configure (`docmanager settings set --snapshot-remote`, `docmanager snapshot push` / `pull`), including HTTPS access-token auth and a read-only SSH auth diagnostic for a fresh machine with nothing configured yet.
- A first-push privacy nudge (`--acknowledge-privacy`) - the remote's own privacy is entirely your responsibility, and the very first push says so before anything leaves the machine.
- Edit any tracked version with Lavish Editor via your own coding agent (`docmanager families lavish`), using this project's own bundled `lavish-axi` dependency directly.
- An installable Agent Skill (`docmanager setup hooks`) that teaches a coding agent the full command surface and the invariants that matter, so an agent driving this CLI understands the guarantees, not just the flags.
- `docmanager doctor` - checks git/store/index/local-state health, auto-repairing what's provably safe and reporting the rest.
- `docmanager reset --confirm` - the safe, supported way to delete everything and start fresh, instead of manually removing the whole docmanager folder.
- `docmanager gc` - compacts the local store's git history and reclaims disk space, non-destructively, on request.
- A background core service that starts itself on first use, restarts itself transparently after an upgrade if it detects it's running stale code, and stops itself after a period of inactivity.
- A real `node:test` suite and a GitHub Actions CI pipeline (macOS/Windows/Ubuntu matrix plus a Node-floor job) covering the concurrency, dedup, and sync-conflict guarantees this project depends on.
