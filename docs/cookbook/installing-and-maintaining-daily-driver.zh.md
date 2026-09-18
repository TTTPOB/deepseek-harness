# 安装与维护固定版本的 daily-driver

[English](installing-and-maintaining-daily-driver.md) | 中文

本教程安装官方 DSH 0.1.5-rc.2 运行时及四个 installation-wide fork 覆盖包。需要 Node.js 24、Corepack、GitHub CLI，以及 npm 和 GitHub Releases 网络访问。[发布决定](../../.agents/notes/implemented/process/2026-09-12-pinned-daily-driver.zh.md)规定固定基线和覆盖包集合。

## 1. 下载不可变 Release

使用为本次安装选定的精确 fork 修订：

```sh
tag=daily-driver-v0.1.5-rc.2-fork1
release_dir=$(mktemp -d)
gh release download "$tag" --repo TTTPOB/deepseek-harness --dir "$release_dir"
(cd "$release_dir" && sha256sum -c SHA256SUMS)
```

Release 包含三个版本为 `0.1.5-rc.2-fork1` 的 DSH tarball、Pi AI `0.85.1-fork1`、经过测试的运行时 manifest、pnpm workspace 配置与 lockfile，以及 `SHA256SUMS`。四个 tarball 必须一起安装。llm-pi-ai tarball 要求精确的 Pi fork 版本，不会静默解析到官方 Pi 包。

## 2. 在开发 checkout 之外安装

使用独立运行目录，并保留全部三个经过测试的 pnpm 文件：

```sh
runtime_dir="$HOME/.local/share/dsh-runtime"
mkdir -p "$runtime_dir"
cp "$release_dir/runtime-package.json" "$runtime_dir/package.json"
cp "$release_dir/runtime-pnpm-workspace.yaml" "$runtime_dir/pnpm-workspace.yaml"
cp "$release_dir/runtime-pnpm-lock.yaml" "$runtime_dir/pnpm-lock.yaml"
corepack pnpm@11.7.0 --dir "$runtime_dir" install --frozen-lockfile --ignore-scripts
corepack pnpm@11.7.0 --dir "$runtime_dir" exec dsh --version
```

CLI 仍报告官方基线版本 `0.1.5-rc.2`。运行时 manifest 以直接依赖固定四个尚未发布到 npm 的 fork tarball，匹配的 pnpm overrides 则让 Host 与 profile 依赖路径解析到相同文件。不要只安装单个 tarball，也不要删除这些直接依赖。

## 3. 验证实际解析版本

```sh
corepack pnpm@11.7.0 --dir "$runtime_dir" list \
  @deepseek-ai/dsh-subagent \
  @deepseek-ai/dsh-llm-pi-ai \
  @deepseek-ai/dsh-mcp-client \
  @earendil-works/pi-ai
```

三个 DSH 包必须报告 `0.1.5-rc.2-fork1`，Pi AI 必须报告 `0.85.1-fork1`。既有 profile-local 同名副本优先于 installation fallback；声称 installation-wide override 生效前，先通过 `dsh plugin --profile <name> remove ...` 移除旧副本。

## 4. 发布下一次 fork 修订

保持上游版本不变，只递增 `forkN`。构建并冒烟验证四个 tarball，提交改动，无历史重写地集成到 `daily-driver`，然后先推 Pi tag，再推 DSH tag：

```sh
git tag pi-ai-v0.85.1-fork2 <verified-pi-commit>
git push fork pi-ai-v0.85.1-fork2
git tag daily-driver-v0.1.5-rc.2-fork2 <verified-dsh-commit>
git push fork daily-driver-v0.1.5-rc.2-fork2
```

每个 tag 都会自动运行对应发布 workflow。DSH workflow 下载已经发布的 Pi 资产，运行聚焦测试和官方构建，打包三个 DSH 覆盖包，执行隔离安装冒烟测试，再创建不可变 Release。`workflow_dispatch` 只用于恢复；不要让它与同一 tag run 并发。不得复用 tag 或覆盖 Release 资产。
