# Install and maintain the daily-driver checkout

English | [中文](installing-and-maintaining-daily-driver.zh.md)

This tutorial installs `daily-driver` either as three profile-local package overrides or from a source checkout, and maintains its patched `@earendil-works/pi-ai` release. The package release avoids a portable deployed directory: an existing compatible DSH installation supplies the unchanged runtime packages and shared peers.

## Prerequisites

- Node.js `^22.19.0 || >=24.0.0`.
- Corepack-enabled pnpm; the repository pins `pnpm@11.7.0`.
- Git and network access to GitHub Releases and the npm registry.
- A provider API key only when exercising a real provider. Keep credentials in the environment or the root `.env`, never in tracked configuration.

## Install the profile package release

The [`TTTPOB/deepseek-harness`](https://github.com/TTTPOB/deepseek-harness) daily-driver Release carries the three changed packages. Install all three into every profile that needs the branch behavior: `session` and `token-meter` are one compatible pair, while `llm-pi-ai` supplies the live model catalogs and patched Pi AI integration.

1. Download the latest Release assets and verify their checksums:

```sh
release_dir="$(mktemp -d)"
tag=$(gh release list --repo TTTPOB/deepseek-harness --limit 100 --json tagName \
  --jq 'map(select(.tagName | startswith("daily-driver-v")))[0].tagName // empty')
test -n "$tag"
gh release download "$tag" --repo TTTPOB/deepseek-harness \
  --pattern 'deepseek-ai-dsh-*.tgz' \
  --pattern SHA256SUMS \
  --dir "$release_dir"
(cd "$release_dir" && sha256sum -c SHA256SUMS)
```

2. Install the three same-name packages through official profile reconciliation:

```sh
session_url=$(gh release view "$tag" --repo TTTPOB/deepseek-harness --json assets \
  --jq '.assets[] | select(.name | startswith("deepseek-ai-dsh-session-")) | .url')
token_meter_url=$(gh release view "$tag" --repo TTTPOB/deepseek-harness --json assets \
  --jq '.assets[] | select(.name | startswith("deepseek-ai-dsh-token-meter-")) | .url')
llm_url=$(gh release view "$tag" --repo TTTPOB/deepseek-harness --json assets \
  --jq '.assets[] | select(.name | startswith("deepseek-ai-dsh-llm-pi-ai-")) | .url')
test -n "$session_url" && test -n "$token_meter_url" && test -n "$llm_url"
dsh plugin --profile web add \
  "$session_url" \
  "$token_meter_url" \
  "$llm_url"
```

The three `declares no dsh.bundle` warnings are expected: these packages replace existing base-bundle rows and do not add patch layers. The Release URLs remain in the profile manifest so later reconciliation can reinstall the packages after the checksum download directory is removed. The command must run with the pnpm version recorded by the target profile; this workspace's `web` profile uses `pnpm@10.13.1`.

3. Restart the DSH Host, then confirm the dependencies remain installed:

```sh
dsh plugin --profile web why @deepseek-ai/dsh-session
dsh plugin --profile web why @deepseek-ai/dsh-token-meter
dsh plugin --profile web why @deepseek-ai/dsh-llm-pi-ai
```

Repeat the installation for another profile name when that profile also needs the overrides. To roll back, remove all three package names through `dsh plugin --profile <name> remove`; the existing rows then resolve to that DSH installation's packages again. Remove the temporary download directory after installation.

## Install from the checkout

1. Select the branch and enable the pinned package manager:

```sh
git switch daily-driver
corepack enable
```

2. Install exactly the dependency graph recorded in `pnpm-lock.yaml`:

```sh
pnpm install --frozen-lockfile
```

The Pi adapter resolves `@earendil-works/pi-ai@0.84.2-dsh.1` from the immutable [`pi-ai-v0.84.2-dsh.1` GitHub Release](https://github.com/TTTPOB/pi/releases/tag/pi-ai-v0.84.2-dsh.1). The release tarball SHA-256 is `0150271e4e825359bcb53382fea2f786189759725232efe9707cab48c3dea899`; pnpm also records its SHA-512 integrity in the lockfile.

3. Check and build the checkout:

```sh
pnpm run typecheck
pnpm run build
```

4. Confirm the installed patched version:

```sh
pnpm --filter @deepseek-ai/dsh-llm-pi-ai exec node -p 'require("./node_modules/@earendil-works/pi-ai/package.json").version'
```

The command must print `0.84.2-dsh.1`.

5. Start the built Web profile against a disposable home for the first smoke test:

```sh
DSH_HOME="$(mktemp -d)" pnpm dsh web --no-open --port 8080
```

Open the printed URL, configure a provider, and confirm its Models view can discover models. Stop the process after the check. A normal launch may omit the temporary `DSH_HOME`; that uses the user's configured DSH home and durable sessions.

## Publish a Pi maintenance release

The [`TTTPOB/pi`](https://github.com/TTTPOB/pi) fork uses only `.github/workflows/dsh-ci.yml` and `.github/workflows/dsh-release.yml`; inherited upstream workflows are absent from its default branch. CI restores model data from the matching published upstream npm package, builds the telemetry workspace dependency and Pi AI, runs Biome and the Pi AI tests, then triggers the release workflow.

1. Start from the next upstream Pi release in a clean worktree, replay the DSH final-tool-argument commits, and carry the two DSH workflow files. If the patch branch name changes, update the branch filters in both workflows before making it the fork's default branch.

2. For another patch over the same upstream version, increment `PATCH_REVISION` in `.github/workflows/dsh-release.yml`. A new upstream `packages/ai/package.json` version automatically changes the release tag and package version, but reset the revision to `1` for a new upstream base.

3. Push the patch branch to `TTTPOB/pi`. `DSH Pi AI CI` must pass before `Release DSH Pi AI package` publishes `pi-ai-v<upstream>-dsh.<revision>`.

4. Treat every published tag and asset as immutable. The workflow refuses to overwrite an existing release; after publication, fix any defect under a higher revision instead of deleting, replacing, or clobbering the asset.

5. Verify the release and its checksum:

```sh
gh run list --repo TTTPOB/pi --workflow dsh-ci.yml --limit 3
gh run list --repo TTTPOB/pi --workflow dsh-release.yml --limit 3
gh release view pi-ai-v0.84.2-dsh.1 --repo TTTPOB/pi
release_dir="$(mktemp -d)"
gh release download pi-ai-v0.84.2-dsh.1 --repo TTTPOB/pi --pattern '*.tgz*' --dir "$release_dir"
(cd "$release_dir" && sha256sum -c earendil-works-pi-ai-0.84.2-dsh.1.tgz.sha256)
```

Remove the temporary download directory after the check.

## Adopt a new Pi release in daily-driver

1. Replace the exact GitHub Release URL in `packages/llm/llm-pi-ai/package.json`. Both the tag and tarball filename include the full patched version.

2. Regenerate only dependency resolution, then prove the lockfile installs without local artifacts:

```sh
pnpm install --lockfile-only
pnpm install --frozen-lockfile
```

3. Run the checks covering this dependency and its published package path:

```sh
pnpm vitest run packages/llm/llm-pi-ai/tests
pnpm run typecheck
pnpm run build
pnpm run publint
```

4. Repeat the disposable-home Web smoke test. Model discovery should write provider catalogs under the temporary `$DSH_HOME/llm-pi-ai/models-v1` without touching the normal home.

5. Commit the manifest and lockfile together. A rollback points both files to the preceding immutable release and repeats the same install and verification steps; it never changes an already published Pi asset.

## Routine operation

Use `pnpm install --frozen-lockfile` after switching or updating the branch so dependency drift fails instead of rewriting the lockfile. Use `pnpm dsh web` for the browser UI or `pnpm dsh --profile headless "task"` for one-shot operation. Live catalog refresh failures leave the last valid catalog available; inspect `$DSH_HOME/llm-pi-ai/models-v1` only for diagnosis, and copy the home before manually changing durable files.
