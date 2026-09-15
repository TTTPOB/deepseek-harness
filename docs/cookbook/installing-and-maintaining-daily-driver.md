# Install and maintain the pinned daily-driver

English | [中文](installing-and-maintaining-daily-driver.zh.md)

This tutorial installs a standalone official DSH 0.1.5-rc.1 runtime and the daily-driver Pi and MCP client overrides. Node.js 24, Corepack, GitHub CLI, and access to npm and GitHub Releases are required. The [release decision](../../.agents/notes/implemented/process/2026-09-12-pinned-daily-driver.md) explains the fixed baseline and two-package override.

## 1. Download a verified release

Choose the latest daily-driver release for this fixed baseline, then keep the selected tag for reproducibility:

```sh
tag=$(gh release list --repo TTTPOB/deepseek-harness --limit 100 --json tagName \
  --jq 'map(select(.tagName | startswith("daily-driver-v0.1.5-rc.1-g")))[0].tagName // empty')
test -n "$tag"
release_dir=$(mktemp -d)
gh release download "$tag" --repo TTTPOB/deepseek-harness --dir "$release_dir"
(cd "$release_dir" && sha256sum -c SHA256SUMS)
```

The release contains Pi and MCP override tarballs, `runtime-package.json`, `runtime-pnpm-lock.yaml`, and `SHA256SUMS`. The runtime manifest fixes the entire DSH package family to 0.1.5-rc.1; the lockfile fixes the tested dependency graph. Installing only `@deepseek-ai/dsh@0.1.5-rc.1` would still permit newer internal packages through its caret ranges.

## 2. Install outside the development checkout

Use a dedicated runtime directory. These commands initialize a new directory; reuse its frozen lockfile for subsequent installations:

```sh
runtime_dir="$HOME/.local/share/dsh-runtime"
mkdir -p "$runtime_dir"
cp "$release_dir/runtime-package.json" "$runtime_dir/package.json"
cp "$release_dir/runtime-pnpm-lock.yaml" "$runtime_dir/pnpm-lock.yaml"
corepack pnpm@10.13.1 --dir "$runtime_dir" install --frozen-lockfile --ignore-scripts
corepack pnpm@10.13.1 --dir "$runtime_dir" exec dsh --version
```

The version command reports `0.1.5-rc.1`. pnpm uses its normal user-level store and cache. The runtime directory contains installed official packages, not a source checkout. Keep both manifest and lockfile; do not run an unpinned dependency update.

## 3. Install the adapter into the desired profile

After preparing the target profile, install the immutable Release URL through official reconciliation:

```sh
pi_url="https://github.com/TTTPOB/deepseek-harness/releases/download/$tag/deepseek-ai-dsh-llm-pi-ai-0.1.5-rc.1.tgz"
mcp_url="https://github.com/TTTPOB/deepseek-harness/releases/download/$tag/deepseek-ai-dsh-mcp-client-0.1.5-rc.1.tgz"
corepack pnpm@10.13.1 --dir "$runtime_dir" exec dsh plugin --profile web add "$pi_url" "$mcp_url"
```

Both overrides are plain profile dependencies; `declares no dsh.bundle` is expected. The Pi package brings Pi AI 0.85.1-dsh.1 through its immutable dependency URL, while the MCP package brings MCP SDK v2.0.0 and supports modern 2026-07-28 negotiation with legacy fallback. Other profiles need their own package installation. Existing profile migration is a separate operator task; this release installs no Session or token-meter override.

## 4. Start the Web application

```sh
corepack pnpm@10.13.1 --dir "$HOME/.local/share/dsh-runtime" run web
```

The standard Web address is `http://127.0.0.1:3080`. The command uses the configured DSH home and profiles. Stop the previous Host before replacing a running installation, and restart after changing a Host plugin. No build or development checkout is needed for this command.

## 5. Develop and publish another override revision

Implement changes in a persistent feature worktree based on daily-driver. Keep the baseline fixed and run the Pi and MCP tests, official build, documentation checks, and installed smoke:

```sh
pnpm install --frozen-lockfile
pnpm exec vitest run packages/llm/llm-pi-ai/tests packages/mcp/mcp-client/tests/mcp-client.spec.ts packages/mcp/mcp-client/tests/apply.spec.ts packages/mcp/mcp-client/tests/reconnect.spec.ts packages/mcp/mcp-client/tests/egress.spec.ts
pnpm exec vitest run --config vitest.e2e.config.ts packages/mcp/mcp-client/tests/mcp-client.e2e.ts
pnpm run build:official
pnpm run doc-sync
node scripts/daily-driver.mjs verify
mkdir -p dist/daily-driver
pnpm --dir packages/llm/llm-pi-ai pack --pack-destination "$PWD/dist/daily-driver"
pnpm --dir packages/mcp/mcp-client pack --pack-destination "$PWD/dist/daily-driver"
node scripts/daily-driver.mjs smoke dist/daily-driver/deepseek-ai-dsh-llm-pi-ai-0.1.5-rc.1.tgz dist/daily-driver/deepseek-ai-dsh-mcp-client-0.1.5-rc.1.tgz
```

The smoke uses a temporary home and official registry installation, tests Web composition and both built overrides, and writes the verified runtime manifest and lockfile beside the tarballs. It does not change normal profiles. After committing and integrating the validated change into daily-driver, invoke the manual workflow:

```sh
gh workflow run daily-driver-release.yml --repo TTTPOB/deepseek-harness --ref daily-driver
```

The workflow never follows master, changes a branch, or replaces a published release. A new commit produces a new tag; the Pi fork likewise publishes immutable patch releases through its own CI and release workflows. The checkout uses pnpm 11.7.0; the released runtime and smoke use pnpm 10.13.1.
