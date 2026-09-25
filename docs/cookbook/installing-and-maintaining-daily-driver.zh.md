# 安装个人 Web 发行组合

[English](installing-and-maintaining-daily-driver.md) | 中文

顶层 CLI 保持官方 `@deepseek-ai/dsh@0.1.7-rc.2`。Web bundle fork 自行依赖五个运行时插件并声明个人组合；Web profile 只选择 `dsh-base`、`dsh-web-app`，其 dependencies 为 `{}`。切换日用安装前，先使用独立 pnpm global 目录及 `$DSH_HOME` 验证。

## 1. 准备不可变资产

从同一目标基线构建并打包六个 DSH fork：`dsh-subagent`、`dsh-llm-pi-ai`、`dsh-mcp-client`、`dsh-agent`、`dsh-agent-preset-registry`、`dsh-web-app`，版本均为 `0.1.7-rc.2-fork1`，不能复用旧 DSH tarball。Pi AI `0.85.1-fork1` 使用[已有不可变 Release](https://github.com/TTTPOB/deepseek-harness/releases/download/daily-driver-v0.1.5-rc.2-fork1/earendil-works-pi-ai-0.85.1-fork1.tgz)。另备 progressive-tools `0.3.0`、workspace-overlay 和 workspace-envrc `0.2.0`、适配版 Firecrawl `0.1.0-fork1` 的 tarball；MCP Panel `0.6.19` 直接从 npm 安装。发布版 Web manifest 不得写入本机 `file:` 路径。

Release workflow 从三个个人插件各自的不可变 Release 下载资产；Firecrawl tarball 使用必填 URL 输入 `firecrawl_tarball_url`（tag 触发可使用仓库变量 `DSH_FIRECRAWL_TARBALL_URL`）。外部资产须先存在，才可执行 DSH 发行；本地验证不运行发行工作流。

## 2. 验证实际解析

给 `node scripts/daily-driver.mjs smoke` 传入 11 个 tarball 路径，顺序由脚本 usage 错误列出：六个 DSH fork、Pi AI、progressive-tools、overlay、envrc、Firecrawl。脚本用 pnpm 11.24 在临时隔离安装中保持官方顶层 CLI，并通过 overrides 检查 Web bundle 的实际依赖解析和插件构建入口；同时在第一个 tarball 旁边保存已验证的 runtime package、workspace 配置和 lockfile。完成后删除临时安装。该检查不启动 Web Host，也不验证联网 provider。

隔离的正式安装需为上述十一个 fork/插件 tarball 配置 pnpm global overrides，顶层 `@deepseek-ai/dsh` 仍为官方版。tarball 应保存在安装期间不会变化的目录。初始化独立 `$DSH_HOME`，核对 Web profile 的 bundles 恰好为 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`，dependencies 为 `{}`。使用 `dsh --profile web --dump-config` 核对个人插件行和 `standard-ptc`，再以独立端口启动隔离 Host。端点、凭据引用、用户的 preset 选择和私有 MCP 服务器列表留在该隔离 profile patch，不放进发行 bundle。

## 3. 保留发行资产不可变

将通过验证的各包提交集成进发行分支，只有外部插件 Release 均存在时才打 `daily-driver-v0.1.7-rc.2-fork1` tag，复用现有工作流。不得复用已有 tag 或覆盖 tarball。缺少 Firecrawl URL 或插件资产时，工作流会在发布前停止。
