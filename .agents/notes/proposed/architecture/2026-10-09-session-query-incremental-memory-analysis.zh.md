# Agent Note: session-query 复用会话缓存并增量维护内存分析

Status: proposed

[English](2026-10-09-session-query-incremental-memory-analysis.md) | 中文

## 问题

本提案归属 `deepseek-harness` 的 `session-query`。增量接入点、复用边界与一致性方案已完成源码核实；设计尚未实施，行为与性能仍须实施测试。

`readSurface` 返回当前消息 surface 中的原事件，按折叠后的位置顺序排列；`traceEvent` 返回单目标的完整直接来源、派生引用及 replacement 链。它们目前走 [corpus 读取路径](<../../../../packages/session-query/session-query/src/index.ts#L404-L440>)：取得完整事件后深拷贝 payload，再重新折叠。[共享分析](<../../../../packages/session-query/session-query/src/tracing.ts#L181-L219>)构造全日志 N 条 records，但 surface 只需要当前节点，单目标 trace 只需要一个 record；trace 还扫描后续事件寻找反向来源引用。

已有机制可以复用：

| 机制 | 已有能力与边界 |
|---|---|
| [Session snapshot](<../../../../packages/core/session/src/index.ts#L625-L657>) | 事件深度冻结，范围读取可引用它们；无须为内部分析克隆完整 payload。 |
| [Session SurfaceManager](<../../../../packages/core/session/src/surface.ts#L618-L701>) | 已按新增事件增量折叠当前节点，但不保存完整 replacement history。 |
| [query observation/cache](<../../../../packages/session-query/session-query/src/observation.ts#L64-L170>) | live 固定 cut 范围读取；cold 按 persistence identity/revision 复用已恢复 Session，lease 保持旧 cut。公开 observation 没有直接提供 surface/history。 |
| [JSONL parsed cache](<../../../../packages/session/session-persistence-jsonl/src/index.ts#L760-L847>) | 相同 revision 可省物理 I/O、解码及 stored validation；不是局部磁盘读取。 |

因此不能说每次查询都重新读取磁盘，也不能把已有 Raw/page 的缓存优化重复开发一遍。首次 cold miss 仍经[完整读取及 interrupted closers](<../../../../packages/session-query/session-query/src/cold-read.ts#L31-L56>)和 Session prepare/校验；`projectionMode: "none"` 只省 registry projection，不取消恢复。

## 提案

本提案细化[既有 observation 所有权决策](<../../implemented/architecture/2026-08-25-session-observations-and-projection-owned-client-state.zh.md>)的 query 内部分析，并保留[便捷 API 精简提案](<../simplification/2026-09-19-trim-session-query-convenience-api.zh.md>)中的 observation、surface 与 trace 入口。两份现有记录均不被取代；归档记录保持冻结。

### 1. 复用 observation，只复制最终输出

让 `readSurface` / `traceEvent` 复用现有 observation 与 prepared cache，在同一 lease/cut 内分析冻结事件引用，finally 释放。surface 只复制最终返回的当前原事件及 header；trace 只拥有最终 metadata 和 seq 集合。分析过程中不深拷贝完整 payload。

按结果需求生成分析产物：surface 不生成 N 条 records；单目标 trace 只生成目标 record；真正需要全列表的消费方仍生成完整 records。保留公共返回契约、权限、取消及错误类别，不以局部窗口冒充完整 trace。

### 2. 首次构建，随后按新增逻辑事件增量维护

目标是每个保留的会话首次构建必要分析状态，之后同一 live Session 正常 append 时只处理新增逻辑事件，而不是只缓存静止 cut 的结果。cold prepared entry 在相同 persistence identity/revision 下复用分析；revision 改变或恢复成新的 live 对象时完整恢复并重建，随后该 live 对象再按 append 增量维护。

复用 core canonical fold 转换引擎，在 query 内增量维护 replacement history、实际 shadow 关系与反向 `sourceEventSeqs` 引用；不直接把 Session 当前 surface 当作完整分析结果。实际替换关系与来源引用分别维护：source 可以引用诊断，不等于被覆盖节点；物理 frame 变化也不等于逻辑事件变化。追加普通来源事件同样会改变 trace，不能仅依赖 replacement generation。

这些是 query 内部分析能力，不新增公共关系 API，不建立另一份持久活动树，不改 SQLite on-disk schema。List/Detail 仍使用 [ADR 0002](<../../../../../dsh-session-tools/docs/adr/0002-local-reading-and-completeness.md>) 的有界原字段读取，不为每页或每个搜索命中请求全 surface/trace。

### 3. 分析状态随所属会话缓存共同淘汰

新增内存分析挂在既有会话/恢复 entry 生命周期内，与所属缓存一起淘汰、dispose（资源释放）和失效；live 状态随 Session 生命周期释放。不建立独立无界 cache，不让 seq map 或闭包在淘汰后继续持有完整 payload。现有 lease 对旧 cut 的保留规则继续有效。

实施前重点确认（源码核实结论与选择）：

1. **接入：按 observation cut 惰性处理增量。** 首次处理 `[0, cut)`，以后只处理 `[processed, cut)`；未查询的 append 不做额外分析。[append](<../../../../packages/core/session/src/index.ts#L751-L765>) 先验证候选并收集 listener，随后 push，最后同步调用 post-commit observer；observer 失败被隔离，seed 与未 attached Session 不发布事件。因此监听 `session/event` 仍需首次回放、补漏和 cut 控制，不作为分析正确性的依赖，不新增 bus。
2. **surface：复用 canonical 转换引擎，不直接复用 Session 当前结果。** [完整 fold](<../../../../packages/core/session/src/surface.ts#L556-L615>) 与 [SurfaceManager](<../../../../packages/core/session/src/surface.ts#L618-L718>) 共用 plan/apply；等价要求相同事件前缀、解释器行为与有效定义。query 固定用 [catalog](<../../../../packages/session/session-format-catalog/src/message-projections.ts>) 的 image-offload 定义，Session 用 [store 注册的 borrowed definitions](<../../../../packages/core/session/src/index.ts#L928-L949>)，不能由名称相同推断任意 profile 等价。公开 `session.surface.nodes` 返回可变内部数组，只表示最新 cut；公开与内部均无完整 replacement history，generation 也不能覆盖普通来源 append。现有 [fold state](<../../../../packages/core/session/src/surface.ts#L260-L285>) 和 plan/apply 都是私有。最小选择是 core surface 模块抽取可续接的 canonical fold accumulator，供原 fold 与 query 使用，逐次返回实际 replacement 的 shadowedSeqs；不复制 positional/validation 算法，不扩展 Session 公共关系 API。影响 core session 的 surface 导出、实现与测试，以及 session-query 内部分析；原 fold 调用方保持接口并作回归。
3. **cut：捕获、推进与结果快照在同一同步段完成。** [live observation](<../../../../packages/session-query/session-query/src/observation.ts#L285-L329>) 已限制事件范围，但不冻结另一份可变关系 state。为两个 query 入口增加内部同步 projector：source 异步解析完成后，由 observation owner 捕获 cut、推进到该 cut、生成所需 seq/metadata 或最终输出，中间无 await，然后释放 lease。后续 append 不改已生成答案，无须每次复制全关系 map 或巨大 payload。若跨 await 消费旧 lease，必须保留 cut-specific metadata/version；共享 state 已超过旧 cut 时，用旧 lease 前缀临时重建，不能仅筛掉新 seq 就冒充旧 surface。当前方案不引入长期多版本缓存。
4. **cold：同 revision 静止复用，revision 改变或恢复为新 live 对象先重建。** [prepared entry](<../../../../packages/session-query/session-query/src/observation.ts#L118-L170>) 以 persistence identity/revision 命中，否则完整 read/prepare 新 entry；没有可信逻辑前缀续接凭据。首次 [cold read](<../../../../packages/session-query/session-query/src/cold-read.ts#L31-L56>) 追加 synthetic interrupted closers，可能含进入 surface、引用 tool/call 的 [tool/result](<../../../../packages/core/session/src/repair.ts#L118-L163>)；后续真实事件会占用这些 seq，旧 balanced log 不一定是新日志前缀。Session 构造还可能追加 [end-seed marker](<../../../../packages/core/session/src/index.ts#L590-L622>)，prepared observation 的 cut 却是 entry.events，不能直接读 prepared Session 最新 nodes。只有同一 live Session 对象后续 append 确定可续接；新恢复对象首次构建后再增量。不实施跨 revision 前缀比较、synthetic 尾部回滚或 cold→live 状态转移。
5. **所有权：cold 挂 PreparedEntry，live 用 reader 拥有的 WeakMap<Session, state>。** [淘汰与 lease](<../../../../packages/session-query/session-query/src/observation.ts#L227-L283>) 已使旧 revision 随旧 lease 保留；释放且无 cache 引用后可 GC。分析字段随 entry，不另建按 id 的强引用 map。live 不修改 Session 类，在 session/disposed 删除对应弱键，旧 lease 快照仍有效。现有 reader 没有显式 clear/dispose；沿 [engine effect](<../../../../packages/session-query/session-query/src/index.ts#L153-L157>) 增加 reader teardown，清 cache、替换 weak map，并阻止解析中的旧请求在 dispose 后回填。state 不存另一套 payload 副本；校验所需 frozen 引用/投影消息与 owner 同寿命。
6. **语义与错误：专用内部适配，不能机械替换 corpus.load。** [trace](<../../../../packages/session-query/session-query/src/tracing.ts#L71-L110>) 的 source 是目标直接引用，derived 是后来直接引用目标的事件，replacementChain 只沿实际 shadow replacement；分别维护反向 source 索引与 replacement map，保留 source 原顺序、derived 升序。surface 按 fold nodes 的位置顺序返回原 event，保留空消息节点，不返回 image-offload 后的 Message。[canonical fold 错误](<../../../../packages/session-query/session-query/src/tracing.ts#L181-L219>) 是 INVALID_SURFACE；[observation prepare](<../../../../packages/session-query/session-query/src/observation.ts#L130-L148>) 用 store definitions 且失败映射 CORRUPT_SESSION。查询内部 preparation 使用 canonical catalog，经既有 Session.fromRestore 校验；与公共 observation 的 store-definition preparation 以 entry 模式区分，只在同模式复用，公共 observeSession 行为不变。trace 在已读取前缀上先检查目标存在，再做 canonical fold/preparation；新增恢复校验失败需在适配层区分原 canonical surface 失败与 persistence corruption，不能将全部 prepare 异常统一映射。canonical fold 失败仍映射 INVALID_SURFACE；persistence corruption、source conflict、not-found 与取消按原 [corpus 分类](<../../../../packages/session-query/session-query/src/corpus.ts#L306-L344>) 适配，不能让新 prepare 抢先改成另一错误类别或跳过恢复校验。

**必须实施测试才能保证：** accumulator 每次 append 与完整 fold 的差分（replacement 再覆盖、额外诊断 source、普通 source append、image offload、空消息）；异步 source 解析后旧 cut 与新 append 隔离；cold synthetic 尾部/new live 重建及旧 lease；解释器缺失/卸载、target-not-found、invalid surface、持久化错误与取消的原类别/检查顺序；淘汰、dispose/HMR（热模块替换）与进行中请求不回填。以上是源码确定的扩展点与设计选择，尚未实现或运行这些验收测试，也没有 CPU/分配收益实测。

## 职责与影响范围

| 模块 | 本轮设计责任 |
|---|---|
| `dsh-session-tools` | 阶段 1：共享 Compact/Detail 关联、有界补读、预算、Raw、surfaces 参数与轻量 read_seq；见 [ADR 0001](<../../../../../dsh-session-tools/docs/adr/0001-shared-event-association-and-projection.md>)、[ADR 0002](<../../../../../dsh-session-tools/docs/adr/0002-local-reading-and-completeness.md>)、[ADR 0003](<../../../../../dsh-session-tools/docs/adr/0003-search-and-projection-separation.md>)。只消费公开 query，不打开 session 文件。 |
| `session-query` | 阶段 2：readSurface/traceEvent 的 observation 复用、按需结果生成、增量内存分析和缓存生命周期。内部接入采用 observation owner 的同步 projector、entry/弱键状态及错误适配。 |
| core Session / SurfaceManager | 抽取已有 canonical fold 的增量 accumulator 扩展点，保持 Session 公共 surface/关系接口；不复制恢复器。 |
| SQLite / persistence / codecs | 本轮保持索引、磁盘格式、恢复和校验职责；不是增量内存分析的持久关系数据库。 |
| 内置 query consumer、交付工具、controller/GUI history、subagent | 不预设 API/schema 变更。Raw/page 已消费公开 query；controller 等全历史消费方并非局部读取，应保留完整 preparation 语义。 |

现有 SQLite 只为有提取文本的事件建文档，缺少完整 source/shadow 关系和 surface 位置顺序，见[文档构建](<../../../../packages/session-query/session-query/src/documents.ts#L36-L74>)。它适合已有搜索和 surfaces 过滤，不能替代完整 surface/trace。复用内存分析不需要跨 query、SQLite、persistence 共享另一套关系缓存。

## 曾考虑的替代方案

**持久关系表或 SQLite schema 扩展：本轮不做。** 搜索文档不完整，补全关系还增加维护、迁移与失效成本；复用已恢复内存状态更直接。

**磁盘 sidecar、内存 frame index、migration 分帧、手动或自动 reframe：移出本轮。** 现有读取已全量恢复 events，seq 可直接索引内存，且没有局部磁盘读取消费方；增加物理索引本身不会消除 query 首次完整恢复。普通 zstd append 是独立批次 frame，迁移 body 可是单大 frame，但在当前内存路径中重分帧没有直接收益。实现真正局部磁盘读取还涉及 JSONL open/read、codec 和全局验证职责，不值得作为本轮查询优化的附带阶段。

**跨进程校验凭据或跳过全局校验：不做。** 物理定位信息不能证明整个日志及其解释器已通过当前恢复校验；跨 owner 的版本/失效协议成本没有必要。

**模型 compaction 工具：后续独立决策。** 先完善查询和读取；本设计不改模型上下文，不提交压缩事务。

物理范围读取的依据见[JSONL read 的数组 slice](<../../../../packages/session/session-persistence-jsonl/src/storage.ts#L158-L178>)和[迁移流式写入](<../../../../packages/session/session-persistence-jsonl/src/generation.ts#L672-L765>)。这些调查只支持范围取舍，不构成已验证的新 reader/reframe 方案。

## 验收标准

阶段 0 为同步本提案与消费方 ADR；阶段 1 为 `dsh-session-tools` 投影/搜索；阶段 2 为 `session-query` 增量内存分析。用户已授权本提案与消费方三份 ADR 的实施；本次基线提交只修改文档，实施验收前保持 proposed 位置。没有存储迁移、分帧、sidecar 阶段。

实施验收应比较优化前后 surface 顺序、空消息、image offload、replacement chain、直接 derived/source 集合和错误类别；验证首次构建、每次 append、旧 cut lease 与淘汰释放。量测 live/cold 的 CPU、分配及最终输出复制，不只测静止日志重复请求。首次 cold 完整 read/校验/恢复成本仍在，不承诺任意首次单事件加速，也没有当前毫秒或内存收益实测。

已决策的默认范围：搜索省略 surfaces 时覆盖 current、shadowed、log-only 中已有的全部索引文档，见 [ADR 0003](<../../../../../dsh-session-tools/docs/adr/0003-search-and-projection-separation.md>)。ADR 0001 与 ADR 0002 功能实现后，从本机真实会话历史选择代表性回忆任务，估计并校准补读与展示预算；此前不捏造数值。每阶段验收后移除对应待确认标签，将经验证的确定值及校准依据写入正文。阶段 2 的接入与一致性选择见上文核实结论，差分、生命周期与错误语义测试仍待实施。

## 风险

首次 cold 查询仍承担完整读取、校验与恢复成本；增量收益依赖同一 live Session 对象的连续 append。解释器定义差异、synthetic 尾部、旧 cut lease 和 dispose 中的请求会影响结果及错误语义，必须通过上述差分与生命周期测试验证。代表性任务的预算与性能收益尚未量测，不能将本提案视为已验证的性能保证。
