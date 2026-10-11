# 会话查询

[English](session-query.md) | 中文

本文定义逻辑会话语料库的查询词汇；当 live 数据存在时，该语料库优先使用 live 数据。[Service Definition 包](../../packages/session-query/session-query)负责精确读取、来源优先级、关系追踪、语义提取，以及与提供方无关的过滤器；[SQLite 提供方](../../packages/session-query/session-query-sqlite)负责具体全文索引的生命周期。

源码：[`packages/session-query/session-query/src/types.ts`](../../packages/session-query/session-query/src/types.ts)

<a id="synchronous-session-sampling"></a>
## 同步 Session 采样

`captureSession(id, capture, options)` 解析 live 或未发布的 store-prepared Session，并在选定它的同一同步段调用 `capture(reader, observation)`。公开的 [`SessionCaptureReader`](../../packages/session-query/session-query/src/types.ts) 提供只读身份、继承计数、日志长度、有序 `SessionSurface`、请求 header/context 及逐事件消息解释。TypeScript 拒绝 mutator、嵌套元数据写入、节点数组写入以及返回 Promise-like 的回调。运行时 reader 是原始完整 Session，不是包装对象。

窄接口隐藏 `Readonly<Session>` 仍会暴露的写入方法。它是编译期约束，不对 JavaScript 或主动绕过类型检查的调用提供运行时写入隔离。TypeScript 无法保证引用只在回调期间使用；调用方必须遵守所有权规则。

回调必须在返回前复制所需输出：不能 yield、修改 Session、创建或激活 Agent、retain observation，或返回借用的 Session 引用或容器。Query 在 `finally` 释放自己的 observation，包括回调失败时。回调错误原样传播；源解析与取消沿用现有 observation 错误，不自动重试 provider。`observeSession` 仍返回由调用方拥有的租约。

Query 负责源解析、取消、准备和租约，使消费方无需重复恢复；消费方负责展示 DTO、计量与压缩政策。同步回调避免分别读取 Surface 和计量时发生状态变化。先 await `observeSession` 再取得最新 Session，或复用旧 observation，不能保证同次采样。

按位置顺序遍历 `reader.surface.nodes`，经 `observation.readEvents` 读取各 seq，再调用 `reader.deriveEventMessage(event)`。null 消息仍占据节点位置；不能把节点与已过滤的 `deriveMessages` 历史 zip。输出需要 replacement/content generation 和路由元数据时，在此回调中一并复制。

`projectionMode: none` 避免 projection 工作；`all` 在同一个 Session 上同步计算配对的 projection snapshot。已记录的上下文汇总不能代替与当前 Surface 对齐的逐节点计量。两种模式均保留 store 恢复校验。

cold capture 不 enter 或 announce Session、不激活 Agent，也不写持久存储。它与公共 observation 共用现有的每 id 单 entry 准备缓存：复用要求 persistence identity、源 revision 及 store preparation mode 均相同。canonical query 分析可以替换该 entry，但不能作为等价的 capture 来源；capture 始终使用 store 准备，不扩展缓存。

分别记录 observation 的 source cut、meter 返回的 `logRevision` 及 replacement/content generation。cold observation 包含 synthetic interrupted closers；prepared Session 还可能包含 observation 中没有的 end-seed marker。capture 读取当前逻辑 Session，而非任意历史 cut。

使用未修改 token-meter 的消费方可以把 `reader as Session` 集中在一个仅在 capture 内调用的私有 meter 适配函数中，而不是作为接受任意 reader 的公开转换入口。该做法依据 Query 传入原始完整 Session，因此保持 meter 以 Session 为键的内存缓存，无需运行时包装或修改 meter 接口。Query 不依赖 meter。meter 独立解释日志及其 image/offload 和附件路由，因此预览与 token 值需要分别标明依据；同 Session 采样不承诺文本相同，也不承诺与最终 provider wire request 的文本或计量值等价。

源授权由 I/O 消费方在采样前负责，而不是交给投影调用方已持有数据的纯函数。首次 cold capture 与计量仍可能检查完整日志/surface；限制输出窗口不代表按窗口磁盘 I/O 或常数时间的 capture。

## 逻辑记录

`SessionRecord` 由全语料库列表返回。它除了克隆的、优先取自 live 源的 header 外，还单独公开各源的可用性。`SessionEventRecord` 是轻量的原始日志投影；分类使用与模型历史推导相同的 `foldSurface()` 状态转换。

