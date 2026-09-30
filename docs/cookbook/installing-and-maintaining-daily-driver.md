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
