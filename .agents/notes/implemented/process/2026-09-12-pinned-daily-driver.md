# Agent Note: pinned daily-driver package release

Status: implemented

English | [中文](2026-09-12-pinned-daily-driver.zh.md)

## Problem

The daily-driver fork needs three DSH package changes and the matching Pi AI implementation while retaining the official DSH 0.1.5-rc.2 runtime. Reusing official package versions hides which artifacts contain fork changes, and an llm-pi-ai dependency on official Pi AI omits the Responses instructions fix. Mutable tags or commit-suffixed naming also make a simple revision sequence harder to operate.

## Decision

The immutable baseline is `dsh-v0.1.5-rc.2` at `fb2c4b9e698e30edb738bca4cf0618587db7d203`. The subagent, llm-pi-ai, and MCP client package manifests use `0.1.5-rc.2-fork1`; all other DSH packages and the CLI remain `0.1.5-rc.2`. Pi AI is staged as `0.85.1-fork1`, and llm-pi-ai requires that exact version. The source workspace maps that unpublished dependency to official Pi AI only for repository installation; release and runtime smokes override it with the Pi fork tarball.

Fork versions follow `<upstream-version>-forkN`. A revision increments `N` and creates new assets. The Pi tag is `pi-ai-v0.85.1-fork1`; the DSH tag is `daily-driver-v0.1.5-rc.2-fork1`. Existing tags, Releases, and assets are never replaced.

Both release workflows respond to matching tag pushes and retain optional manual dispatch. A tag run checks that the tag equals the version derived from source. The Pi workflow stages the package version, builds offline, checks the tarball manifest, and publishes Pi first. The DSH workflow downloads that immutable Pi asset, runs focused package tests, builds official packages, packs the three DSH overrides, and installs all four tarballs in one isolated runtime before publishing them together.

The isolated runtime directly depends on every tarball and applies the same four file overrides installation-wide. Direct dependencies prevent pnpm from querying npm for unpublished fork versions; overrides make all Host and profile dependency paths resolve those same tarballs. The workflow publishes the runtime manifest, workspace configuration, lockfile, and checksums as the reproducible installation record.

## Alternatives considered

Keeping official versions for changed packages makes installed evidence ambiguous. A caret dependency on official Pi AI can resolve a package without the required fix. Publishing the forks to npm would add registry operations that this personal Release route does not need. Manual-only workflows add an avoidable release step, while release-on-branch-push can publish before an operator chooses the immutable revision.

## Consequences

The complete four-package set is the supported unit. Operators install the official DSH base plus all four tarballs, preserve the generated pnpm files, and remove profile-local copies that shadow installation fallback. The CLI reports the base DSH version, so package manifests and resolution checks provide fork evidence. Pi must publish before DSH because the DSH workflow downloads its asset.

The rc.2 release branch may preserve the prior daily-driver lineage with an explicit ours-strategy merge and then advance `daily-driver` by fast-forward. This records that rc.2 replaces the prior release tree without importing its rc.1 files or rewriting remote history.

## Testing

The release verifier distinguishes the official base version from the three DSH fork versions and checks the exact Pi dependency. The local pack builds official DSH outputs and Pi AI, then creates all four versioned tarballs. The isolated smoke installs the official runtime with direct tarball dependencies and matching overrides, imports all three DSH built entries, checks the changed built text and MCP identity, resolves Pi from llm-pi-ai, checks the Pi version and Responses instructions code, and records the tested pnpm graph. Focused package behavior tests remain in the release workflow.
