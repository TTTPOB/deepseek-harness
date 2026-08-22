# Agent Note: Daily-driver profile package releases

Status: implemented

English | [中文](2026-08-22-daily-driver-profile-packages.zh.md)

## Problem

The `daily-driver` branch changes three runtime packages, while a complete portable DSH archive requires reconstructing the monorepo's full pnpm dependency graph. That reconstruction duplicates pnpm's peer, optional, platform, and multi-version resolution and is unrelated to the behavior being distributed.

The DSH profile loader already supports out-of-tree packages. A profile has a hoisted `node_modules`, while `healProfilesModuleFallback()` provides the installation closure at the parent `profiles/node_modules`. Loader entries resolve from the profile config URL, so a direct dependency with the same package name takes precedence over the installation fallback.

## Decision

The daily-driver GitHub Release contains only `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-token-meter`, and `@deepseek-ai/dsh-llm-pi-ai` tarballs plus `SHA256SUMS`. Their package names and workspace version remain unchanged. The immutable Release tag includes the DSH version and candidate commit, so the URL and checksum identify the fork bytes without requiring access to the upstream npm scope.

All three tarballs are installed as ordinary direct dependencies of each target profile through `dsh plugin --profile <name> add`. They do not declare `dsh.bundle`, and the resulting warning is expected. The existing base bundle rows keep their names and resolve the profile-local packages before the installation fallback. Removing the three dependencies restores the installed DSH packages without changing a profile patch.

`session` and `token-meter` are released together because incremental token folding calls `Session.eventAt()`. The Pi adapter is technically independent, but the release always carries all three so one installation reproduces the branch's complete runtime behavior.

The scheduled workflow merges `upstream/master` into a candidate, runs focused tests and repository checks, builds and packs the three packages, installs the tarballs into a disposable profile with the profile's pnpm 10 toolchain, and boots the complete Web composition through `web --help`. It verifies that all three modules resolve below the profile's `node_modules` and contain their daily-driver behavior before it advances the branch and creates an immutable Release. A rerun over an existing tag rebuilds and compares every asset byte-for-byte.

## Alternatives considered

**A complete portable runtime archive.** This would offer one extracted command, but selecting and materializing hundreds of packages reimplements pnpm resolution and expands a three-package change into a platform-specific distribution system.

**A wrapper project containing the complete installed `node_modules`.** This follows established third-party packaging practice and remains suitable for a desktop or offline distribution. It is larger, platform-dependent, and unnecessary for users who already have a compatible DSH installation.

**A profile patch that disables and reinserts the three rows under new package names.** It adds persistent configuration and alternate package identities. Same-name direct dependencies already provide deterministic precedence and preserve the shipped row IDs and configuration.

**Profile-level pnpm overrides.** Overrides affect the dependency graph owned by their project root; they cannot rewrite the separate DSH installation closure. Loader resolution precedence, not dependency-graph mutation, is the supported mechanism here.

## Consequences

The assets are platform-independent npm tarballs and can be applied to every profile that needs daily-driver behavior. Installation requires a DSH build with compatible package versions and the profile's pinned pnpm version. The packages retain the upstream semantic version, so operators must use the Release tag, dependency URL, lockfile integrity, and `SHA256SUMS` rather than `package.json.version` to identify the fork build.

The profile can contain duplicate physical copies of a DSH package: the direct override and the installation fallback. DSH's flat fallback supplies shared peers such as Cordis, and the release smoke proves the three overridden plugins compose together. A future change that relies on cross-copy class identity or modifies a package that is not loaded as a profile row requires a new compatibility analysis rather than adding another tarball mechanically.
