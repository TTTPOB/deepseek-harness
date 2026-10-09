# Agent Note: session-query 复用会话缓存并增量维护内存分析

Status: implemented

[English](2026-10-09-session-query-incremental-memory-analysis.md) | 中文

## 问题

`readSurface` 需要按折叠后位置排序的当前原始消息事件；`traceEvent` 需要单目标的完整直接来源、后续直接引用及 replacement 链。反复复制全日志、重新折叠并为每条事件构造 record，会使这两类读取承担未返回产物的开销。仅缓存静止结果也会在每次 append 后重新折叠。

Session 事件不可变，live observation 捕获精确事件前缀，cold observation 按 persistence identity/revision 保留已恢复 Session。这些 owner 提供可复用的内存输入。首次 cold 读取仍需要完整 I/O、中断轮次修复及恢复校验；优化针对保留输入的分析，而不是局部磁盘范围读取。

## 决策

`readSurface` 与 `traceEvent` 使用 observation 拥有的 canonical 分析。本决策细化[observation 所有权决策](<2026-08-25-session-observations-and-projection-owned-client-state.zh.md>)，并保留[便捷 API 精简提案](<../../proposed/simplification/2026-09-19-trim-session-query-convenience-api.zh.md>)中的入口。两份记录均未被取代。

### 共享 canonical 折叠，分别索引关系

Core 的 `SurfaceFoldAccumulator` 位于 [surface.ts](<../../../../packages/core/session/src/surface.ts>)，从 seq 0 起处理连续前缀，与 `SurfaceManager` 共用 plan/apply 转换。`foldSurface` 包装 accumulator，保持完整折叠接口。每次 append 返回实际位置替换的独立 metadata，包含被覆盖节点；验证失败时该事件不被应用。已使用的 borrowed projection definitions 必须持续存在，缺失或卸载解释器会使读取及追加失败。

Query 的 `EventLogAnalysis` 位于 [tracing.ts](<../../../../packages/session-query/session-query/src/tracing.ts>)，保留不可变事件引用、已解释消息与 seq 索引，不另存 payload 副本。在同一 live Session 上按 `[processed, cut)` 惰性推进，cut 为不含端点的事件 offset；未查询的 append 不产生额外分析。实际 replacement 与反向直接来源引用分别索引：引用诊断不会覆盖诊断，普通来源 append 即使没有 replacement 也会改变 trace。正确性不依赖 `session/event` 投递或 replacement generation。

Surface 输出按 canonical 节点位置顺序包含原事件，保留空消息节点，不返回 image-offload 后的已解释 Message。Trace 保留目标直接来源的原顺序、后续直接引用的升序，以及实际 shadow replacement 链，不以局部窗口冒充完整 trace。Surface 与单目标 trace 不先生成 N 条 event records；全列表消费方仍按需物化 records。只为调用方生成独立的最终 surface events、header 与 trace metadata，见[query 引擎](<../../../../packages/session-query/session-query/src/index.ts>)中的 `readSurface` 与 `traceEvent`。

### 精确 cut 与 owner 生命周期

[observation.ts](<../../../../packages/session-query/session-query/src/observation.ts>) 中的 `SessionObservationReader.project` 异步解析来源后，在一个同步段内捕获 cut、推进分析并投影独立输出，finally 释放 lease（读取租约）。后续 append 不会修改答案。若共享分析已超过旧 lease 的 cut，`analyzeObservation` 从旧前缀临时重建；仅过滤新增 seq 不能重建旧 surface。不保留长期多版本分析缓存。

Live 状态属于 reader 的 `WeakMap<Session, EventLogAnalysis>`，不属于按 session id 建立的强引用 map，也不新增 Session 公共关系 API。Cold 分析属于 `PreparedEntry`，仅在 persistence identity、revision 与 preparation mode 全部相同时复用。Revision 改变、新 live Session 对象或 cold→live promotion 都先重建分析，随后才可对该 live 对象的 append 增量处理。

重建规则源于[cold 读取](<../../../../packages/session-query/session-query/src/cold-read.ts>)会在内存中追加 synthetic interrupted-turn closers，可能包含工具结果。后续真实事件可占用这些 seq，所以旧 balanced cold log 不一定是下一 revision 的前缀。Prepared Session 还可能在 `entry.events` 之后包含 end-seed marker；分析使用 observation cut，而不是 prepared Session 的最新 nodes。不实施跨 revision 前缀比较、synthetic 尾部回滚或 cold→live 转移。

无 lease 固定的 cold entry 按容量淘汰；旧 lease 在释放前保留所属 entry。`session/disposed` 删除 live 弱键。Reader dispose（资源释放）清空 prepared cache 并替换 WeakMap；进行中的来源解析在 dispose 后不能回填。Query 引擎通过 Cordis effect 注册 reader teardown。冻结引用与已解释消息和 owner 同寿命。

### 准备模式与错误顺序

公开 `observeSession` 保持 store-definition preparation。内部 surface/trace 使用[canonical catalog](<../../../../packages/session/session-format-catalog/src/message-projections.ts>)及 `Session.fromRestore`；`projectionMode: "none"` 只跳过 registry projection，不跳过恢复校验。Prepared entry 区分模式。Session 的 borrowed store definitions 与 canonical catalog 不能仅因解释器名称相同就互换，直接复用 `session.surface.nodes` 因此不能保证语义等价。

