# Maintain the shared-plugin daily-driver installation

English | [中文](installing-and-maintaining-daily-driver.zh.md)

This Linux/WSL procedure uses the official `@deepseek-ai/dsh@0.1.7-rc.2` CLI and official Web app with five DSH fork tarballs, the Pi AI fork, and four ordinary plugin tarballs from the persistent `../artifacts/daily-driver-v0.1.7-rc.2-fork1` directory. MCP Panel is pinned to npm version `0.6.19`. Node 24 and Corepack pnpm 11.24.0 are required. The script does not download or publish assets, launch or stop the Host, or change running sessions.

The global pnpm overrides own only five official-package forks plus Pi AI. Every consuming profile installs the same five independent plugins as ordinary dependencies (four local tarballs and MCP Panel); official forks are not profile dependencies. `$DSH_HOME/cordis.patch.yml` declares shared plugins and the personal preset once for all profiles. Existing global patch rows, including MCP, take precedence; shared plugin settings formerly in a profile patch move to their global insert rows, preserving `!!js` expressions. Only future genuinely profile-specific configuration belongs in `$DSH_HOME/profiles/<profile>/cordis.patch.yml`. Web bundles stay base and the official Web app; another profile keeps its existing bundles.

## 1. Preview the existing Web profile

From the source checkout run:

```sh
node scripts/upgrade-daily-driver.mjs --dry-run
```

The preview reads paths, versions and row counts without writing files or displaying configuration values. A missing `settings.yaml` is normal; when present, supported legacy sections migrate to Web rows and the file is archived on apply. Unknown sections fail rather than being discarded. For isolated fixtures pass `--home`, `--global-dir`, `--global-bin-dir`, and `--artifacts` explicitly.

## 2. Apply when ready, then install another consumer if needed

Stop the existing Host yourself through its original external launch mechanism before changing its installation. These commands are for a later deliberate maintenance window, not for running against the current Host during development:

```sh
node scripts/upgrade-daily-driver.mjs --apply
node scripts/upgrade-daily-driver.mjs --profile OTHER_EXISTING_PROFILE --apply
```

The second command is optional and requires an existing profile; it does not migrate `paper-chew` or modify its bundles automatically. Each apply backs up the selected complete profile, global workspace, home patch and existing settings, and snapshots sessions/storages without changing them. pnpm manages profile dependencies, lockfile and modules with `auto-install-peers=false`; unrelated profile dependencies and unrelated global overrides survive. The Web profile retains only base/Web app bundles. Restart the Host yourself and privately verify the final composition; `--dump-config` can expose credentials, so do not publish its output.

## 3. Roll back the selected profile if needed

Stop the Host yourself and pass the backup path printed by the corresponding apply:

```sh
node scripts/upgrade-daily-driver.mjs --rollback /absolute/path/to/backup
```

For a non-Web profile include `--profile OTHER_EXISTING_PROFILE`; repeat any explicit `--home`, `--global-dir`, and `--global-bin-dir` paths from apply. Rollback restores that profile, home patch, global workspace and previous settings and reinstalls the recorded top-level CLI version. It does **not** overwrite current sessions/storages with their pre-apply snapshots: newer sessions may exist. Restore those snapshots only after separate manual review.

The [release workflow](../../.github/workflows/daily-driver-release.yml) retains the five-fork fork1 route and separately publishes a subagent-only `daily-driver-v0.1.7-rc.2-fork2` tag. The fork2 release contains only `deepseek-ai-dsh-subagent-0.1.7-rc.2-fork2.tgz` and `SHA256SUMS`: replace only the `@deepseek-ai/dsh-subagent` global override after verifying its checksum, leaving the other four DSH fork1 overrides, Pi AI fork1, CLI/Web, and independent plugins unchanged. The upgrade script above remains for the complete fork1 asset set; do not apply it to a subagent-only release. The fork2 job tests the continuation regression and installs the tarball in an isolated CLI project to verify built-entry import and actual override resolution, not Loader activation or a live Host installation.

The workflow also publishes a session-query-only `daily-driver-v0.1.7-rc.2-fork3` tag. That release contains only `deepseek-ai-dsh-session-query-sqlite-0.1.7-rc.2-fork1.tgz` and `SHA256SUMS`: verify the checksum, then replace only the `@deepseek-ai/dsh-session-query-sqlite` global override, leaving the five DSH fork overrides, Pi AI fork1, CLI/Web, and independent plugins unchanged. Its job runs the `packages/session-query` regression, installs the tarball in an isolated CLI project to check built-entry import and actual override resolution, and asserts the `maxIndexedSessionBytes` default plus schema rejection of an out-of-range bound. It does not verify Loader activation or a real Host installation, and the `build` and `publish` jobs skip both the fork2 and fork3 tags. Sessions whose stored log exceeds `maxIndexedSessionBytes` stay out of full-text search and are reported once through the plugin's `ctx.logger.warn`.

