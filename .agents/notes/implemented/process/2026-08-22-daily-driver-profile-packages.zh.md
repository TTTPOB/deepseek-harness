# Agent Note：daily-driver profile 包发布

Status: implemented

[English](2026-08-22-daily-driver-profile-packages.md) | 中文

## 问题

`daily-driver` 分支修改了三个运行时包，而完整的可移植 DSH 归档需要重建 monorepo 的完整 pnpm 依赖图。该重建会重复 pnpm 对 peer、optional、平台和多版本依赖的解析，与要分发的行为无关。

DSH profile Loader 已经支持树外包。profile 有一份 hoisted `node_modules`，`healProfilesModuleFallback()` 则在上级 `profiles/node_modules` 提供安装闭包。Loader entry 从 profile 配置 URL 开始解析，因此同名直接依赖会优先于安装 fallback。

## 决策

daily-driver GitHub Release 只包含 `@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-token-meter` 和 `@deepseek-ai/dsh-llm-pi-ai` 三个 tarball，以及 `SHA256SUMS`。它们的包名和 workspace 版本保持不变。不可变 Release tag 同时包含 DSH 版本与候选 commit，因此无需访问上游 npm scope，URL 和校验和即可标识 fork 字节。

三个 tarball 都通过 `dsh plugin --profile <name> add` 安装为各目标 profile 的普通直接依赖。它们不声明 `dsh.bundle`，因此对应 warning 属于预期输出。现有 base bundle row 保持原包名，并优先解析 profile-local 包，然后才是安装 fallback。移除三个依赖即可恢复已安装的 DSH 包，无需改动 profile patch。

`session` 与 `token-meter` 必须成对发布，因为增量 token fold 会调用 `Session.eventAt()`。Pi adapter 在技术上独立，但 Release 始终携带全部三个包，使一次安装即可复现该分支的完整运行时行为。

定时 workflow 将 `upstream/master` 合并到候选提交，运行聚焦测试和仓库检查，构建并打包三个包，再使用 profile 的 pnpm 10 工具链把 tarball 安装进一次性 profile，并通过 `web --help` 启动完整 Web composition。只有在确认三个模块均解析到 profile 的 `node_modules` 且包含 daily-driver 行为后，它才推进分支并创建不可变 Release。对已有 tag 的重跑会重新构建，并逐字节比较每个 asset。

## 考虑过的替代方案

**完整可移植运行时归档。** 它可以提供一条解压即用的命令，但挑选和物化数百个包会重新实现 pnpm 解析，并把三个包的改动扩展成按平台维护的分发系统。

**携带完整已安装 `node_modules` 的 wrapper 项目。** 这种方式符合已有第三方打包实践，仍适合桌面端或离线分发，但体积更大、依赖平台，已有兼容 DSH 安装的用户并不需要它。

**禁用三个现有 row，再以新包名插入的 profile patch。** 这会引入持久配置和替代包身份。同名直接依赖已经提供确定的优先级，并能保留已发布 row 的 ID 与配置。

**profile 级 pnpm overrides。** overrides 只影响其项目根拥有的依赖图，无法改写另一份 DSH 安装闭包。这里采用的受支持机制是 Loader 解析优先级，而不是依赖图变更。

## 后果

这些 asset 是平台无关的 npm tarball，可以应用到每一个需要 daily-driver 行为的 profile。安装要求 DSH package 版本兼容，并使用 profile 固定的 pnpm 版本。包会保留上游语义版本，因此运维方必须以 Release tag、依赖 URL、lockfile integrity 和 `SHA256SUMS` 标识 fork build，不能只看 `package.json.version`。

profile 中可能同时存在同一个 DSH 包的两个物理副本：直接 override 与安装 fallback。DSH 的扁平 fallback 提供 Cordis 等共享 peer，Release smoke 会证明三个替换插件能够共同组合。未来若改动依赖跨副本 class identity，或修改的包不是作为 profile row 加载，就必须重新分析兼容性，不能机械地再加一个 tarball。
