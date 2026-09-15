# 安装与维护固定版本的 daily-driver

[English](installing-and-maintaining-daily-driver.md) | 中文

本教程安装独立的官方 DSH 0.1.5-rc.1 运行时及 daily-driver Pi 与 MCP client 覆盖包。需要 Node.js 24、Corepack、GitHub CLI，以及 npm 和 GitHub Releases 网络访问。[发布决定](../../.agents/notes/implemented/process/2026-09-12-pinned-daily-driver.zh.md)解释固定基线和双包覆盖结构。

## 1. 下载经过验证的 Release

选择这一固定基线最新的 daily-driver Release，并保留选定 tag 以便复现：

```sh
tag=$(gh release list --repo TTTPOB/deepseek-harness --limit 100 --json tagName \
  --jq 'map(select(.tagName | startswith("daily-driver-v0.1.5-rc.1-g")))[0].tagName // empty')
test -n "$tag"
release_dir=$(mktemp -d)
gh release download "$tag" --repo TTTPOB/deepseek-harness --dir "$release_dir"
(cd "$release_dir" && sha256sum -c SHA256SUMS)
```

Release 包含 Pi 与 MCP 覆盖包 tarball、`runtime-package.json`、`runtime-pnpm-lock.yaml` 和 `SHA256SUMS`。运行时 manifest 将整个 DSH 包族固定到 0.1.5-rc.1，lockfile 固定经过测试的依赖图。只安装 `@deepseek-ai/dsh@0.1.5-rc.1` 仍会通过其 caret 依赖范围接受更新的内部包。

## 2. 在开发 checkout 之外安装

使用独立运行目录。以下命令初始化新目录，之后安装继续使用其冻结的 lockfile：

```sh
runtime_dir="$HOME/.local/share/dsh-runtime"
mkdir -p "$runtime_dir"
cp "$release_dir/runtime-package.json" "$runtime_dir/package.json"
cp "$release_dir/runtime-pnpm-lock.yaml" "$runtime_dir/pnpm-lock.yaml"
corepack pnpm@10.13.1 --dir "$runtime_dir" install --frozen-lockfile --ignore-scripts
corepack pnpm@10.13.1 --dir "$runtime_dir" exec dsh --version
```

版本命令报告 `0.1.5-rc.1`。pnpm 使用默认用户级 store 与 cache。运行目录包含已安装的官方包，不是源码 checkout。保留 manifest 与 lockfile，不执行未固定版本的依赖更新。

## 3. 将适配器安装到目标 profile

准备好目标 profile 后，通过官方 reconciliation 安装不可变 Release URL：

```sh
pi_url="https://github.com/TTTPOB/deepseek-harness/releases/download/$tag/deepseek-ai-dsh-llm-pi-ai-0.1.5-rc.1.tgz"
mcp_url="https://github.com/TTTPOB/deepseek-harness/releases/download/$tag/deepseek-ai-dsh-mcp-client-0.1.5-rc.1.tgz"
corepack pnpm@10.13.1 --dir "$runtime_dir" exec dsh plugin --profile web add "$pi_url" "$mcp_url"
```

两个覆盖包都是 profile 的普通依赖，`declares no dsh.bundle` 是预期提示。Pi 包通过不可变依赖 URL 引入 Pi AI 0.85.1-dsh.1，MCP 包引入 MCP SDK v2.0.0，并支持 modern 2026-07-28 协商与 legacy 回退。其他 profile 需要分别安装这两个包。既有 profile 迁移由操作者另行处理，本 Release 不安装 Session 或 token-meter 覆盖。

## 4. 启动 Web 应用

```sh
corepack pnpm@10.13.1 --dir "$HOME/.local/share/dsh-runtime" run web
```

标准 Web 地址为 `http://127.0.0.1:3080`。命令使用已配置的 DSH home 与 profiles。替换运行中的安装前先停止旧 Host，变更 Host 插件后重新启动。这条启动命令不需要构建或开发 checkout。

## 5. 开发与发布下一次覆盖包修订

在基于 daily-driver 的持久功能 worktree 中实现改动。保持基线固定，运行 Pi 与 MCP 测试、官方构建、文档检查与安装后冒烟测试：

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

冒烟测试使用临时 home 和官方 registry 安装，测试 Web 组合与构建后的两个覆盖包，并将验证过的运行时 manifest 与 lockfile 写到 tarball 旁。它不修改正常 profile。提交并将验证后的改动集成到 daily-driver 后，调用手动工作流：

```sh
gh workflow run daily-driver-release.yml --repo TTTPOB/deepseek-harness --ref daily-driver
```

工作流不会追踪 master、修改分支或替换已发布 Release。新提交生成新 tag；Pi fork 也只通过自己的 CI 和发布工作流发布不可变补丁版本。Checkout 使用 pnpm 11.7.0，发布运行时与冒烟测试使用 pnpm 10.13.1。