## 4. Verify the fork4 release without applying it

The dedicated `daily-driver-v0.1.7-rc.2-fork4` job publishes only `deepseek-ai-dsh-session-persistence-jsonl-0.1.7-rc.2-fork1.tgz`, `deepseek-ai-dsh-session-query-sqlite-0.1.7-rc.2-fork2.tgz`, and `SHA256SUMS`. Generic `build` and `publish` skip this tag; the fork2 and fork3 routes remain unchanged. The paired forks combine direct-child stat revisions with lifecycle-dirty document reconciliation while retaining the index size bound. Another process editing persisted files is not discovered in real time; query-service restart or persistence-source replacement rescans metadata. Official CLI/Web, Session and persistence/query definitions, other overrides, and independent plugins stay unchanged.

After downloading and verifying both tarballs, run the reusable [isolated smoke](../../scripts/smoke-session-index-fork4.mjs) from the source checkout:

```sh
node scripts/smoke-session-index-fork4.mjs \
  dist/daily-driver/deepseek-ai-dsh-session-persistence-jsonl-0.1.7-rc.2-fork1.tgz \
  dist/daily-driver/deepseek-ai-dsh-session-query-sqlite-0.1.7-rc.2-fork2.tgz
```

The smoke installs the overrides alongside official `dsh@0.1.7-rc.2` in a temporary project, checks actual module resolution, built imports, shared official definitions and Cordis identity, unchanged search, and durable closing tails, then removes that project. It does not launch a Host or change the real installation, profiles, or sessions. Fork4 release validation does not apply the artifacts to this machine; replace only these two global overrides in a later explicit maintenance window, and do not run the complete fork1 upgrade script against this two-package release.

## 5. Validate source without publishing

Use Node 24 and pnpm 11.24.0 in a clean worktree. The committed workspace override pins `@earendil-works/pi-ai@0.85.1-fork1` to its existing immutable Release URL for `llm-pi-ai`; the official 0.85.1 patch does not apply. Regenerate the source lockfile with `pnpm install --lockfile-only --ignore-scripts` when changing this combination, then use the frozen preparation entry:

```sh
CI=true node scripts/daily-driver-source.mjs install packages/session/session-persistence-jsonl packages/session-query/session-query-sqlite
pnpm --config.verify-deps-before-run=false run build:native-system
pnpm --config.verify-deps-before-run=false exec vitest run packages/session/session-persistence-jsonl/tests/catalog-migration.spec.ts packages/session/session-persistence-jsonl/tests/jsonl.spec.ts packages/session-query/session-query/ packages/session-query/session-query-sqlite/ packages/session-query/tool-session-query/
node scripts/daily-driver-source.mjs build packages/session/session-persistence-jsonl packages/session-query/session-query-sqlite
```

Run the paired tarball smoke from section 4 after packing. Replace the package directories for another Host target and select its focused tests and isolated tarball smoke explicitly. Installation selects target dependency closures, native build tools, Typert, and the root tool importer, not the root workspace dependency closure. Disable pnpm `verify-deps-before-run` on subsequent source commands so pnpm does not silently install the entire workspace. The build restricts tsdown workspace discovery to each target; `-F` alone still loads unrelated package configs. Targets declaring `dsh.client` build both Host and Client faces before packing. Tests outside the selected closure need additional installation targets; the default selection excludes the unrelated session-log-export UI tests.

The [source verification workflow](../../.github/workflows/daily-driver-verify.yml) runs on `daily-driver` pushes or manual dispatch with read-only repository permission and never publishes. Dispatch accepts space-separated `packages`, `tests`, and a repository Node `smoke` script plus arguments; custom packages require explicit tests and smoke. Its cache stores only the global pnpm store, keyed by runner OS, pnpm version, and source lockfile, with a same-OS/version restore prefix. Push the reviewed commit to the default branch to seed a cache that later tag workflows can read; dispatch the same workflow again to compare cache reuse. Copy its store/cache steps and source preparation/build commands into the next package release job, retaining that job's immutable-tag identity checks and targeted smoke. The existing fork1/fork2/fork3/fork4 release jobs remain historical routes with their old preparation logic; rerunning their fixed tags does not use this optimization. Do not dispatch the release workflow to measure installation performance.

## 6. Publish the Access package set

