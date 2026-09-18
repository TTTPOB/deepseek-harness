# Install and maintain the pinned daily-driver

English | [中文](installing-and-maintaining-daily-driver.zh.md)

This tutorial installs an official DSH 0.1.5-rc.2 runtime with four installation-wide fork overrides. Node.js 24, Corepack, GitHub CLI, and access to npm and GitHub Releases are required. The [release decision](../../.agents/notes/implemented/process/2026-09-12-pinned-daily-driver.md) owns the fixed baseline and override set.

## 1. Download the immutable release

Use the exact fork revision selected for the installation:

```sh
tag=daily-driver-v0.1.5-rc.2-fork2
release_dir=$(mktemp -d)
gh release download "$tag" --repo TTTPOB/deepseek-harness --dir "$release_dir"
(cd "$release_dir" && sha256sum -c SHA256SUMS)
```

The release contains MCP client `0.1.5-rc.2-fork2`, subagent and llm-pi-ai `0.1.5-rc.2-fork1`, Pi AI `0.85.1-fork1`, the tested runtime manifest, pnpm workspace configuration and lockfile, and `SHA256SUMS`. Install all four tarballs together. The llm-pi-ai tarball requires the exact Pi fork version and does not silently resolve the official Pi package.

## 2. Install outside the development checkout

Use a dedicated runtime directory and preserve all three tested pnpm files:

```sh
runtime_dir="$HOME/.local/share/dsh-runtime"
mkdir -p "$runtime_dir"
cp "$release_dir/runtime-package.json" "$runtime_dir/package.json"
cp "$release_dir/runtime-pnpm-workspace.yaml" "$runtime_dir/pnpm-workspace.yaml"
cp "$release_dir/runtime-pnpm-lock.yaml" "$runtime_dir/pnpm-lock.yaml"
corepack pnpm@11.7.0 --dir "$runtime_dir" install --frozen-lockfile --ignore-scripts
corepack pnpm@11.7.0 --dir "$runtime_dir" exec dsh --version
```

The CLI still reports the official base version `0.1.5-rc.2`. The runtime manifest directly anchors the four unpublished fork tarballs, while the matching pnpm overrides make Host and profile dependency paths resolve the same files. Do not install only one tarball or remove the direct dependencies.

## 3. Verify the resolved packages

```sh
corepack pnpm@11.7.0 --dir "$runtime_dir" list \
  @deepseek-ai/dsh-subagent \
  @deepseek-ai/dsh-llm-pi-ai \
  @deepseek-ai/dsh-mcp-client \
  @earendil-works/pi-ai
```

MCP client must report `0.1.5-rc.2-fork2`, subagent and llm-pi-ai must report `0.1.5-rc.2-fork1`, and Pi AI must report `0.85.1-fork1`. Existing profile-local copies of the same packages take precedence over installation fallback; remove them through `dsh plugin --profile <name> remove ...` before claiming that the installation-wide overrides are active.

## 4. Publish another fork revision

Keep each upstream version fixed and increment `forkN` only for a package whose contents change. Build that package, assemble unchanged support tarballs from the preceding immutable daily-driver Release, smoke the complete four-package set, commit the changes, and integrate them into `daily-driver` without rewriting history:

```sh
git tag daily-driver-v0.1.5-rc.2-fork3 <verified-dsh-commit>
git push fork daily-driver-v0.1.5-rc.2-fork3
```

The tag automatically runs the release workflow. The workflow downloads unchanged support assets, runs focused tests, builds and packs the changed package, performs an isolated installation smoke, and creates the immutable Release. If Pi AI changes, publish its new immutable Pi Release before the DSH tag and update the exact llm-pi-ai dependency. `workflow_dispatch` is a recovery option; do not dispatch it concurrently with the matching tag run. Never reuse a tag or overwrite release assets.
