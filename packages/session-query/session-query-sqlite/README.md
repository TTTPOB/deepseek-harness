---
description: "The SQLite FTS5 full-text search backend for session history, for deployments and maintainers choosing, configuring, or debugging full-text search over the query service."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-query-sqlite

English | [中文](README.zh.md)

## Summary

Use this package to add ranked SQLite FTS5 search across session history, either across sessions or within one session, with cursor pagination. It indexes live and persisted history in a separate derived database, so searches reflect locally observed state without rewriting persisted history. Exact reads, filters, and traces remain available through the same query API. Search is opt-in in shipped compositions; configure `openAt` to open the index at startup, on first search, or never. Results match tokens and phrases rather than arbitrary substrings, and each index path has a single process owner.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package when a composition needs ranked full-text search over session history — for example the Web content search or `/resume` prior-work retrieval. The common path is explicit: mount the plugin, give it a dedicated database path, and call `ctx.sessionQuery.searchSessions` or `searchEvents` from code.

### When to choose it

Choose it when you want full-text recall over prior sessions with ranking and paging. Choose it together with `dsh-session-query` and the session service; a persistence backend is optional but recommended so persisted history is searchable after restarts. Avoid pointing `path` at the session-persistence database — this package owns a separate derived index.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-query-sqlite'
  config:
    path: /absolute/path/to/session-search.db