Trace 在选定前缀上先检查目标存在，再 canonical fold/preparation。Canonical fold 失败保留 `SESSION_QUERY_INVALID_SURFACE`；恢复损坏仍为 `SESSION_QUERY_CORRUPT_SESSION`。来源/header 冲突、会话或事件不存在、持久化失败与取消保留原 query 类别及顺序。内部适配器保留 corpus 路径按操作区分的持久化映射：read corruption 与 stat/backend failure 分开，不把所有 preparation 或 backend 异常归为一种错误。见 [observation.ts](<../../../../packages/session-query/session-query/src/observation.ts>) 中的 `resolve`、`mapCorpusFailure` 与 `throwIfAborted`。

## 职责与影响范围

| 模块 | 职责 |
|---|---|
| Core Session / SurfaceManager | 拥有 canonical 位置与解释校验以及共享 fold 转换；保持既有 Session surface 接口。 |
| `session-query` | 拥有指定 cut 的分析、独立输出、来源/错误适配和 entry/弱键生命周期。 |
| `dsh-session-tools` | 经公开 query 实现共享 Compact/Detail 关联、有界补读、Raw 与轻量搜索入口；见 [ADR 0001](<../../../../../dsh-session-tools/docs/adr/0001-shared-event-association-and-projection.md>)、[ADR 0002](<../../../../../dsh-session-tools/docs/adr/0002-local-reading-and-completeness.md>)、[ADR 0003](<../../../../../dsh-session-tools/docs/adr/0003-search-and-projection-separation.md>)。 |
| SQLite / persistence / codecs | 保持搜索索引、磁盘格式、完整 cold 读取、恢复及校验职责。 |
| 全历史消费方 | 保持完整 preparation 语义；controller/GUI history 不是有界局部读取。 |

List/Detail 采用有界原字段读取，不为每页或搜索命中请求全 surface/trace。消费方默认值保持[真实历史有界抽样](<../../../../../dsh-session-tools/docs/reading-budgets.md>)确认的数值；省略 `surfaces` 时搜索 current、shadowed、log-only 中已有的全部索引文档。[SQLite 文档构建](<../../../../packages/session-query/session-query/src/documents.ts>)索引提取文本，不提供完整 source/shadow 关系或 surface 位置顺序。本决策不新增公共关系 API、持久活动树、SQLite schema 变更或存储迁移。消费方继续只经公开 query 读取，绝不打开 session 文件。

## 曾考虑的替代方案

**直接复用 Session 最新 surface。** 它既不对应旧 observation cut，也不包含完整 replacement history；store 解释器还可能与 query canonical catalog 不同。共享 canonical 转换能保持语义，而不复制位置算法。

**持久关系表或 SQLite schema 扩展。** 搜索文档不足以提供 surface/trace，补全会增加维护、迁移及失效成本。保留内存分析能直接解决重复工作。

**磁盘 sidecar、frame index、migration 分帧或 reframe。** 既有读取恢复全部事件，seq 直接索引内存。物理索引本身不能消除首次完整恢复，真正的局部磁盘读取还需要 codec 和全局校验变更；当前内存消费方不足以支持这些成本。

**跨进程校验凭据或跳过全局校验。** 物理位置不能证明整个日志及其解释器通过当前恢复校验。跨 owner 版本/失效协议增加成本，却不服务于保留输入的分析优化。

**模型压缩（compaction）工具。** 它们改变模型上下文及压缩事务，仍是独立决策；本优化只改变查询与读取。

## 验证

实施验收包含 core 557 tests，以及 query 和实际消费方共 9 个文件的 323 tests，其中 query 自身 4 个文件包含 116 tests；最终 core 定向运行为 7 tests，最终 consumer 运行为 51 tests。差分与定向回归覆盖 append/replacement 分析、普通来源引用、空消息与 image offload、旧 cut、preparation modes、revision/new-live 重建、dispose 及进行中来源解析。已验证六个 public query error codes。这些是记录的验收结果，不代表所有 Host 生命周期均已端到端运行。

普通 Node ESM smoke 使用匹配的正式 tarball、真实 Loader 组合及 SQLite，观察到首次 fold 217 events，重复查询零 fold append，append 仅 `[217]`，replacement 仅 `[218]`。旧 lease 读取与已返回输出保持不变。这验证了保留 live 输入的复用，不代表 GUI/install 已激活，也不代表 cold 生命周期经过端到端 Host 运行。

## 后果

重复读取复用已校验分析，同一保留 live Session 的正常 append 只处理未见事件。内存仍含与保留历史规模相关的事件引用、已解释消息及关系索引；最终 surface 复制随返回 surface 大小增长。所有查询并不因此具备常量内存或常量时间保证。

首次 cold 查询仍承担完整 I/O、修复、校验及恢复成本。Revision 改变和新 live 对象需要重建。消费方补读仍有界，可能返回不完整活动，见 [ADR 0002](<../../../../../dsh-session-tools/docs/adr/0002-local-reading-and-completeness.md>)。[合成性能诊断](<../../../../packages/session-query/session-query/tests/performance/README.zh.md>)不构成 production CPU/memory 保证、精确 allocations 或首次 cold 提速依据；cold 生命周期没有端到端 Host 验收运行。