The `daily-driver-v0.1.7-rc.2-fork6` job publishes only `dsh-client-connection`, `dsh-host-frontend-static`, and `dsh-api-gateway` at `0.1.7-rc.2-fork2`, plus `SHA256SUMS`. Use these three global overrides together, retaining `dsh-client-ui-settings@0.1.7-rc.2-fork1` from immutable fork5, official CLI/Web, and unrelated overrides. Historical fork1–fork5 jobs remain unchanged; generic build/publish skip fork6. The job reuses frozen source preparation, the global store cache, focused regressions, and both build faces; UI settings is a downloaded, checksum-verified smoke fixture, not a republished package.

1. Verify the three new tarball checksums and the retained UI settings checksum from fork5. Run [the cold official-CLI smoke](../../scripts/smoke-access-navigation-fork6.mjs) with connection, frontend-static, gateway, then UI settings tarballs. It installs official rc.2 with four overrides under `dist/smoke`, checks actual versions/shared peers and all four compatibility decisions, grants required exact exemptions through the official CLI in an isolated home, and boots a real Web profile. Only external Access JWKS fetch is mocked. Acceptance includes cookieless cross-site Access document navigation, localhost Cookie fallback, management permission, the served gateway/controller graph, the unchanged API cross-site fence, and invalid-JWT rejection; it does not claim live Cloudflare-browser acceptance.
2. Configure Access through the [Connection configuration](../../packages/client/connection/README.md), and remove old root-login plugins that only call synchronous authorization. The official rc.2 checker rejects frontend-static and gateway fork2's exact Connection peer requirement against the rc.2 runtime version. After accepting the risk of crashes or data loss for this exact combination, grant these profile-local exemptions in the separately authorized maintenance window:

```sh
dsh plugin --profile web allow-version @deepseek-ai/dsh-host-frontend-static@0.1.7-rc.2-fork2 --dsh-version 0.1.7-rc.2 --accept-risk
dsh plugin --profile web allow-version @deepseek-ai/dsh-api-gateway@0.1.7-rc.2-fork2 --dsh-version 0.1.7-rc.2 --accept-risk
```

3. Stop, install the three paired overrides, and restart the Host only during that maintenance window. Installation alone does not activate the artifacts. Exemptions authorize only the exact package/runtime pair and must be reconsidered after either version changes; see [compatibility and exemptions](../../packages/boot/plugin-manager/README.md#version-compatibility-and-exemptions). Do not apply the complete fork1 upgrade script to this three-package release.

## 7. Prepare the SQLite-only fork11 release

The dedicated `daily-driver-v0.1.7-rc.2-fork11` route publishes only `deepseek-ai-dsh-session-query-sqlite-0.1.7-rc.2-fork4.tgz` and `SHA256SUMS`. Generic build/publish skip its tag. Retain query fork1 from immutable fork9 and JSONL fork3 from immutable fork10, official CLI/Web, and all unrelated overrides. Publication and daily Host activation are separate steps.

1. Prepare and build only the SQLite target with `scripts/daily-driver-source.mjs`. Run its focused tests. For the read-only verification workflow, explicitly set `packages` to `packages/session-query/session-query-sqlite`, `tests` to `packages/session-query/session-query-sqlite/tests`, and `smoke` to the script and argument below. The default verification builds the current JSONL/SQLite pair and runs the fork11 smoke against SQLite fork4 with retained Release fixtures.

```sh
node scripts/smoke-session-query-fork11.mjs dist/daily-driver/deepseek-ai-dsh-session-query-sqlite-0.1.7-rc.2-fork4.tgz
```

2. The [fork11 smoke](../../scripts/smoke-session-query-fork11.mjs) downloads the retained query/JSONL fixtures with `gh` and verifies their Release checksums. It reuses the isolated official-CLI installation, shared Session/Cordis identity checks, cold Web Loader, and saved exact-version exemption. Behavior checks cover BM25 literal-phrase ranking, stable ordering when identical history becomes live beside an unrelated long document, latest live text shadowing old history, unchanged search, and durable closing tails. It removes its temporary projects and does not touch the daily Host.
3. After separately authorizing publication and verifying the new checksum, replace only the SQLite global override in a maintenance window. Accept the exact `@deepseek-ai/dsh-session-query-sqlite@0.1.7-rc.2-fork4` / DSH `0.1.7-rc.2` compatibility risk through the official command below; do not widen peer ranges or reuse the fork3 exemption. Restarting the Host activates the installed package. Do not apply the complete fork1 upgrade script to this one-package release.

```sh
dsh plugin --profile web allow-version @deepseek-ai/dsh-session-query-sqlite@0.1.7-rc.2-fork4 --dsh-version 0.1.7-rc.2 --accept-risk
```
