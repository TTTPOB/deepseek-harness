---
description: "九个让模型创建、发消息与协调 teammate 的工具（可选第十个模型发现工具），供挂载实验性 Team 插件的组合使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-agent-team

[English](README.md) | 中文

## 概述

本包让模型创建具名 teammate、向它们发送消息、查看可用状态、等待进展、中断卡住的工作，并通过共享任务板协调。每个团队成员都会获得相同的九个协调工具，以及在共享工作区协调的指引；当组合启用子模型选择时，成员还会获得 `list_agent_models`，且 `spawn_teammate` 接受可选的 LLM 路由。它会取代同名的旧版 subagent 控件，因此同时需要两者的组合必须禁用旧定义。本包以实验性名称公开发布，但不提供稳定性保证。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当模型应该通过工具运行一支团队时，在 `@deepseek-ai/dsh-experimental-agent-team` 之上挂载本包。挂载在 Agent preset 内时，只有作用域继承该 preset 的 Team 成员才会获得这些工具与协作策略。其他 preset 可以保留普通 subagent 控件而不发生名字冲突。挂载在 Host 作用域时，会应用于全部 Team 成员。`spawn_teammate` 原样发送初始任务；每个成员通过必需的 runtime context 接收当前角色和名字。

### 何时选择

当模型应该自行创建与协调 teammate、而不是由人来操作 subagent 控件时，选择它。当同名的旧全局 subagent 工具必须继续可用时，请不要选择：团队工具会为团队成员取代它们，因此想同时使用两者的组合必须禁用旧定义。

### 最小工作示例

