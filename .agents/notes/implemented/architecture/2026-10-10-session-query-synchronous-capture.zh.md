# Agent Note: SessionQuery 的同步只读采样入口

Status: implemented

[English](2026-10-10-session-query-synchronous-capture.md) | 中文

## Problem

通用上下文地图需要同时取得当前 Surface（模型可见消息投影）的节点顺序、消息预览、路由信息及计量。分别读取 Surface 和计量会取得不同状态；树外 consumer 自行恢复历史 Session 则重复 Query 的源解析、冷准备和租约管理。

现有 [observation 决策](../../implemented/architecture/2026-08-25-session-observations-and-projection-owned-client-state.zh.md)已经确定同源读取与未发布 prepared Session 的所有权；[增量内存分析决策](../../implemented/architecture/2026-10-09-session-query-incremental-memory-analysis.zh.md)进一步区分 canonical 分析与 Session 的最新状态。本决策补充同步 Session 采样能力，不取代两份决策，也不恢复[拟删除的便利 API](../../proposed/simplification/2026-09-19-trim-session-query-convenience-api.zh.md)。

## Decision

自有 SessionQuery fork 提供用于同步采样的 `captureSession`。源解析与读取准备可以异步；确定 live 或 prepared Session 后，Query 调用一个同步、只读回调，返回由 consumer 拥有的 DTO（数据传输对象），并在 `finally` 释放读取租约。

Query 负责源解析、取消、准备模式、observation cut 与租约；consumer 负责复制所需节点、预览与元数据，并调用现有 token-meter。Query 不依赖 token-meter、地图 DTO 或主动压缩政策。地图与计量的 consumer 设计见 [session-tools ADR 0004](../../../../../dsh-session-tools/docs/adr/0004-context-map-and-metering.md)。

### TypeScript 只读视图与计量适配

回调参数使用窄的 `SessionCaptureReader` TypeScript 读取接口，仅暴露采样需要的读取方法及只读属性、集合，省略 append 等写入方法。

运行时传入 Query 选中的原始完整 Session 实例，通过窄接口提供 TypeScript 层面的只读约束。

现有 token-meter 保持不变。session-tools 在一个内部计量适配函数中，将此读取视图直接断言为 Session 后调用 meter。该适配仅用于 captureSession 的回调参数，其依据是 captureSession 始终传入原始 Session 实例，而非任意实现同名读取接口的对象；不把转换函数作为接受任意 reader 的公共入口。只读视图隐藏的成员在实际对象上仍然存在，meter 继续使用完整 Session。

### 采样与所有权

回调期间不 yield、不写 Session、不创建或激活 agent（智能体），也不将 Session、observation 或借用的可变容器带出回调。复制有序节点、请求 header/context、replacement/content generation、需要的不可变消息及计量结果；逐节点计量必须与采样节点顺序对齐。

回调返回独立拥有的 DTO，Query 在回调结束或抛错时释放自己的租约。源取消在采样前拒绝；回调错误原样传播。节点和预览在回调内完成采集，源失败沿用现有 Query 错误类别，不自动重试 provider。

捕获的是历史会话现在的逻辑 Surface，不提供任意过去的 `as_of_seq`。cold prepared Session 保持未发布，不 enter/announce、不创建 agent、不写目标持久日志；读取准备及 meter 内存缓存可以更新。首次 cold 读取仍可能恢复完整日志，meter 仍可能遍历整个 Surface；限制展示窗口不代表按窗口磁盘 I/O。

### Cut 与准备模式

源 observation cut、计量的 `logRevision`、replacement/content generation 分别记录，不因 revision 数值不同就判定失配。cold 修复可能包含 synthetic interrupted closers；prepared Session 可能还有 end-seed marker，不能把逻辑 cut 描述为磁盘原始尾部。

