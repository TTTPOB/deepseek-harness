---
kind: upgrade-guide
description: "SQLite full-text search rejects cursors issued before the upgrade and continues across corpus changes."
---

# SQLite full-text search continuations

English | [中文](guide.zh.md)

## Change

SQLite `searchSessions` and `searchEvents` reject cursors issued before this upgrade with `SESSION_QUERY_INVALID_CURSOR`. New cursors continue at the same offset in the current ranking. A changed corpus can repeat or skip hits rather than returning `SESSION_QUERY_STALE_CURSOR`. Metadata-only `pageSessions` retains its separate snapshot and expiry behavior.

## Migration

1. Discard any outstanding full-text cursors and start each search again without `cursor`. Keep the normalized request unchanged on subsequent pages, including filters and limit.
2. If collecting several pages for display, deduplicate by session id or event sequence as appropriate. Verify that a continuation succeeds after unrelated session activity. No index or Session data migration is needed.
