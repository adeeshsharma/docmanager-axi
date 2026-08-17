# Releasing

Releases are automated with [release-please](https://github.com/googleapis/release-please): every push to `main` runs `.github/workflows/release-please.yml`, which keeps an up-to-date "Release PR" open, proposing the next version bump and `CHANGELOG.md` entry based on [Conventional Commits](https://www.conventionalcommits.org/) merged since the last release. Merging that PR creates the GitHub release and tag, which triggers the same workflow to build, test, and `npm publish` automatically via npm's [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC) - no long-lived npm token stored anywhere.

## Ongoing releases (once bootstrapped - see below)

1. Merge PRs to `main` using [Conventional Commits](https://www.conventionalcommits.org/) messages (`feat:`, `fix:`, `feat!:`/`BREAKING CHANGE:` for breaking changes, `chore:`/`docs:`/`test:` for anything that shouldn't bump the version). release-please reads these to decide the next version and what goes in the changelog - an unconventional commit message is silently invisible to it, not an error.
2. release-please keeps one Release PR open on `main`, auto-updating it after every push - review it any time to see exactly what the next release would contain.
3. When ready to release: merge that PR. This alone updates `package.json`, `src/version.js`, and `CHANGELOG.md`, tags the commit, and creates a GitHub release - `.github/workflows/release-please.yml` then runs the same checks CI already runs on every PR (`build:skill:check`, `build`, `test`) and publishes to npm automatically.
4. Nothing further needed - no manual version bump, no manual tag, no manual `npm publish`. Pre-1.0 versioning follows `release-please-config.json`'s `bump-minor-pre-major`/`bump-patch-for-minor-pre-major`: a breaking change bumps the minor version, a feature bumps the patch, until the project reaches `1.0.0` deliberately.

## One-time bootstrap (do this once, before the first real release)

npm's Trusted Publishing has a real chicken-and-egg constraint: **a package must already exist on the registry before a Trusted Publisher can be configured for it** - OIDC can't perform the very first publish. Both steps below are genuinely the user's own action - an npm account login and a registry UI configuration step, not something to run or automate on your own initiative, the same standing rule as `npm publish` itself, `git push`, or installing `git`.

1. **Publish the first version manually.** From a clean checkout, logged into the intended npm account (`npm login`): `npm publish --access public`. This claims the `docmanager-axi` name for real (confirmed available - see `techContext.md`/the CHANGELOG - but never actually claimed until this step runs) and creates the package's own settings page on npmjs.com, which is what step 2 needs to exist first.
2. **Configure the Trusted Publisher.** On the package's npmjs.com settings page, add a Trusted Publisher: GitHub Actions, this repo's owner/name, workflow filename `release-please.yml` (exact match, case-sensitive - not the full path), no environment needed. Select at least one allowed action (`npm publish`).
3. From here on, every subsequent release goes through the automated flow above - the manual bootstrap publish is a one-time thing, never repeated.

**Provenance**: this repository is now public. With Trusted Publishing configured, npm generates provenance attestations (a supply-chain verification badge, visible on the npm package page) automatically as part of the OIDC publish flow - no `--provenance` flag needed in the workflow, and none is passed. (While the repo was private, provenance wasn't possible at all - `npm publish --provenance` errors outright from a private source repo rather than silently skipping it - which is why this note used to be framed as a limitation. Kept here for the record now that it no longer applies.)

## What changed from the old manual checklist

This replaces an earlier fully-manual process (move `CHANGELOG.md`'s `[Unreleased]` section under a dated heading, bump `package.json` by hand, tag, `npm publish` by hand) with the automated flow above. Deliberately not adopted until now, per this project's own original release-hardening framing ("a lightweight, documented checklist is enough, doesn't need automation machinery") - revisited once actually setting up npm publishing made the tradeoff worth it, following the same pattern already proven out in `reactive-axi`'s own `release-please.yml`.
