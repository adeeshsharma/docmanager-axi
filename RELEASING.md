# Releasing

This project has no release automation (no release-please, no version-bump bot) - deliberately. It's a lightweight, manual checklist, not automation machinery, until real release cadence proves that's actually needed.

1. Confirm `main` is green: all four required CI checks passing (`test (ubuntu-latest)`, `test (windows-latest)`, `test (macos-latest)`, `node-floor`).
2. Run the full local safety net one more time: `npm run build:skill:check && npm run build && npm test` (the same `prepublishOnly` script `npm publish` will run anyway - this just fails fast, before anything else below).
3. Move the `## [Unreleased]` section in `CHANGELOG.md` under a new `## [x.y.z] - YYYY-MM-DD` heading, leaving a fresh empty `## [Unreleased]` above it. Follow semver: a breaking CLI/API change is major, a new command or capability is minor, a fix-only release is patch.
4. Bump `"version"` in `package.json` to match.
5. Commit both files together: `chore: release vx.y.z`.
6. Tag the commit: `git tag vx.y.z`, then `git push origin main --tags`.
7. `npm publish` - only ever done with the user's own explicit, in-the-moment request; never assume a prior approval carries forward to the next release.
8. Create a GitHub release from the tag, with the CHANGELOG section for this version as the release notes.

First release only: confirm the `docmanager-axi` package name is actually available on the npm registry before step 7 (`npm view docmanager-axi` should 404) - it's been a placeholder name since `ARCHITECTURE.md` section 9 and has never actually been checked against the real registry.
