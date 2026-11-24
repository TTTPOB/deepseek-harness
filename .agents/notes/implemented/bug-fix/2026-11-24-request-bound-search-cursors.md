# Agent Note: Request-bound full-text search cursors

Status: implemented

English | [中文](2026-11-24-request-bound-search-cursors.zh.md)

## Problem

The SQLite provider bound each full-text search cursor to the service instance, the normalized request, and a corpus generation, and failed the next page with `SESSION_QUERY_STALE_CURSOR` once that generation changed ([original decision](../../archived/feature/2026-07-10-sqlite-session-query-provider.md)). Cross-session search used the global generation, which advances whenever a changed live session is reindexed. Every event a live session appends marks it changed, including the `tool/ptc-dispatch-start` record that PTC appends to the caller's session before each nested tool call. A model that searched from PTC therefore changed the corpus itself between two pages. A 14-day audit of one installation found continuations that failed 29–39 ms after the first page, for four different queries inside one PTC program; repeating the search failed the same way.

The cursor also carried the request as escaped JSON plus a UUID. A typical cursor was about 450 characters, and a model copies it into every continuation. In-repository consumers worked around the staleness: the experimental search tools ran exclusively with sibling tool calls, and the Host session search restarted from the first page on a stale cursor.

## Decision

[`SearchStore`](../../../../packages/session-query/session-query-sqlite/src/store.ts) encodes a cursor as `v2.<digest>.<offset>`. The digest is the first 12 bytes of SHA-256 over the canonical normalized request, encoded as base64url; the offset counts the ranked rows already returned. `searchSessions` and `searchEvents` require the digest to match the current request, rank the current corpus, and return rows from the offset onward. A malformed cursor, a cursor from another request, or a cursor in the earlier format fails with `SESSION_QUERY_INVALID_CURSOR`. The metadata snapshots of `pageSessions` keep their own cursors and their `SESSION_QUERY_STALE_CURSOR` expiry.

The provider tracks no cursor generation: live session rows carry no generation column, and cursors no longer name a service instance, so a cursor remains valid after a Host restart. Durable generations still order committed index writes.

The [Host session search](../../../../packages/api/session-controller/README.md) deduplicates hits by session id across provider pages and fails without partial results when the provider rejects a continuation. The [experimental search tools](../../../../packages/experimental/tool-session-query/README.md) deduplicate collected hits by session id or event seq and run alongside sibling tool calls. The [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-rc.5/session-search-continuations/guide.md) covers the cursor format change.

## Alternatives considered

**Keep generation binding but ignore the caller's own events.** This fixes only the PTC case. Subagents and other open sessions still advance the global generation, and the provider would need to know which session is calling.

**Pin a snapshot of each result list.** The provider would hold ranked results between calls and need an owner, a memory bound, and an expiry for them. No consumer needs pages that are consistent with each other; consumers need continuations that work.

**Keyset pagination on score and tie-breakers.** BM25 scores depend on corpus statistics, so a score stored in a cursor no longer marks the same position after the corpus changes. Cursors would also expose scores, which hits deliberately omit.

**Restart in the consumer on a stale cursor.** The Host session search did this. A model-facing tool cannot restart without repeating pages the model already received, and under continuous activity the restarted search goes stale again.

**Drop only the generation from the existing payload.** This removes the staleness but keeps a 450-character cursor; a digest binds the same request in 16 characters.

## Consequences

Continuations no longer fail because the corpus changed. In exchange, a page can repeat a hit from an earlier page or skip a hit that moved ahead of the offset; consumers that combine pages deduplicate. A cursor issued before this change fails once with `SESSION_QUERY_INVALID_CURSOR`, and the caller starts again without a cursor. Cursors shrink to about 20 characters.
