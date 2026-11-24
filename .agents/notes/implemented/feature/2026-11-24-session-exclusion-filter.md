# Agent Note: Exclude sessions before ranking

Status: implemented

English | [中文](2026-11-24-session-exclusion-filter.zh.md)

## Problem

Search consumers exclude some sessions from their results: the experimental cross-session search tool omits the caller's own session, and an out-of-tree session tool also omits archived sessions. With only inclusion filters, they discarded those hits from each page after the provider had ranked and paged it. The provider counts excluded hits toward `limit`, so a page can come back short or empty while more results remain. A consumer that refills pages must track how far into a provider page it has read, because provider cursors mark only page boundaries.

## Decision

[`SessionResultFilter`](../../../../packages/session-query/session-query/src/types.ts) includes `{ kind: 'exclude-ids'; values: readonly SessionId[] }`. The clause removes every listed session id. An empty list removes none, whereas an empty inclusion list matches nothing. The clause combines with the other clauses by AND. [`filterSessionResults`](../../../../packages/session-query/session-query/src/filters.ts) applies it to in-memory records, and the SQLite provider compiles it to `session_id NOT IN (…)` in [the session predicate](../../../../packages/session-query/session-query-sqlite/src/query.ts), which runs before ranking and pagination. Every operation that accepts `SessionResultFilter` accepts the clause.

The [experimental cross-session search tool](../../../../packages/experimental/tool-session-query/src/operations.ts) passes the caller's id in this clause instead of discarding the caller's hits page by page.

## Alternatives considered

**Refill pages in each consumer.** Every consumer would repeat provider calls and record a position inside a provider page, which the opaque provider cursor cannot express.

**A general negation clause.** Only session-id exclusion has a consumer. Negating nullable lists and ranges would need semantics that no caller uses.

**Provider flags such as "exclude the caller" or "exclude archived".** The provider does not know the calling agent, and archive state belongs to the workspace registry, not to session query. An id list keeps both decisions with the consumer.

## Consequences

Excluded sessions no longer occupy page slots, so short pages occur only at the end of the results. The id list is part of the normalized request that search cursors bind ([request-bound cursors](../bug-fix/2026-11-24-request-bound-search-cursors.md)): continuations must pass the same set of ids, and a set that changed between pages, for example after a session is archived, makes the old cursor invalid. `SessionResultFilter` is a closed union that code outside this repository also consumes; an exhaustive switch over filter kinds must handle the new kind.
