# Agent Note：固定基线的 daily-driver 适配器发布

Status: implemented

[English](2026-09-12-pinned-daily-driver.md) | 中文

## Problem

daily-driver fork 需要在线内置模型目录和仅在结束时解析工具参数。官方 DSH 0.1.5-rc.1 已提供 Session 索引读取与增量 token 统计。跨 Session 格式变化继续携带旧核心覆盖，会替换这些受维护的实现。自动合并 master 也会让运行时超出明确选定的发布版本。

## Decision

基线是不可变的 `dsh-v0.1.5-rc.1` 提交 `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`。DSH 运行时包中只有 Pi 适配器存在差异。其不可变 Pi AI 0.85.1-dsh.1 依赖提供 final 解析选项，DSH 在每个请求中传入该选项。原始工具 delta 与结束时的权威参数保留原有协议语义。

适配器在注册 settings 前恢复已校验的提供方目录，刷新已配置的内置路由，并通过模型发现强制刷新。显式模型选择继承当前描述符，配置字段仍优先。请求快照保持不可变。发布基线对错误设置的延后诊断仍可用于修复目录失效模型。刷新失败保留最后有效目录，调用方取消只停止自身等待，fiber 卸载中止并等待自有刷新操作。

手动发布工作流不会合并上游或修改分支。它检查基线和明确的改动路径白名单，构建适配器，再通过 registry 安装的官方 Host，在独立 home 中走官方 reconciliation 安装 tarball。冒烟测试将全部传递 DSH 包固定到基线，因为仅固定 CLI 无法限制其 caret 依赖范围。测试生成的运行时 manifest 与 lockfile 随唯一适配器 tarball 和 SHA256SUMS 一起发布。tag 包含 DSH 版本与提交，既有 Release 不可覆盖。

## Alternatives considered

保留三个覆盖包会重复上游核心行为，并让发布与 Session 内部实现耦合。重建完整运行时归档会重复包管理器的依赖解析。只声明精确 CLI 依赖仍会通过 caret 范围接受更新的内部包。经过验证的运行时 manifest 与 lockfile 保留普通包管理器安装方式，同时固定选定的包族。

## Consequences

开发 checkout 与日常运行时独立。使用者通过冻结的 lockfile 安装发布的运行时项目，并自行将适配器安装到选定 profile。共享 Cordis 身份和官方核心包由安装目录提供。更新基线需要明确的代码审查、新测试和另一次不可变发布；不存在定时同步。旧 fork 历史通过集成提交保留，但其核心改动与三包发布机制不出现在相对基线的差异中。

## Testing

Pi 提供方回归覆盖原始 delta 顺序、最终参数和默认 partial 解析。适配器测试覆盖持久化、选择、强制刷新、失败保留、调用方取消与卸载。Loader 组合测试在 settings 注册前恢复仅远端存在的选中模型，并观察描述符更新。发布冒烟测试验证真实发布的 Pi 依赖、官方核心版本、完整 Web 组合启动，以及构建后覆盖包的在线目录行为。