```

| Field | Default | Meaning |
|---|---|---|
| `path` | required | Dedicated derived-index SQLite path, or `:memory:`; missing paths are created owner-only on POSIX |
| `keysPath` | `<path>.keys.db` | Dedicated document-key sidecar path, or `:memory:` (the default when `path` is `:memory:`); must differ from `path` |
| `openAt` | `startup` | `startup` opens at activation; `first-search` defers the SQLite module until the first search; `never` disables full-text search while inherited reads stay available |
| `warmupWaitMs` | `3000` | Maximum wait for background warmup on a cross-session search, in milliseconds; `0` returns immediately |
| `journalMode` | `wal` | `wal`, `delete`, `truncate`, or `persist` |
| `synchronous` | `full` | `normal` is honored only with WAL, for both index files |
| `defaultLimit` | `20` | Page size when a request omits `limit` |
| `maxLimit` | `100` | Largest accepted request page size |
| `snippetChars` | `240` | Maximum snippet length in Unicode code points |
| `readWindowMax` | `50` | Maximum `before`/`after` raw events for the inherited `readEvent()` |
| `persistedReadConcurrency` | `4` | Concurrent persisted-log reads for inherited batch reads |
| `preparedSessionCacheSize` | `5` | Cold prepared-Session observations the inherited `observeSession` reader retains for reuse |
| `metadataCacheTtlMs` | `5000` | Inherited metadata freshness window in milliseconds; 0 disables reuse |
| `sessionPageSnapshotTtlMs` | `60000` | Inherited listing snapshot lifetime in milliseconds |
| `sessionPageSnapshotCapacity` | `8` | Inherited listing snapshot capacity |
| `maxIndexedSessionBytes` | `33554432` | Largest persisted log artifact, in bytes, read into the index; a larger session stays out of search and is reported through `ctx.logger.warn` |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-query-sqlite) is the exhaustive source for every accepted field and its JSDoc.

### Search behavior

With `openAt: startup`, the service starts background warmup at activation. With `openAt: first-search`, the first request starts the same service-owned operation. Cross-session search waits at most `warmupWaitMs` milliseconds; if history is still not ready, it returns retryable `SESSION_QUERY_INDEX_WARMING`, not an empty page. Once document keys are ready, `searchEvents` can search its target without waiting for the full history. Aborting a request cancels only its own wait.

`searchSessions` searches the whole corpus and groups results by each session's strongest matching event; `searchEvents` searches one logical session. Queries are literal phrases: they are trimmed and whitespace-normalized, and FTS5 syntax such as quotes, `OR`, `NEAR`, and `*` is treated as data, never as executable query syntax. Metadata filters (session id, excluded session ids, cwd, created-at, parent, availability, event seq/time/type/surface) narrow results before ranking. All `current`, `shadowed`, and `log-only` events are searchable by default; pass a surface filter to narrow.

Ranking uses BM25 with one historical background for persisted and live matches. Live bodies contribute their latest phrase frequency and token length, but do not change historical statistics; old persisted bodies of live-shadowed sessions remain background only. When history has no indexed tokens, ranking uses the live average token length and a common IDF of 1. A phrase absent from history also uses IDF 1. The common phrase IDF cancels for ranking; both sources round normalized scores to 12 decimal places so inversion noise does not override metadata ties. Event time, session id, and seq break score ties. Results carry plain-text snippets bounded by `snippetChars` Unicode code points, without numeric scores.

Each opaque cursor binds the normalized search request. A continuation ranks the current corpus and starts at the position recorded in the cursor. Corpus changes between pages can cause duplicate or skipped results.

The `unicode61` tokenizer matches tokens and phrases, not arbitrary substrings: `AI` does not match the token `BRAID`. Use `ctx.sessionQuery.filterEvents()` with a `text` clause when a literal whitespace-flexible substring scan is required.

### When to defer or disable search

With `openAt: first-search`, the service activates without importing `node:sqlite` or opening the index, deferring SQLite's experimental warning until the first actual search; an invalid database fails that first search instead of service activation. With `openAt: never`, full-text search is off for the deployment: `searchSessions` and `searchEvents` fail with `SESSION_QUERY_SEARCH_DISABLED` before any request normalization, while every inherited exact read, filter, and trace keeps working. Requests that exceed the compiled-predicate budget (14 combined predicates across sessions, 13 within a session) or SQLite's portable 32,766-binding limit fail with `SESSION_QUERY_INVALID_FILTER` before statement preparation.

### Failures and recovery

Typed `SessionQueryError` failures carry stable codes: `SESSION_QUERY_SEARCH_DISABLED` when search is configured off; `SESSION_QUERY_INDEX_FAILED` when the index cannot open or reconcile; `SESSION_QUERY_SESSION_NOT_FOUND` when a search target is absent; and `SESSION_QUERY_INVALID_CURSOR` for malformed cursors or cursors from a different request.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the backend and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The backend is built on one separation and two commitments:

- **Derived index, never the source store.** The FTS rows live in a dedicated disposable database; the session-persistence database is never opened here.
- **Live-preferred observation.** An attached live session takes precedence over its indexed historical body.
- **Literal phrases as data.** Caller query text is quoted into one FTS5 phrase so query syntax stays inert, and reserved highlight markers are stripped from documents before indexing.

The design history lives in the [SQLite FTS5 session search note](../../../.agents/notes/archived/feature/2026-07-10-sqlite-session-query-provider.md) and the [unified service decision](../../../.agents/notes/archived/architecture/2026-07-23-unified-session-query-service.md).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service: config, openAt lifecycle, background warmup and dirty tracking |
| [`src/query.ts`](src/query.ts) | Request normalization, parameterized predicates, snippets, predicate and binding budgets |
| [`src/bm25.ts`](src/bm25.ts) | Connection-local token probe and historical BM25 calibration |
| [`src/schema.ts`](src/schema.ts) | Database schema, application-id ownership, in-place reset, owner-only file creation |

### Index lifecycle

One worker owns SQLite and the JSONL reader. It reads, decompresses, and projects durable logs off the Host thread. Each changed stored session commits a new generation together with its revision, FTS rows, and keys; reopening skips committed revisions. Lifecycle events mark changed sessions dirty, and live projection yields between batches on the Host. Non-JSONL backends supply raw logs through the generic persistence interface on their owning thread.

Ranking materializes complete MATCH candidates with metadata and native BM25 scores before filters, session-best selection, and pagination; it never truncates either source before merging. Event queries restrict both raw branches to the target session before materialization, while calibration and phrase statistics remain global. Full highlighting runs only for the bounded result page. A reusable TEMP unicode61 token probe measures changed live bodies, and a TEMP rowid-to-token-count table updates in the same transaction as live FTS rows. Unchanged bodies are not retokenized; retirement removes their counts.

For one literal phrase in the single indexed text column, public `bm25` calls at weights 1 and 2 recover the phrase IDF. One token-bearing historical body and its probe term frequency calibrate historical average length, without a historical vocabulary scan or persistent schema change. Every successful historical transaction invalidates that calibration, including partial reconciliation progress. Live native scores recover actual phrase frequency (including overlapping occurrences), then use the shared historical average and IDF. This mechanism must be replaced if queries become multiple phrases or additional columns become indexed.

### Schema ownership

The database carries an application id and schema version 8. Opening refuses a file owned by another application or a canonical database, rejects unknown user tables, and only a recognized incompatible derived schema resets in place — so an unrelated or session-persistence database is never touched. On POSIX filesystems, missing directories and database files are created owner-only (`0700` and `0600` before the process umask). Exactly one service in one process owns a derived-index path; generations and TEMP shadow state are connection-owned.

The attached document-key sidecar upgrades schema 1 in place and preserves the main schema and path. A generation mismatch starts or resumes a bounded rebuild from the main FTS table without reading session logs. Each committed batch checkpoints progress, and queries never use partially rebuilt keys.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared query service to the type-level contract and the design evidence.

- [Session Query subsystem reference](../../../docs/subsystems/session-query.md) — the full type-level contract this backend implements.
- [dsh-session-query](../session-query/README.md) — the service definition: exact reads, filters, and traces this backend inherits.
- [dsh-tool-session-query](../../experimental/tool-session-query/README.md) — the model-facing consumer that calls these search methods.
- [SQLite FTS5 session search](../../../.agents/notes/archived/feature/2026-07-10-sqlite-session-query-provider.md) — search semantics, reconciliation, and the tokenizer decision.
- [JSONL session persistence](../../session/session-persistence-jsonl/README.md) — the authoritative Session store this disposable index observes; keep its root separate from this package's database path.

-----

<a id="model-experience"></a>
## Model Experience

None, as the search backend returns hits only to callers and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this package is a poor fit or needs special operational care. They are current package constraints, not a general SQLite comparison or a task backlog.

- **No caller authorization** — this is a trusted context-wide service; a model tool or UI must enforce its own access policy.
- **Synchronous worker queries** — a large MATCH can queue other work on the index worker, but does not block the Host event loop.
- **Token recall, not arbitrary substrings** — the `unicode61` tokenizer does not match substrings inside a larger token; use `filterEvents()` for literal scans.
- **Single-owner derived index** — one service in one process must own each index path; external writers and multi-process sharing are unsupported.
- **External file changes are not discovered in real time** — another process editing persisted files emits no local lifecycle notification; restart the query service or replace the persistence service to rescan metadata on the first search.
- **Oversized sessions stay out of search** — the index never reads a stored log artifact above `maxIndexedSessionBytes`; it warns through `ctx.logger.warn` for each one and keeps the rest of the corpus searchable. Crossing the bound also evicts a session that is already indexed, so a query never answers from a row its stored log has outgrown, and lowering the bound evicts every session above it. Raise the limit to include such a session, and expect build cost proportional to its size. A backend that omits `SessionPersistenceSnapshot.sizeBytes` is indexed without this bound.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Packed worker smoke

Install the packed SQLite and session-query packages together with the target JSONL persistence package into a disposable pnpm prefix. Run `node tests/pack-smoke.mjs <prefix>` from this package to verify the SQLite worker resolves the installed JSONL peer and indexes a compressed log. This smoke does not open a Host.

#### Future: alternate tokenizers and search providers

The `unicode61` tokenizer choice trades substring recall for index size and two-character token support; the trigram alternative was measured and rejected. Switching tokenizers or adding another search backend would change indexed recall and require its own reconciliation and generation story.

</details>
