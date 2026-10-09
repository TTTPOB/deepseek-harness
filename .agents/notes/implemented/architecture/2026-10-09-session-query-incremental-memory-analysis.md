# Agent Note: Reuse session-query caches and maintain incremental in-memory analysis

Status: implemented

English | [中文](2026-10-09-session-query-incremental-memory-analysis.zh.md)

## Problem

`readSurface` needs current original message events in folded position order; `traceEvent` needs one target's complete direct sources, later direct citations, and replacement chain. Repeatedly cloning a complete log, folding it, and constructing a record for every event makes these reads pay for outputs they do not return. A stationary-result cache alone also repeats the fold after each append.

Session events are immutable, live observations capture an exact event prefix, and cold observations retain restored Sessions by persistence identity and revision. These owners provide reusable in-memory inputs. The first cold read still requires complete I/O, interrupted-turn repair, and restoration validation; the optimization concerns analysis of retained inputs, not local disk range reads.

## Decision

`readSurface` and `traceEvent` use observation-owned canonical analysis. This refines the [observation ownership decision](<2026-08-25-session-observations-and-projection-owned-client-state.md>) and retains the entry points named by the [convenience API trimming proposal](<../../proposed/simplification/2026-09-19-trim-session-query-convenience-api.md>). Neither record is superseded.

### Shared canonical folding and separate relationship indexes

Core's `SurfaceFoldAccumulator` in [surface.ts](<../../../../packages/core/session/src/surface.ts>) processes a contiguous prefix from seq 0 through the same plan/apply transitions as `SurfaceManager`. `foldSurface` wraps the accumulator and preserves its complete-fold interface. Each append returns detached metadata for an actual positional replacement, including its shadowed nodes; validation failure leaves that event unapplied. Borrowed projection definitions remain required after use, so missing or unloaded interpreters invalidate reads and appends.

Query's `EventLogAnalysis` in [tracing.ts](<../../../../packages/session-query/session-query/src/tracing.ts>) retains immutable event references, interpreted messages, and sequence indexes, without another payload copy. It advances lazily over `[processed, cut)` on the same live Session, where cut is the exclusive event offset; unqueried appends add no analysis work. Actual replacements and reverse direct-source citations have separate indexes: citing a diagnostic does not shadow it, and an ordinary source append can change a trace without a replacement. Correctness does not depend on `session/event` delivery or replacement generation.

Surface output contains original events, including empty-message nodes, in canonical node-position order, rather than image-offloaded interpreted Messages. Trace preserves the target's direct-source order, ascending later direct citations, and the chain of actual shadow replacements. It does not substitute a local window for a complete trace. Surface and single-target trace do not first construct N event records; full-list consumers still materialize records when needed. Only final surface events, headers, and trace metadata are detached for callers; see `readSurface` and `traceEvent` in [the query engine](<../../../../packages/session-query/session-query/src/index.ts>).

### Exact cuts and owner lifetime

`SessionObservationReader.project` in [observation.ts](<../../../../packages/session-query/session-query/src/observation.ts>) resolves the source asynchronously, then captures the cut, advances analysis, and projects owned output in one synchronous segment. Its lease is released in finally. Later appends cannot mutate the answer. `analyzeObservation` temporarily rebuilds from an old lease's prefix if shared analysis has already passed that cut; merely filtering new seqs cannot reconstruct an old surface. There is no long-lived multiversion analysis cache.

Live state belongs to the reader's `WeakMap<Session, EventLogAnalysis>`, not to a strong map keyed by session id or a new Session public relationship API. Cold analysis belongs to `PreparedEntry`; reuse requires the same persistence identity, revision, and preparation mode. A revision change, a new live Session object, or cold-to-live promotion rebuilds analysis before that live object's subsequent appends can be incremental.

This rebuild rule is necessary because [cold reading](<../../../../packages/session-query/session-query/src/cold-read.ts>) appends synthetic interrupted-turn closers in memory, including possible tool results. Later real events can occupy those seqs, so a previous balanced cold log need not be the next revision's prefix. A prepared Session can also contain an end-seed marker beyond `entry.events`; analysis uses the observation cut rather than the prepared Session's latest nodes. There is no cross-revision prefix comparison, synthetic-tail rollback, or cold-to-live transfer.

Unpinned cold entries are capacity-evicted; old leases retain their entries until release. `session/disposed` deletes live weak keys. Reader disposal clears the prepared cache and replaces the WeakMap, and in-flight source resolution cannot refill either after disposal. The query engine registers reader teardown through its Cordis effect. Frozen references and interpreted messages share their owner's lifetime.

### Preparation modes and error ordering

Public `observeSession` keeps store-definition preparation. Internal surface/trace preparation uses the [canonical catalog](<../../../../packages/session/session-format-catalog/src/message-projections.ts>) and `Session.fromRestore`; `projectionMode: "none"` skips registry projection, not restoration validation. Prepared entries are mode-specific. Session's borrowed store definitions and the canonical catalog are not interchangeable merely because interpreter names match, so directly reusing `session.surface.nodes` would not establish equivalent semantics.

