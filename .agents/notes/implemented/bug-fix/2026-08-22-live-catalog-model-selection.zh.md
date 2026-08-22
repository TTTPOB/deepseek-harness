# Agent Note: 内置模型选择保留实时描述符

Status: implemented

[English](2026-08-22-live-catalog-model-selection.md) | 中文

## Problem

内置提供方 discovery 返回当前 catalog，其中包括仅远端存在的模型 id 与更正后的 wire 元数据。settings 模型选择器把选中的候选保存为非空 `models` 列表，其中只包含可编辑的 profile 字段；但路由解析把该列表视为放弃当前 catalog、只从已安装静态 catalog 继承的指令。混合协议提供方上仅远端存在的选中项因而缺少自己的协议，已安装选中项也可能静默恢复过期的协议与 endpoint。

## Decision

对于已安装内置提供方，描述符选择与模型选择彼此独立。无论 `models` 缺席、为空还是非空，当前 catalog view 都是描述符来源。缺席或空列表服务所有当前描述符；非空列表按 id 选择描述符，`id` 之外的每个配置字段通过已有容量、推理、模态与兼容性解析覆盖选中的描述符。

每条已配置内置路由都会继续参与定期 catalog 刷新，因为选中的模型仍继承当前描述符。启动时若没有已恢复或已发布的远端 view，已安装 catalog 仍是离线基线。手工声明路由没有实时描述符来源，继续使用路由级 `api`、`baseURL`、显式 `models` 与配置的回退值。

`modelOverrides` 仍是完整 catalog 的定制形式。它不能与非空 `models` 列表共存，因为选中条目已经携带同一批覆盖字段，同时合并两者会为一个模型建立两个配置来源。

## Alternatives considered

**通过 settings UI 持久化完整描述符。** 这样可以保留由部署拥有的快照，但会扩展通用 discovery wire 格式，把提供方元数据复制进 `settings.yaml`，并要求浏览器往返保留 pi-ai 未来新增的每个描述符字段。

**新增 `enabledModels` 或 `liveCatalog` 设置。** 独立字段可以保留旧静态列表含义，但会让普通模型选择面对多个重叠的 catalog 控制项。现有选择器已经写入 `models`，把该列表解释为选择加覆盖符合其可见行为。

**每次远端新增模型都更新已安装 pi-ai catalog。** 这可以临时修复已知 id，却重新引入实时 catalog 原本要消除的发布节奏耦合。

## Consequences

内置路由可以选择仅远端存在的模型，并保留每个模型当前的协议、endpoint、兼容元数据与模态。显式按模型字段仍具有更高优先级，显式 `maxTokens` 仍是部署选择的请求默认值。非空内置 `models` 列表不再冻结 catalog 元数据；需要完全拥有描述符的部署应使用手工声明路由。

[实时 catalog 架构决定](../architecture/2026-08-22-pi-ai-live-model-catalogs.zh.md)负责刷新、持久化与不可变请求快照；本说明限定配置模型选择如何消费该 catalog。