```ts type-equiv
/** Whether an event is current model context, replaced context, or raw-log-only. */
type SessionEventSurface = 'current' | 'shadowed' | 'log-only'
```

```ts type-equiv
/** Lightweight identity and source availability for one logical session. */
interface SessionRecord {
  /** Cloned session header selected from the live-preferred corpus. */
  header: SessionHeader
  /** Whether the id currently exists in `ctx.sessions`. */
  live: boolean
  /** Whether the active persistence backend currently lists the id, including a created-but-unmaterialized session it already observes. */
  persisted: boolean
}
```

`SessionLogSnapshot` 是供恢复预检使用的完整原始日志：它脱离运行时，并经过回放验证。`SessionSurfaceSnapshot` 表示一次精确读取的 surface 观测结果，而不是持续保留的订阅。

```ts type-equiv
/** One validated detached observation of a logical session's complete raw log. */
interface SessionLogSnapshot {
  /** Cloned session header selected from the same observation as `events`. */
  session: SessionHeader
  /** Exact number of fork-inherited events in the observed log. */
  inheritedEventCount: SessionLogOffset
  /** Cloned contiguous raw events after in-memory interrupted-turn balancing and replay validation. */
  events: SessionEvent[]
}
```

```ts type-equiv
/** One atomic live-preferred observation of a session's current model surface. */
interface SessionSurfaceSnapshot {
  /** Cloned session header selected from the same corpus observation as `events`. */
  session: SessionHeader
  /** Exact number of fork-inherited events in the observed log. */
  inheritedEventCount: SessionLogOffset
  /** Highest raw-log seq included in the observation, or `null` for an empty log. */
  capturedThroughSeq: OptionalSessionSeq
  /** Cloned current surface events in model-history order. */
  events: SurfaceEvent[]
}
```

`SessionTitleObservation` 将同样的原子观测规则应用于标题折叠，使执行授权检查的消费方能够验证提供标题的源 header。批量读取会按顺序为每个唯一请求 id 返回一个 `SessionTitleObservationResult`：操作失败只影响对应 id，而取消会拒绝整个操作。

```ts type-equiv
/** Latest folded title bound to the same session-header observation. */
interface SessionTitleObservation {
  /** Cloned header selected with the event log used for the title fold. */
  session: SessionHeader
  /** Latest title snapshot, absent when the observed log has no title. */
  title?: SessionTitleSnapshot
}
```

```ts type-equiv
/** One ordered result from a batch title observation. */
type SessionTitleObservationResult =
  | {
    /** Requested session id. */
    sessionId: SessionId
    /** Successful atomic header/title observation. */
    status: 'fulfilled'
    /** Header and optional latest title from one logical source. */
    value: SessionTitleObservation
  }
  | {
    /** Requested session id. */
    sessionId: SessionId
    /** Operational failure isolated to this session. */
    status: 'rejected'
    /** Original failure from logical-source resolution or title folding. */
    reason: unknown
  }
```

```ts type-equiv
/** Lightweight metadata for one event within a logical session. */
interface SessionEventRecord {
  /** Session that owns the event. */
  sessionId: SessionId
  /** Monotonic event seq within the session. */
  seq: SessionSeq
  /** Discriminant of the session event. */
  type: SessionEventType
  /** Event timestamp in Unix epoch milliseconds. */
  time: number
  /** Event placement in the folded session surface. */
  surface: SessionEventSurface
}
```

## 与提供方无关的过滤器和文档

会话和事件过滤器数组内的各项按逻辑与（AND）组合；单个列表子句中的各值按逻辑或（OR）组合。范围包含两端。事件的 `text` 子句会对提取出的语义文本执行正则表达式扫描：搜索文本按字面量处理，按 Unicode 规则执行不区分大小写的匹配，并允许灵活匹配空白字符；该过程与全文搜索提供方无关。

```ts type-equiv
/**
 * One logical-session predicate. A filter array is ANDed; `values` within a
 * clause are ORed.
 */
type SessionResultFilter =
  | { kind: 'id'; values: readonly SessionId[] }
  | { kind: 'cwd'; values: readonly (string | null)[] }
  | ({ kind: 'created-at' } & SessionResultRange)
  | { kind: 'parent'; values: readonly (SessionId | null)[] }
  | { kind: 'availability'; values: readonly SessionAvailability[] }
```