Trace checks target existence on the selected prefix before canonical folding and preparation. Canonical fold failures retain `SESSION_QUERY_INVALID_SURFACE`; restoration corruption remains `SESSION_QUERY_CORRUPT_SESSION`. Source/header conflict, absent sessions or events, persistence failure, and cancellation retain their query categories and ordering. The internal adapter preserves the corpus path's operation-specific persistence mapping: corruption during read is distinguished from stat/backend failures; it does not replace every preparation or backend exception with one generic error. See `resolve`, `mapCorpusFailure`, and `throwIfAborted` in [observation.ts](<../../../../packages/session-query/session-query/src/observation.ts>).

## Responsibilities and impact

| Module | Responsibility |
|---|---|
| Core Session / SurfaceManager | Own canonical positional and interpretation validation and shared fold transitions; keep existing Session surface interfaces. |
| `session-query` | Own cut-specific analysis, detached results, source/error adaptation, and entry/weak-key lifecycle. |
| `dsh-session-tools` | Own shared Compact/Detail associations, bounded supplementary reading, Raw, and lightweight search entry points through public query; see [ADR 0001](<../../../../../dsh-session-tools/docs/adr/0001-shared-event-association-and-projection.md>), [ADR 0002](<../../../../../dsh-session-tools/docs/adr/0002-local-reading-and-completeness.md>), and [ADR 0003](<../../../../../dsh-session-tools/docs/adr/0003-search-and-projection-separation.md>). |
| SQLite / persistence / codecs | Retain search indexing, disk formats, complete cold reading, restoration, and validation. |
| Full-history consumers | Retain complete preparation semantics; controller/GUI history is not a bounded local read. |

List/Detail use bounded original-field reads, not a full surface/trace for every page or search hit. Consumer defaults remain those confirmed by the [bounded real-history sample](<../../../../../dsh-session-tools/docs/reading-budgets.md>); omitting `surfaces` searches all existing indexed documents in current, shadowed, and log-only. [SQLite document construction](<../../../../packages/session-query/session-query/src/documents.ts>) indexes extracted text, not complete source/shadow relationships or surface position order. This decision adds no public relationship API, persistent activity tree, SQLite schema change, or storage migration. The consumer continues to read through public query only and never opens session files.

## Alternatives considered

**Reuse the Session's latest surface directly.** It has neither an old observation's cut nor complete replacement history, and its store interpreters can differ from query's canonical catalog. Sharing canonical transitions preserves semantics without duplicating positional algorithms.

**Persistent relationship tables or SQLite schema extensions.** Search documents are incomplete for surface/trace; completing them adds maintenance, migration, and invalidation costs. Retained in-memory analysis addresses the repeated work directly.

**Disk sidecars, frame indexes, migration framing, or reframing.** Existing reads restore all events, and seq directly indexes memory. Physical indexing alone cannot remove the first complete restoration, while genuine local disk reads also require codec and global-validation changes. Those costs are not justified by the current in-memory consumers.

**Cross-process validation credentials or skipping global validation.** Physical locations cannot certify that the whole log and its interpreters pass current restoration validation. A cross-owner version/invalidation protocol adds cost without serving this retained-input optimization.

**Model compaction tools.** They change model context and compaction transactions and remain an independent decision; this optimization changes query and reading only.

## Verification

Implementation acceptance includes 557 core tests, 116 query tests, and 323 affected-consumer tests; the final targeted core run has 7 tests and the final consumer run has 51. Differential and focused regressions cover append/replacement analysis, ordinary source citations, empty messages and image offload, old cuts, preparation modes, revision/new-live rebuilds, disposal, and in-flight resolution. Six public query error codes have been verified. These are recorded acceptance results, not a claim that every Host lifecycle was exercised end to end.

A plain Node ESM smoke using matching released tarballs, real Loader composition, and SQLite observed a first fold of 217 events, zero fold appends on repetition, only `[217]` for append, and only `[218]` for replacement. Old-lease reads and already returned outputs remained unchanged. This establishes retained live-input reuse; it does not establish an activated GUI/install or a cold-lifecycle end-to-end Host run.

## Consequences

Repeated reads reuse validated analysis, and normal appends on the same retained live Session process only unseen events. Memory still includes event references, interpreted messages, and relationship indexes proportional to the retained history; final surface copying scales with returned surface size. This is not a constant-memory or constant-time guarantee for all queries.

First-cold queries retain complete I/O, repair, validation, and restoration costs. Revision changes and new live objects rebuild. Consumer supplementary reads remain bounded and may return incomplete activities, as [ADR 0002](<../../../../../dsh-session-tools/docs/adr/0002-local-reading-and-completeness.md>) specifies. Synthetic performance diagnostics do not establish production CPU/memory guarantees, precise allocations, or first-cold speedups; cold lifecycle behavior has no end-to-end Host acceptance run.
