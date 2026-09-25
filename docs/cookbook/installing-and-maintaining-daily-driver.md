# Upgrade the personal Web installation

English | [中文](installing-and-maintaining-daily-driver.zh.md)

The source checkout can already be at 0.1.7 while the daily global installation and running Host remain at 0.1.5; only a later, external-terminal `--apply` upgrades that daily installation. This Linux/WSL procedure upgrades the official top-level `@deepseek-ai/dsh` CLI to `0.1.7-rc.2` with eleven existing fork tarballs in `../artifacts/daily-driver-v0.1.7-rc.2-fork1` (relative to this repository). Node 24 and pnpm 11.24 are prerequisites; the script does not install the source repository's dependencies or fetch new release assets. Keep the tarballs in this persistent location while the global installation uses them. The profile migration applies only to `web`; `paper-chew`, `headless`, the home-level `cordis.patch.yml`, and the legacy `.agent-presets` directory stay unchanged.

## 1. Stop the old Host and preview

Stop the existing Host **from the external terminal using its original launch mechanism**; the script does not find or kill a process. Then, from the source repository:

```sh
node scripts/upgrade-daily-driver.mjs
```

The preview lists paths, old/target versions, override and row counts, section-to-row mappings, and the prospective backup location without exposing configuration values. Unknown settings sections stop the upgrade rather than being silently dropped. `!!js` expressions remain tagged data, not executed by the installer. For an isolated installation, pass explicit `--home`, `--global-dir`, `--global-bin-dir`, and `--artifacts` paths; do not point tests at the daily installation.

## 2. Upgrade once

```sh
node scripts/upgrade-daily-driver.mjs --apply
```

The script first copies the complete old Web profile, global workspace overrides, old settings and installed CLI version into the displayed backup directory; it also copies `sessions` and `storages` verbatim without inspecting or changing the originals. The pnpm global workspace preserves unrelated overrides and `allowBuilds`, sets `blockExoticSubdeps: false`, and maps eleven package/version keys to persistent absolute tarball paths. pnpm installs the official CLI with `--config.enable-global-virtual-store=false --ignore-workspace add -g @deepseek-ai/dsh@0.1.7-rc.2`. The new Web profile has empty dependencies, only base and web-app bundles, and a migrated patch: the bundled standard-ptc preset and tool rows are not inserted twice. Current settings are read when the command executes; renamed sections and existing row fields are preserved, and the old `settings.yaml` is archived so the new version cannot auto-import it again. No `dsh plugin remove` or edits to the old profile's lockfile or modules are needed.

Restart the Host yourself using your existing launch method. Validate its profile and UI without printing expanded credentials; only run `dsh --profile web --dump-config` when its output can be kept private. This entry was checked with isolated fixtures; it does **not** claim the daily Host was upgraded or revalidate network/LLM behavior.

## 3. Roll back if necessary

Stop the Host again, then use the exact backup path printed by `--apply`:

```sh
node scripts/upgrade-daily-driver.mjs --rollback /absolute/path/to/backup
```

If the upgrade used isolated path options, pass the same `--home`, `--global-dir`, and `--global-bin-dir` options to rollback. This reinstalls the former top-level CLI version, restores the global workspace file, old Web profile and old settings; it leaves other profiles unchanged. Rollback **does not revert session/storage data**: newer DSH might have written a newer format after launch. The backup retains their pre-upgrade snapshot for a deliberate manual data recovery; do not overwrite new sessions silently. Restart the old Host manually after checking any data compatibility concern. A failed apply prints its backup location and rollback command.

The existing [release workflow](../../.github/workflows/daily-driver-release.yml) owns immutable asset publishing; this local entry does not push, publish, or rebuild packages.