对现有组合的最小增量是 [agent-team README](../agent-team/README.zh.md#smallest-working-setup) 中的两包片段：持久会话存储、团队领域包与本包。以下路由设置均为可选：

```yaml
- id: tool-agent-team
  name: '@deepseek-ai/dsh-experimental-tool-agent-team'
  config:
    freshProvider: spawn
    forkProvider: fork
    modelSelectionSettings: false
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `freshProvider` | `spawn` | 启动 fresh teammate 的提供方 |
| `forkProvider` | `fork` | 启动 fork teammate 的提供方 |
| `modelSelectionSettings` | `false` | 为每个 Team Session 读取 Host 的 `subagent-model-selection` 偏好；当该 Session 带有精确路由策略时，公开子 LLM 路由字段与 `list_agent_models` |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-tool-agent-team)是每个受支持字段及其 JSDoc 的穷尽式真源。

试试这样要求 Lead 模型：「创建一个名为 reviewer 的 teammate 检查 diff，再把变更摘要发给 reviewer」。模型会调用创建工具，然后调用消息工具。

### 模型能做什么

九个工具分为四类能力：

- **创建 teammate**——`spawn_teammate` 接收名字、描述与初始任务；只有 Lead 可以调用它。
- **发送消息**——`send_message` 在最近的步骤边界对运行中的成员进行 steering（中途引导）、启动或恢复非活动成员。
- **查看与等待**——`list_agents` 返回各成员的 `target` 与可用状态；`wait_agent` 等待下一次团队变化；`interrupt_agent` 停止 teammate 的当前轮次（仅限 Lead）。
- **管理任务板**——`team_task_create`、`team_task_list`、`team_task_get` 与 `team_task_update` 添加、浏览、读取与更新共享任务。

当 Session 启用模型选择时，`spawn_teammate` 还会接受 `provider`、`model` 与 `reasoning_effort`，并由 `list_agent_models` 发现该 Session 可选的精确路由。roster 的 `provider` 始终是执行提供方（`spawn` 或 `fork`），绝不是子 LLM 提供方。

创建和列表结果使用 `target` 标识成员，不包含成员 Session ID。可将该值用于消息和中断调用，或任务工具的 `owner` 参数；任务的 `ownerName` 使用相同值。`inactive` 表示没有轮次在执行，包括已加载和需要恢复的成员；它不表示任务完成或结果。`provisioning` 与 `failed` 描述成员创建状态。任何成员都可以给任何其他成员发消息并使用任务板；只有 Lead 可以创建与中断 teammate。任务更新保留领域的 owner 与 revision 校验，因此过期的编辑会被拒绝，而不是覆盖更新的成果。

### 选择 teammate 模型

默认关闭。设置 `modelSelectionSettings: true` 并加载 Host 拥有的 `@deepseek-ai/dsh-tool-subagent/model-selection-settings` 服务；缺少该服务时插件加载失败，而不是静默保持固定路由。每个新建顶层 Team Session 会读取该服务的 `subagent-model-selection` 偏好，并把精确允许路由记录为 `subagent/model-selection-policy`；teammate Session 继承其 Lead 已记录的路由，恢复的 Session 保留组合时的路由。设置修改只影响之后的顶层 Session，因此运行中的 Team 拥有稳定的授权集合。

此后 `spawn_teammate` 接受成对出现的 `provider` 与 `model`，以及可选的 `reasoning_effort`；省略时继承 Lead 当前已记录的路由。执行器会在 `ctx.agentTeams.spawnTeammate` 占名之前检查参数对、Session 的精确路由策略、`ctx.llm.resolveCallConfig()` 以及执行提供方的 `agentOptions` 能力，因此被拒绝的请求不会改变 roster。`list_agent_models` 只列出该 Session 已授权的路由及其适配器拥有的推理强度。

这些字段选择子 Agent 的输入 LLM 路由，不会改变 `freshProvider`/`forkProvider`，`list_agents` 仍报告执行提供方。对 `fork` teammate 而言，改变 provider 或 model 可能使提供方无法复用继承的对话前缀。

### 成功与失败的表现

`send_message` 在收件箱接收消息后返回 `{ "sent": true }`，不暴露消息 ID。成功不表示接收方已处理消息，也不保证同步刷新到存储；发送失败会作为工具错误报告。当没有其他成员 running 或 provisioning 时，`wait_agent` 会立即返回 `noProgress`，提示调用方先唤醒 teammate；否则它会等待下一次变化，调用方随后重新读取状态。基于过期 revision 的任务编辑会被拒绝，而不是覆盖更新的成果。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释适配器背后的设计决策并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

适配器建立在三项承诺之上：

- **按作用域，而非全局。** 每个注册都位于成员 Agent（智能体）自己的 `ctx` 上；安装依据 Agent 发布时可用的成员身份。
- **声明式结果，紧凑 JSON。** 每个工具都声明完整结果 schema，并把该值渲染为紧凑 JSON，因此编译器会对照向模型承诺的结果检查 `execute`，任何结果都不会在缩进上消耗 token。
- **领域掌握裁决权。** 工具委托给 `ctx.agentTeams`，后者强制执行 Lead 权限与 revision 校验；适配器不添加更弱的路径。
- **Host 拥有路由授权。** 子模型选择只通过 Host 的 `subagent-model-selection` 设置存在；适配器复用共享的 subagent 策略、preflight 与发现函数，不新增 Team allowlist。

[Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md)负责模型侧与 scoping 决策。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、固定策略文本、九个协调工具注册与可选的模型选择定义 |

### 策略与工具

member scope 上的一个 `team:policy` 段落说明共享的协作规则；固定文本与九个工具注册都声明在 [`src/index.ts`](src/index.ts)。九个工具 schema 注册在发布时被识别为 Team member 的 scope 中。与旧全局 continuable-subagent 控件同名的 scoped 注册只会为团队成员覆盖这些全局控件。

启用 `modelSelectionSettings` 时，适配器注册共享的 `subagentModelSelectionPolicy` 投影，在安装某 Agent 的工具时冻结其 Session 的路由策略，并只为已冻结策略添加 `list_agent_models` 与路由字段。策略选择、授权、LLM preflight 与发现均使用共享 subagent 函数；本包只拥有工具 schema、执行器检查与冻结策略的应用点。

### 按作用域注册与拆除

安装同时检查 Team 成员关系与插件作用域是否存在于 Agent 的作用域链中。`agent/created` 与 `tools/change` 协调注册，也覆盖空白会话的 preset 切换。每次安装都会冻结其 Agent Session 的路由策略，因此可见 schema 与执行器授权不会分离，也不会在运行中的 Session 下改变。离开组合会移除 Agent 拥有的工具与策略。Agent 释放与插件 HMR（热模块替换）按逆序撤销注册；注册在触发工具变化前预留 Agent，避免同步重入导致重复安装。Team 领域服务仍由 Host 拥有。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从领域服务逐步进入精确 schema 与设计背后的决策。

- [agent-team 包](../agent-team/README.zh.md)——这些工具背后的 `ctx.agentTeams` 领域服务。
- [Agent Teams 子系统](../../../docs/subsystems/agent-team.zh.md)——持久 Team 类型与服务 API。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-tool-agent-team)——模型接收的每个工具 schema。
- [Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md)——模型侧、scoping 与隔离决策。

-----

<a id="model-experience"></a>
## 模型体验

### Team 策略与工具

#### 模型看到什么

共享系统 policy 覆盖 Team 可用性、共享 cwd 安全、任务协调、Steer 投递、inbox 接收和 Lead 等待责任。Lead 与 teammate 使用相同的九个 schema；执行时落实 Lead-only 操作。必需的 runtime context 声明 `You are the Team Lead named "lead".`，或 `You are teammate "<name>".` 与 `Your Team Lead is named "lead".`，并提供 roster 和消息操作说明。身份来自当前 Team membership，关闭可选 context 时仍保留，压缩移除快照后会恢复。从 teammate 创建的普通 fork 会收到当前 Lead 身份。

#### Token 影响

每次 Team member 请求都有固定策略与 schema 成本。身份是完整 runtime-context 快照的一部分。保留的快照未变化时不追加消息；context 变化或被移除时，loop 追加包含身份的完整快照。工具调用会增加紧凑 JSON roster、task、wait 或 receipt 结果。Peer 内容由 Team 领域保留在 target 历史中。

#### KV Cache 影响

provider／model、共享 system 策略和工具 schema 相同时，fork 保留父请求前缀并追加任务与当前 runtime context。工具结果与 peer 消息追加在可复用请求前缀之后。原先在 system prompt 中记录身份的 Session，首次使用此布局请求时可能改变该前缀；提供方实际缓存命中仍为尽力而为。

### teammate 模型选择

#### 模型看到什么

只有已启用 Session 的 `spawn_teammate` 会公开 `provider`、`model` 与 `reasoning_effort`，并同时提供 `list_agent_models`；关闭或恢复为固定路由的 Session 两者都没有，fork 路由警告也只在启用时出现。发现结果只返回该 Session 授权路由与实时适配器目录的交集，因此新注册的 provider 或 model 不会扩大已有 Session，授权列表本身也不会进入请求。

#### Token 影响

启用 Session 中，路由字段与发现工具会给每个 Team 请求增加固定 schema 与描述；授权列表不增加请求 token。`list_agent_models` 的输出只在模型调用时进入 transcript。

#### KV Cache 影响

fresh teammate 改变路由只影响其之后的请求。只有路由不变时，fork teammate 才能保留 Lead 复制的前缀；改变 provider 或 model 需要重新预填充该历史，其成本可能超过被委派任务本身。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明策略与工具无法为一支团队保证什么。它们是当前包约束，不是与其他协作方式的对比。

- **提示词策略只负责协调，不负责 confinement**——它无法阻止 Bash 或外部进程写入重叠文件。
- **没有 Web 控制功能**——浏览器 roster 与任务板呈现不属于该运行时包。
- **只使用 Host 授权的路由**——子模型选择需要 Host 的 `subagent-model-selection` 设置，以及声明 `agentOptions` 的执行提供方；Team 不新增独立 allowlist、无限制模式，也不会在启用后回退到固定路由。
- **实验原型，无稳定性承诺**——本包公开发布，但孵化期间 schema 仍可自由变更。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
