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

<a id="search-behavior"></a>
### Search behavior

With `openAt: startup`, activation starts background warmup. With `openAt: first-search`, the first request starts it. Corpus-wide search waits up to `warmupWaitMs`; if the index is not ready, it returns retryable `SESSION_QUERY_INDEX_WARMING`. Once document keys are ready, `searchEvents` with an `id` filter can refresh and search the selected sessions without waiting for corpus warmup. Aborting a request cancels only its own wait.

`searchSessions` groups hits by each session's strongest matching event; `searchEvents` returns individual hits with the `session` header from the same indexed observation. Both accept `sessionFilters: [{ kind: 'id', values: ids }]`; omit session filters to search the whole corpus. Missing ids produce no hits. Metadata filters narrow results before ranking, and all `current`, `shadowed`, and `log-only` events are searchable by default.

#### Query syntax

| Input | Match |
|---|---|
| `alpha beta` or `alpha AND beta` | Every term appears in the same event, in any order and without requiring adjacency |
| `alpha beta OR gamma` | Equivalent to `alpha AND (beta OR gamma)`; only standalone uppercase `OR` is an operator |
| `"alpha beta"` | Adjacent tokens in order; write `""` for a literal double quote inside the phrase |
| `alpha -beta`, `alpha -"beta gamma"`, `alpha -(beta OR gamma)` | Exclude the item immediately after `-`; a standalone `-` is not an operator |
| `alph*` | A trailing `*` on a bare term makes its last token a prefix |

Other punctuation is literal text for tokenization: `reveal.js`, `academic-source`, and paths match their component tokens in adjacent order. Lowercase `and`, `or`, and `not` are ordinary words. Search ignores items without tokens. Unbalanced quotes or parentheses, missing `OR` operands, a negative-only subgroup or branch, and tokenless queries return `SESSION_QUERY_INVALID_QUERY`. A wholly negative query returns `SESSION_QUERY_EXCLUSION_ONLY`; the Web session list retries this case as one literal phrase.

Ranking uses a common historical BM25 background. Single-phrase ranking divides out its shared IDF and keeps the same result order. Compound queries add distinct positive phrase scores, using historical average document length and each phrase's historical IDF for both sources. Absent OR terms and exclusions add nothing. Historical bodies superseded by live copies contribute only to background statistics. With no historical tokens, ranking uses the live average length; phrases absent from history use IDF 1. Event time, session id, and event sequence break ties. The complete query selects excerpts of up to `snippetChars` Unicode code points; scores are not returned.

Each opaque cursor binds the normalized search request. A continuation ranks the current corpus and starts at the position recorded in the cursor. Corpus changes between pages can cause duplicate or skipped results.

The `unicode61` tokenizer matches tokens and phrases, not arbitrary substrings: `AI` does not match the token `BRAID`. Use `ctx.sessionQuery.filterEvents()` with a `text` clause when a literal whitespace-flexible substring scan is required.

### When to defer or disable search

With `openAt: first-search`, the service activates without importing `node:sqlite` or opening the index, deferring SQLite's experimental warning until the first actual search; an invalid database fails that first search instead of service activation. With `openAt: never`, full-text search is off for the deployment: `searchSessions` and `searchEvents` fail with `SESSION_QUERY_SEARCH_DISABLED` before any request normalization, while every inherited exact read, filter, and trace keeps working. Requests that exceed the compiled-predicate budget (14 combined session and event predicates) or SQLite's portable 32,766-binding limit fail with `SESSION_QUERY_INVALID_FILTER` before statement preparation.

### Failures and recovery

Typed `SessionQueryError` failures carry stable codes: `SESSION_QUERY_SEARCH_DISABLED` when search is configured off; `SESSION_QUERY_INDEX_FAILED` when the index cannot open or reconcile; and `SESSION_QUERY_INVALID_CURSOR` for malformed cursors or cursors from a different request.

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
- **Provider-owned query syntax.** The parser emits only its supported logical operators; FTS5 receives each user query term as quoted text.

The design history lives in the [SQLite FTS5 session search note](../../../.agents/notes/archived/feature/2026-07-10-sqlite-session-query-provider.md) and the [unified service decision](../../../.agents/notes/archived/architecture/2026-07-23-unified-session-query-service.md).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service: config, openAt lifecycle, background warmup and dirty tracking |
| [`src/query.ts`](src/query.ts) | Request normalization, parameterized predicates, snippets, predicate and binding budgets |
| [`src/query-syntax.ts`](src/query-syntax.ts) | Lexer, query tree, FTS expressions, and distinct positive phrases |
| [`src/bm25.ts`](src/bm25.ts) | Connection-local token probe and historical BM25 calibration |
| [`src/schema.ts`](src/schema.ts) | Database schema, application-id ownership, in-place reset, owner-only file creation |

### Index lifecycle

One worker owns SQLite and the JSONL reader. It reads, decompresses, and projects durable logs off the Host thread. Each changed stored session commits a new generation together with its revision, FTS rows, and keys; reopening skips committed revisions. Lifecycle events mark changed sessions dirty, and live projection yields between batches on the Host. Non-JSONL backends supply raw logs through the generic persistence interface on their owning thread.

Compound queries first store candidates from the complete expression in a connection-local table. Each positive phrase has one scoring MATCH cursor per source. A cross join puts that cursor on the outside and checks candidate rowids before computing `bm25`. The complete expression highlights only the bounded result page. Changed live bodies update their FTS rows and token lengths together.

Public `bm25` scores at text-column weights 1 and 2 recover the phrase IDF and actual term frequency, including overlaps. One token-bearing historical document and its measured term frequency calibrate historical average length without scanning the historical vocabulary. Each successful historical write transaction invalidates that calibration.

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

None, as the backend returns ranked hits to its callers without registering model-visible context.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this package is a poor fit or needs special operational care. They are current package constraints, not a general SQLite comparison or a task backlog.

- **No caller authorization** — this is a trusted context-wide service; a model tool or UI must enforce its own access policy.
- **Synchronous worker queries** — a large MATCH can queue other work on the index worker, but does not block the Host event loop.
- **Token recall, not arbitrary substrings** — the `unicode61` tokenizer does not match substrings inside a larger token; use `filterEvents()` for literal scans.
- **AND operates within one event** — terms spread across different events in one session do not form a match.
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
