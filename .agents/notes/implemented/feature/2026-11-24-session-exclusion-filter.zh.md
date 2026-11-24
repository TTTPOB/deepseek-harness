# Agent Note: 在排名前排除会话

Status: implemented

[English](2026-11-24-session-exclusion-filter.md) | 中文

## 问题

搜索消费方会把部分会话排除在结果之外：实验性跨会话搜索工具排除调用方自己的会话，一个仓库外的会话工具还会排除已归档会话。只有包含型过滤器时，它们只能等提供方完成排名和分页之后，再从每一页里删掉这些结果。提供方把被排除的结果也计入 `limit`，所以明明还有结果，返回的页却可能不满甚至为空。想补满页面的消费方还得记录自己读到了提供方某一页的哪个位置，因为提供方游标只能指向页边界。

## 决策

[`SessionResultFilter`](../../../../packages/session-query/session-query/src/types.ts) 包含 `{ kind: 'exclude-ids'; values: readonly SessionId[] }`。该子句移除列出的每个会话 ID。空列表不移除任何会话，而空的包含型列表不匹配任何会话。它与其他子句按 AND 组合。[`filterSessionResults`](../../../../packages/session-query/session-query/src/filters.ts) 在内存记录上应用它；SQLite 提供方在[会话谓词](../../../../packages/session-query/session-query-sqlite/src/query.ts)中把它编译为 `session_id NOT IN (…)`，在排名和分页之前执行。所有接受 `SessionResultFilter` 的操作都接受该子句。

[实验性跨会话搜索工具](../../../../packages/experimental/tool-session-query/src/operations.ts)用这个子句传入调用方的 ID，不再逐页删除调用方的结果。

## 考虑过的替代方案

**由每个消费方补满页面。** 每个消费方都要重复调用提供方，并记录在提供方某一页内的位置，而不透明的提供方游标表达不了这个位置。

**通用的取反子句。** 只有按会话 ID 排除有消费方。对可空列表和范围取反，需要定义一套没有调用方使用的语义。

**提供方标志，例如“排除调用方”或“排除已归档”。** 提供方不知道调用它的 agent（智能体）是谁，归档状态也由工作区注册表管理，不属于会话查询。使用 ID 列表，这两项决定都留在消费方。

## 后果

被排除的会话不再占用页内名额，只有到结果末尾才会出现不满的页。ID 列表属于搜索游标所绑定的规范化请求（[只绑定请求的游标](../bug-fix/2026-11-24-request-bound-search-cursors.zh.md)）：续页必须传入同一组 ID；如果两页之间这组 ID 变了，例如刚归档了一个会话，旧游标就会失效。`SessionResultFilter` 是封闭联合类型，仓库外的代码也在使用；按过滤器种类做穷尽 switch 的代码必须处理这个新种类。
