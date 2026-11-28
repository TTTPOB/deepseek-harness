---
kind: upgrade-guide
description: "SQLite full-text search changes the event search request, result headers, and continuation cursors."
---

# SQLite full-text search

English | [中文](guide.zh.md)

## Change

SQLite `searchSessions` and `searchEvents` reject cursors issued before this upgrade with `SESSION_QUERY_INVALID_CURSOR`. New cursors continue at the same offset in the current ranking. A changed corpus can repeat or skip hits rather than returning `SESSION_QUERY_STALE_CURSOR`. Metadata-only `pageSessions` retains its separate snapshot and expiry behavior.

Event search callers pass `sessionFilters` instead of `sessionId`, and read the indexed session header from each hit instead of `page.session`. Omitting `sessionFilters` searches all sessions. An absent id in a filter produces no hits.

## Migration

1. Replace `searchEvents({ sessionId: id, query })` with `searchEvents({ query, sessionFilters: [{ kind: 'id', values: [id] }] })`. Keep event filters under `filters`; read each header from `page.items[i].session`. Verify each hit's session is in the requested set.
2. Discard any outstanding full-text cursors and start each search again without `cursor`. Keep the normalized request unchanged on subsequent pages, including filters and limit.
3. If collecting several pages for display, deduplicate by session id or by the pair of session id and event sequence as appropriate. Verify that a continuation succeeds after unrelated session activity. No index or Session data migration is needed.