采样固定沿现有 store-definition 读取准备路径，不增加 public prepareMode 开关。异步源解析完成后，在 resolve/consumeLive 的同一同步段中，将已选中的 live Session 或 entry.session 与本次 observation 传给 consumer，finally 释放租约；不能 await observeSession 后再取最新 Session，也不接收旧 observation 做当前采样。canonical Surface/trace 分析保留原用途，不作为 store Session 的等价物，见 [源解析及准备](../../../../packages/session-query/session-query/src/observation.ts#L156-L291)。

Query 复用同模式、同源版本且仍有效的 prepared 对象，地图不自行二次恢复。现 cache 按 sid 保存单个 entry 并检查 mode/revision；模式切换、版本变化或淘汰可能重新准备，见 [缓存检查](../../../../packages/session-query/session-query/src/observation.ts#L334-L357)。

按 session.surface.nodes 的 seq 逐项取事件并解释消息，保留无消息且计量为零的节点，不把过滤空消息的 deriveMessages 数组直接与节点 zip，见 [消息派生](../../../../packages/core/session/src/index.ts#L835-L880)。meter 同步读取同一个 Session 的日志，独立 fold 原事件并应用其 image/offload 与附件路由逻辑；不要求 Session 激活，也不直接使用 Session 的任意插件解释结果。因此节点按 index/seq 对齐，预览与计量值分别标 basis，不承诺计量所依据的文本完全相同，见 [meter 采样](../../../../packages/llm/token-meter/src/index.ts#L146-L190)及 [meter fold](../../../../packages/llm/token-meter/src/surface-fold.ts#L107-L127)。

只需节点地图时使用 `projectionMode: none`；需要已记录上下文汇总时使用 `all`。两者保持现有 projection 语义，`none` 不跳过恢复校验。IO 入口 `getContextMap(ctx, exec, ...)` 在采样前授权源，与公共模型工具采用同一作用域规则。纯函数 `buildContextMap(reader, observation, measurement, ...)` 不执行 IO 或授权：它投影调用方已持有的 Session 数据，也供 reminder 投影复用。

## Alternatives considered

**仅使用 `Readonly<Session>`。** 它只限制属性赋值，仍暴露 append 等写入方法；窄读取接口能表达调用方实际需要的操作。

**运行时只读包装或代理。** 可以让传出的对象不含写入方法，但现有 token-meter 接收完整 Session。保留原实例并用 TS 接口约束，能直接复用计量器。JavaScript 或主动绕过类型检查的调用不在本方案考虑范围内，因此不为这类调用增加运行时写入隔离。

**修改计量器以接收读取接口。** 可以省去内部类型断言，但 captureSession 已保证实际对象是完整 Session；将断言集中在 session-tools 内部适配函数即可，保留现有计量器接口。

**consumer 自行恢复 Session。** 重复源解析、完整恢复、取消及缓存所有权，且容易绕过 Query 的读取规则，因此不采用。

**先读 Surface，再调用 meter。** live 状态可能在两次操作之间变化，无法承诺节点、预览和计量值来自同次采样，因此不采用。

**Query 直接提供地图或依赖 meter。** 将 consumer 展示与计量职责纳入基础查询层，限制其他只读采样用途，因此不采用。

**只使用现有 context pressure projection。** 汇总不提供与当前 Surface 对齐的逐节点计量值，不能支撑通用区段地图，因此不采用。

## Verification

- [Capture 与 observation 回归测试](../../../../packages/session-query/session-query/tests/observation.spec.ts)覆盖原始 Session 身份、未修改的 meter 调用、live/cold 采样、store/canonical 准备差异、old cut、内存 end-seed marker、synthetic closers、空节点、图像 offload，以及 append/replacement 后 DTO 的稳定性。
- 同组回归测试覆盖调用方拥有的 observation 租约、回调失败清理、stat/read 期间取消，以及服务 dispose 后不回填已撤销缓存。同模式有效 preparation 复用原 Session；切换模式可能再次恢复。
- [编译器 probe](../../../../packages/session-query/session-query/tests/capture-types.spec.ts)以实际源码类型编译公开包根导入：读取、品牌 id 与 unknown 工具 schema 值保持可用；异步回调及嵌套元数据、消息或节点写入被拒绝。包构建也对 producer 实现执行严格编译。
- fork4 tarball 的独立检查通过 plain Node 公开包根导入及原 Session capture，以及 NodeNext 公开声明的 readonly 节点和异步回调拒绝。这些检查解析既有 workspace peer；它们不证明干净安装解析或发布完成。

## Consequences

consumer 无需重复 Query 准备或保留读取租约，即可组合节点、预览、路由及未修改 meter 的输出。Query 不新增 meter 依赖或额外缓存，公共 observation 保持由调用方拥有的租约。源授权仍归 IO consumer，而非纯投影函数。

同次采样保证观察同一 Session，不保证预览就是 meter 计量所依据的文本，也不保证最终 provider wire request 的文本及计量值完全一致。consumer 必须标明预览与计量依据。TypeScript 无法在编译期保证引用只在回调期间使用，引用生命周期依赖调用方遵守采样与所有权规则。

冷读取与计量仍有全量成本，此入口减少重复准备和 payload 克隆，不承诺常数时间。已验证的 fork4 源码及本地 tarball 不代表已发布 release。
