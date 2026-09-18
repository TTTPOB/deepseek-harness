# Agent Note：固定基线的 daily-driver 子包发布

Status: implemented

[English](2026-09-12-pinned-daily-driver.md) | 中文

## Problem

daily-driver fork 需要三个 DSH 子包改动及匹配的 Pi AI 实现，同时保留官方 DSH 0.1.5-rc.2 运行时。复用官方包版本会掩盖哪些资产含有 fork 改动，llm-pi-ai 继续依赖官方 Pi AI 则缺少 Responses instructions 修复。可变 tag 或带提交哈希的命名也不利于维护简单的修订序列。

## Decision

不可变基线是 `dsh-v0.1.5-rc.2` 的 `fb2c4b9e698e30edb738bca4cf0618587db7d203`。subagent、llm-pi-ai 与 MCP client 的 package manifest 使用 `0.1.5-rc.2-fork1`；其他 DSH 包和 CLI 保持 `0.1.5-rc.2`。Pi AI 在 staging 中改写为 `0.85.1-fork1`，llm-pi-ai 精确要求该版本。源码 workspace、CI、发布构建与运行时冒烟测试都从不可变 Pi fork Release tarball 解析该依赖。

Fork 版本遵循 `<上游版本>-forkN`。每次修订递增 `N` 并创建新资产。Pi tag 为 `pi-ai-v0.85.1-fork1`，DSH tag 为 `daily-driver-v0.1.5-rc.2-fork1`。不得替换既有 tag、Release 或资产。

两个发布 workflow 都响应匹配的 tag push，并保留可选手动触发。Tag run 会检查 tag 与源码推导的版本完全相等。Pi workflow 在 staging 中改写包版本、离线构建、检查 tarball manifest，并先发布 Pi。DSH workflow 下载该不可变 Pi 资产，运行聚焦包测试，构建官方包，打包三个 DSH 覆盖包，并在发布完整集合前把四个 tarball 一起安装到隔离运行时。

隔离运行时直接依赖每个 tarball，并将相同四个 file override 应用于整个安装。直接依赖防止 pnpm 为尚未发布到 npm 的 fork 版本查询 registry；override 让所有 Host 与 profile 依赖路径解析到相同 tarball。Workflow 发布运行时 manifest、workspace 配置、lockfile 与校验和，作为可复现安装记录。

## Alternatives considered

让改动包继续使用官方版本会使安装证据含糊。对官方 Pi AI 使用 caret 依赖可能解析到不含必要修复的包。把 fork 发布到 npm 会增加这条个人 Release 路线不需要的 registry 操作。只允许手动触发会增加一次可避免的发布步骤，而分支 push 自动发布可能在操作者选择不可变修订前开始发布。

## Consequences

完整四包集合是唯一支持的单元。操作者安装官方 DSH 基线与全部四个 tarball，保留生成的 pnpm 文件，并移除会遮蔽 installation fallback 的 profile-local 副本。CLI 报告 DSH 基线版本，因此 fork 证据来自子包 manifest 与实际解析检查。Pi 必须先于 DSH 发布，因为 DSH workflow 会下载其资产。

rc.2 发布分支可以通过明确的 ours 策略 merge 保留旧 daily-driver 谱系，再把 `daily-driver` 快进到该提交。这会记录 rc.2 取代旧发布树，不导入 rc.1 文件，也不重写远端历史。

## Testing

发布校验器区分官方基线版本与三个 DSH fork 版本，并检查精确 Pi 依赖。本地打包会构建官方 DSH 输出与 Pi AI，再创建四个版本化 tarball。隔离冒烟测试以直接 tarball 依赖和匹配 override 安装官方运行时，导入三个 DSH built entry，检查改动后的构建文本与 MCP 身份，从 llm-pi-ai 解析 Pi，检查 Pi 版本及 Responses instructions 代码，并记录经过测试的 pnpm 依赖图。发布 workflow 继续运行聚焦包行为测试。
