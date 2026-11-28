---
kind: upgrade-guide
description: "SQLite full-text search changes multi-term matching, the event search API, and continuation cursors."
---

# SQLite full-text search

English | [中文](guide.zh.md)

## Change

Multi-word queries previously matched one contiguous phrase. Spaces and uppercase `AND` now require all terms within the same event, in any order. Double quotes match an exact phrase; parentheses group; uppercase `OR` binds more tightly than AND; and a trailing `*` on a bare term matches a prefix. An attached leading `-` now excludes an item. Queries need a positive term; the Web session list retries an all-exclusion query as a literal phrase.

SQLite `searchSessions` and `searchEvents` reject cursors issued before this upgrade with `SESSION_QUERY_INVALID_CURSOR`. New cursors continue at the same offset in the current ranking. A changed corpus can repeat or skip hits rather than returning `SESSION_QUERY_STALE_CURSOR`. Metadata-only `pageSessions` retains its separate snapshot and expiry behavior.

Event search callers pass `sessionFilters` instead of `sessionId`, and read the indexed session header from each hit instead of `page.session`. Omitting `sessionFilters` searches all sessions. An absent id in a filter produces no hits.

## Migration

1. Wrap a query in double quotes to retain contiguous phrase matching, for example `"academic-source CLI"`. Quote a leading `-` when you want to search it as literal phrase text, for example `"-timeout retry"`. Confirm that the query finds a known event.
2. Replace `searchEvents({ sessionId: id, query })` with `searchEvents({ query, sessionFilters: [{ kind: 'id', values: [id] }] })`. Keep event filters under `filters`; read each header from `page.items[i].session`. Verify each hit's session is in the requested set.
3. Discard any outstanding full-text cursors and start each search again without `cursor`. Keep the normalized request unchanged on subsequent pages, including filters and limit.
4. If collecting several pages for display, deduplicate by session id or by the pair of session id and event sequence as appropriate. Verify that a continuation succeeds after unrelated session activity. No index or Session data migration is needed.
