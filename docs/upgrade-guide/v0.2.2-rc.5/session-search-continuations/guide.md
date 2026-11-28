---
kind: upgrade-guide
description: "SQLite full-text search changes multi-term matching, the event search API, and continuation cursors."
---

# SQLite full-text search

English | [中文](guide.zh.md)

## Change

Multi-word queries previously matched one contiguous phrase. Spaces and uppercase `AND` now require all terms within the same event, in any order. Double quotes match an exact phrase; parentheses group; uppercase `OR` binds more tightly than AND; and a trailing `*` on a bare term matches a prefix. An attached leading `-` now excludes an item. Queries need a positive term; the Web session list retries an all-exclusion query as a literal phrase.

SQLite `searchSessions` and `searchEvents` issue v3 cursors and reject older cursors, including v2, with `SESSION_QUERY_INVALID_CURSOR`. A v3 cursor continues at the same offset in the current ranking. A changed corpus can repeat or skip hits rather than returning `SESSION_QUERY_STALE_CURSOR`. Metadata-only `pageSessions` retains its separate snapshot and expiry behavior.

Event search callers pass `sessionFilters` instead of `sessionId`, and read the indexed session header from each hit instead of `page.session`. Omitting `sessionFilters` searches all sessions. An absent id in a filter produces no hits.

## Migration

1. Wrap a query in double quotes to retain contiguous phrase matching, for example `"academic-source CLI"`. Quote a leading `-` when you want to search it as literal phrase text, for example `"-timeout retry"`. Confirm that the query finds a known event.
2. Replace `searchEvents({ sessionId: id, query })` with `searchEvents({ query, sessionFilters: [{ kind: 'id', values: [id] }] })`. Keep event filters under `filters`; read each header from `page.items[i].session`. Verify each hit's session is in the requested set.
3. Discard any outstanding full-text cursors and start each search again without `cursor`. Keep the normalized request unchanged on subsequent pages, including filters and limit.
4. When combining several pages, deduplicate session results by session id and event results by session id plus event sequence, because corpus changes between pages can repeat a hit. No index or Session data migration is needed.