```ts type-equiv
/**
 * One event predicate. A filter array is ANDed; list-valued clauses are ORed.
 * Text is a literal, case-insensitive, whitespace-flexible semantic-text scan.
 */
type SessionEventResultFilter =
  | ({ kind: 'seq' } & SessionResultRange)
  | ({ kind: 'time' } & SessionResultRange)
  | { kind: 'type'; values: readonly SessionEventType[] }
  | { kind: 'surface'; values: readonly SessionEventSurface[] }
  | { kind: 'text'; text: string }
```

```ts type-equiv
/** Searchable semantic document derived from one session event. */
interface SessionEventSearchDocument extends SessionEventRecord {
  /** First-party semantic text used by scan filters and full-text indexes. */
  text: string
}
```

`ctx.sessionQuery.filterSessions(filters)` 会对完整的逻辑会话语料库应用 `SessionResultFilter`；`ctx.sessionQuery.filterEvents(sessionId, filters)` 按 seq 升序返回匹配的文档。消息、工具调用和工具结果、待办事项，以及失败和状态详情会纳入语义文本；推理（reasoning）块、被阻止的提示词、结构事件和流分片则不会。

## 原始列表分页

`SessionMetadataPageRequest` 指定 metadata filters、必填 limit 和可选 snapshot cursor；`pageSessions` 返回 `SessionSearchPage<SessionRecord>`。`SessionEventPageRequest` 指定 sessionId、排他的 afterSeq、可选 types、必填 limit 与可选 includeText；`SessionEventPage` 返回同一次观察的 header、capturedThroughSeq、原始事件 items 与可选 nextAfterSeq。`SessionEventPageItem` 是没有 surface 分类的事件元数据，text 只在请求时存在。类型定义见[公共源码](../../packages/session-query/session-query/src/types.ts)，快照失效及新鲜度语义见[包参考](../../packages/session-query/session-query/README.zh.md#paging-and-freshness)。

## 全文搜索结果页

整合后的 `ctx.sessionQuery` seam 提供两个全文搜索范围。`searchSessions()` 按匹配度最强的事件对语料库分组；`searchEvents()` 搜索单个会话。请求将不透明游标与规范化后的查询、元数据过滤器和结果数量上限绑定。提供方的元数据过滤器有意不包含事件文本扫描。

```ts type-equiv
/** Provider-owned opaque continuation token returned by session search. */
type SessionSearchCursor = Branded<'SessionSearchCursor'>
```

```ts type-equiv
/** Cross-session full-text search request. */
interface SessionSearchRequest {
  /** Full-text query interpreted as data, never executable FTS syntax. */
  query: string
  /** Logical-session predicates applied before event ranking. */
  sessionFilters?: readonly SessionResultFilter[]
  /** Event predicates applied before event ranking. */
  eventFilters?: readonly SessionEventMetadataFilter[]
  /** Maximum sessions in this page. */
  limit?: number
  /** Opaque cursor returned for the identical normalized request. */
  cursor?: SessionSearchCursor
}
```

```ts type-equiv
/** Within-session full-text search request. */
interface SessionEventSearchRequest {
  /** Session whose live-preferred logical log is searched. */
  sessionId: SessionId
  /** Full-text query interpreted as data, never executable FTS syntax. */
  query: string
  /** Event predicates applied before ranking. */
  filters?: readonly SessionEventMetadataFilter[]
  /** Maximum events in this page. */
  limit?: number
  /** Opaque cursor returned for the identical normalized request. */
  cursor?: SessionSearchCursor
}
```

```ts type-equiv
/** One cursor-paginated result page. */
interface SessionSearchPage<T> {
  /** Results for this page in contract-defined order. */
  items: readonly T[]
  /** Opaque continuation cursor, absent on the final page. */
  nextCursor?: SessionSearchCursor
}
```

与跨会话分组 hit 不同，会话内搜索结果即使没有命中项，也必须公开搜索时观测到的目标 header。

```ts type-equiv
/** Event-search results bound to the indexed target-session observation. */
interface SessionEventSearchPage extends SessionSearchPage<SessionEventSearchHit> {
  /** Cloned target header from the same indexed generation as `items`. */
  session: SessionHeader
}
```

```ts type-equiv
/** One event full-text search hit with a bounded plain-text excerpt. */
interface SessionEventSearchHit extends SessionEventRecord {
  /** Plain text excerpt selected around the match. */
  snippet: string
}
```

```ts type-equiv
/** One grouped cross-session hit, ranked by its strongest matching event. */
interface SessionSearchHit extends SessionRecord {
  /** Strongest matching event for this session. */
  bestMatch: SessionEventSearchHit
}
```

## 会话谱系

`SessionLineageTrace` 按由近及远的顺序携带已知 parent，以及由直接 descendant 递归嵌套而成的森林。完整性判别字段使已知 root 与缺失 parent 互斥。

```ts type-equiv
/** Recursive descendant node in a session-lineage trace. */
interface SessionLineageNode {
  /** Detached logical-corpus record for this descendant. */
  session: SessionRecord
  /** Direct children, each carrying its own recursive descendants. */
  descendants: SessionLineageNode[]
}
```

```ts type-equiv
/** Known ancestry and descendants for one logical session. */
type SessionLineageTrace = {
  /** Detached record for the session that was traced. */
  target: SessionRecord
  /** Known parents from the immediate parent outward. */
  ancestors: SessionRecord[]
  /** Complete known descendant trees rooted at the target's direct children. */
  descendants: SessionLineageNode[]
} & (
  | {
    /** The complete parent chain is present in the logical corpus. */
    complete: true
    /** Detached record at the top of the complete lineage. */
    root: SessionRecord
  }
  | {
    /** The parent chain leaves the visible logical corpus. */
    complete: false
    /** First parent id that is not present in the logical corpus. */
    unresolvedParentId: SessionId
  }
)
```

## 有界事件读取

请求指定一个原始 seq 及可选的邻近数量。结果携带 `SessionHeader` 而非可用性标志，使已知的 live 目标可以独立于持久化健康状态。

```ts type-equiv
/** Request for one event plus raw neighboring log context. */
interface SessionEventReadRequest {
  /** Session that owns the target event. */
  sessionId: SessionId
  /** Target event seq. */
  seq: SessionSeq
  /** Number of preceding raw events to include. */
  before?: number
  /** Number of following raw events to include. */
  after?: number
}
```

```ts type-equiv
/** Full target event and a bounded raw-log window. */
interface SessionEventWindow {
  /** Cloned header for the live-preferred source read. */
  session: SessionHeader
  /** Exact number of fork-inherited events in the observed log. */
  inheritedEventCount: SessionLogOffset
  /** Full cloned target event. */
  target: SessionEvent
  /** Full cloned events from `startSeq` through `endSeq`. */
  events: SessionEvent[]
  /** First seq included in `events`. */
  startSeq: SessionSeq
  /** Last seq included in `events`. */
  endSeq: SessionSeq
}
```

## 事件关系

事件追踪会区分位置替换与被引用为来源的事件。除 `replacementChain` 外，每个 seq 列表都只包含直接链接；该链从目标沿直接 replacer 追踪到最终的位置替换。

```ts type-equiv
/** Request for direct surface replacements and relationships to cited source events around one event. */
interface SessionEventTraceRequest {
  /** Session that owns the target event. */
  sessionId: SessionId
  /** Target event seq. */
  seq: SessionSeq
}
```

```ts type-equiv
/** Direct surface replacements and relationships to cited source events for one event. */
interface SessionEventTrace {
  /** Lightweight target record. */
  target: SessionEventRecord
  /** Immediate positional replacement event, when the target was shadowed. */
  replacedBy?: SessionSeq
  /** Positional replacers from the immediate replacement to the final replacement. */
  replacementChain: SessionSeq[]
  /** Surface nodes directly removed when the target itself performed a replacement. */
  replacedEventSeqs: SessionSeq[]
  /** Earlier events cited directly as sources, in their recorded order. */
  sourceEventSeqs: SessionSeq[]
  /** Later events that directly cite the target as a source, in log order. */
  derivedEventSeqs: SessionSeq[]
}
```

```ts type-equiv
/** Event relationships bound to the same session-header observation. */
interface SessionEventTraceObservation extends SessionEventTrace {
  /** Cloned header selected with the event log used for the trace. */
  session: SessionHeader
}
```

## 错误

封闭的 code 联合类型区分请求校验、目标缺失、surface 日志格式错误、可选后端故障、部署关闭搜索与矛盾的源元数据。

```ts type-equiv
/** Stable machine-routable failure taxonomy for session reads, traces, and search. */
type SessionQueryErrorCode =
  | 'SESSION_QUERY_ABORTED'
  | 'SESSION_QUERY_CORRUPT_SESSION'
  | 'SESSION_QUERY_EVENT_NOT_FOUND'
  | 'SESSION_QUERY_INDEX_FAILED'
  | 'SESSION_QUERY_INVALID_CONFIG'
  | 'SESSION_QUERY_INVALID_CURSOR'
  | 'SESSION_QUERY_INVALID_FILTER'
  | 'SESSION_QUERY_INVALID_LIMIT'
  | 'SESSION_QUERY_INVALID_QUERY'
  | 'SESSION_QUERY_INVALID_LINEAGE'
  | 'SESSION_QUERY_INVALID_SURFACE'
  | 'SESSION_QUERY_INVALID_WINDOW'
  | 'SESSION_QUERY_PERSISTENCE_FAILED'
  | 'SESSION_QUERY_SEARCH_DISABLED'
  | 'SESSION_QUERY_SESSION_NOT_FOUND'
  | 'SESSION_QUERY_STALE_CURSOR'
  | 'SESSION_QUERY_SOURCE_CONFLICT'
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsessionquery--sessionqueryengine-abstract-seam"></a>

### `ctx.sessionQuery` — `SessionQueryEngine` (abstract seam)

Unified live-preferred session query service.

Exact reads, filters, and traces are backend-independent concrete behavior. A backend implements full-text observation, reconciliation, ranking, cursor generations, and query execution on the same `ctx.sessionQuery` service.

```ts cordis-catalog
/**
 * Observe one exact live or prepared Session without a persistence listing preflight.
 * @param sessionId - logical Session identity.
 * @param options - cancellation and projection selection for this read.
 * @returns a caller-owned observation lease.
 */
observeSession( sessionId: SessionId, options: SessionObservationOptions = {}, ): Promise<SessionObservation>

/**
 * Sample the current live or unpublished prepared Session in one synchronous callback.
 * Uses store message definitions, with no Agent activation or persistent writes.
 * The runtime reader is the original full Session. Do not mutate it, yield, retain
 * its observation, or return borrowed containers; return independently owned data.
 * A cold observation excludes the end-seed marker added by preparation; Session seq includes it.
 * The lease releases in finally on success or callback failure. Cold cancellation
 * uses the observation error taxonomy; callback exceptions propagate unchanged.
 * @param sessionId - logical Session identity; caller owns source authorization.
 * @param capture - synchronous callback over the selected Session and its source observation.
 * @param options - cancellation and projection selection; no preparation-mode override.
 * @returns independently owned callback output after releasing the observation lease.
 */
captureSession<Value>( sessionId: SessionId, capture: (session: SessionCaptureReader, observation: SessionObservation) => Value & (Value extends PromiseLike<unknown> ? never : unknown), options: SessionObservationOptions = {}, ): Promise<Value>

/**
 * Search the live-preferred logical corpus and group by session.
 * @param request - query text, metadata filters, page size, and cursor.
 * @param exec - optional cancellation control.
 * @returns session hits ranked by their strongest matching event.
 */
abstract searchSessions( request: SessionSearchRequest, exec?: SessionSearchExecContext, ): Promise<SessionSearchPage<SessionSearchHit>>

/**
 * Search events within one live-preferred logical session.
 * @param request - target session, query text, filters, page size, and cursor.
 * @param exec - optional cancellation control.
 * @returns matching event hits and their target header from one indexed generation.
 */
abstract searchEvents( request: SessionEventSearchRequest, exec?: SessionSearchExecContext, ): Promise<SessionEventSearchPage>

/**
 * List the complete logical corpus using live-preferred records.
 * @param signal - optional cancellation for persistence listing.
 * @returns deterministic newest-first cloned session records.
 */
listSessions(signal?: AbortSignal): Promise<SessionRecord[]>

/**
 * Page newest-first metadata from an immutable snapshot; continuation never re-lists persistence.
 * @param request - metadata filters, positive page size, and optional snapshot cursor.
 * @param signal - cancellation for metadata observation and waiting.
 * @returns detached records; expired, evicted, or unloaded snapshots reject with STALE_CURSOR.
 */
async pageSessions(request: SessionMetadataPageRequest, signal?: AbortSignal): Promise<SessionSearchPage<SessionRecord>>

/**
 * Project only one ascending raw-event page from one live or prepared observation.
 * @param request - target, exclusive seq bound, optional types and text, and positive page size.
 * @param signal - cancellation during cold resolution and page scanning.
 * @returns page metadata, exact source header and observed upper seq, and optional continuation.
 */
async pageEvents(request: SessionEventPageRequest, signal?: AbortSignal): Promise<SessionEventPage>

/**
 * Read and replay-validate one complete logical session log without making it live.
 * @param sessionId - live or persisted session id to read.
 * @returns cloned header and complete raw event log from one observation.
 * @throws when persistence, header compatibility, or replay validation fails.
 */
async readSession(sessionId: SessionId): Promise<SessionLogSnapshot>

/**
 * Filter logical sessions; exact id clauses avoid a complete persistence listing.
 * @param filters - ANDed session metadata and availability clauses.
 * @param signal - optional cancellation for persistence observations.
 * @returns matching cloned records in deterministic newest-first order.
 */
async filterSessions( filters: readonly SessionResultFilter[], signal?: AbortSignal, ): Promise<SessionRecord[]>

/**
 * Fold the latest log-backed title from one live-preferred logical session.
 * @param sessionId - live or persisted session id to read.
 * @param signal - optional cancellation for source resolution and title folding.
 * @returns latest title snapshot, or `undefined` when the log has no title event.
 */
async readTitle( sessionId: SessionId, signal?: AbortSignal, ): Promise<SessionTitleSnapshot | undefined>

/**
 * Fold the latest title and return its source header from one corpus observation.
 * @param sessionId - live or persisted session id to read.
 * @param signal - optional cancellation for source resolution and title folding.
 * @returns cloned source header and optional latest title snapshot.
 */
async readTitleSnapshot( sessionId: SessionId, signal?: AbortSignal, ): Promise<SessionTitleObservation>

/**
 * Fold titles for unique sessions from one cancellable corpus observation.
 *
 * Results preserve first-occurrence input order. Operational failures stay
 * isolated per session, while cancellation rejects the complete operation.
 * @param sessionIds - live or persisted session ids to observe.
 * @param signal - optional cancellation shared by all source reads.
 * @returns one fulfilled or rejected result per unique requested id.
 */
async readTitleSnapshots( sessionIds: readonly SessionId[], signal?: AbortSignal, ): Promise<SessionTitleObservationResult[]>

/**
 * List lightweight raw-log event records for one logical session.
 * @param sessionId - live-preferred session id to read.
 * @returns event records in ascending seq order.
 */
async listEvents(sessionId: SessionId): Promise<SessionEventRecord[]>

/**
 * Scan first-party semantic event documents with provider-independent filters.
 * @param sessionId - live-preferred session id to scan.
 * @param filters - ANDed metadata and literal-text predicates.
 * @returns matching semantic documents in ascending seq order.
 */
async filterEvents( sessionId: SessionId, filters: readonly SessionEventResultFilter[], ): Promise<SessionEventSearchDocument[]>

/**
 * Read original current surface events from an exact cut, reusing owner-held analysis.
 * @param sessionId - live-preferred session id to read.
 * @returns cloned header, current surface, and the last sequence number included in the raw-log capture.
 * @throws when source resolution fails or the session surface is invalid.
 */
async readSurface(sessionId: SessionId): Promise<SessionSurfaceSnapshot>

/**
 * Trace known ancestry and descendants from one corpus observation.
 * @param sessionId - logical session id to trace.
 * @param signal - optional cancellation for persistence listing.
 * @returns a complete lineage or the first parent that could not be resolved.
 * @throws when corpus resolution fails, the target is absent, or its known ancestry cycles.
 */
async traceSession(sessionId: SessionId, signal?: AbortSignal): Promise<SessionLineageTrace>

/**
 * Trace direct replacements and citations at an exact cut, advancing only unseen events.
 * @param request - target session id and event seq.
 * @param signal - optional cancellation for persisted source resolution.
 * @returns source header, direct links, and the target's positional replacement chain.
 * @throws when source resolution fails, the target is absent, or surface/source-event validation fails.
 */
async traceEvent(request: SessionEventTraceRequest, signal?: AbortSignal): Promise<SessionEventTraceObservation>

/**
 * Read one full event plus a bounded raw-log context window.
 * @param request - target session/seq and context sizes.
 * @param signal - optional cancellation for persisted source resolution.
 * @returns cloned target and neighboring events.
 */
async readEvent(request: SessionEventReadRequest, signal?: AbortSignal): Promise<SessionEventWindow>
```

Types: [SessionId](core.zh.md) · [SessionTitleSnapshot](session-title.zh.md)

Source: [`packages/session-query/session-query/src/index.ts`](../../packages/session-query/session-query/src/index.ts)
<!-- END GENERATED cordis-surface -->
