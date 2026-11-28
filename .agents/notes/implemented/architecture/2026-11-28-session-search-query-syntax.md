# Agent Note: Session search query syntax and ranking

Status: implemented

English | [中文](2026-11-28-session-search-query-syntax.zh.md)

## Problem

A full-text query used to match one consecutive phrase, so adding a second term often removed useful matches. Data accumulated in daily use shows that six multi-word queries such as `academic-source CLI` returned nothing while `academic` found matches. Five successive searches for `molbench AND timeout` returned nothing because `AND` was treated as a literal token. Across 296 successful searches on one installation, 85 returned no hits.

## Decision

The [SQLite provider](../../../../packages/session-query/session-query-sqlite/README.md#search-behavior) parses its own query language and emits parenthesized FTS5 expressions with quoted terms. Space and uppercase `AND` require all terms in one event; uppercase `OR` binds more tightly. Double quotes require contiguous tokens; parentheses group expressions; an attached leading `-` excludes; and a trailing `*` on a bare term matches a prefix. Other punctuation is literal query data and `unicode61` tokenizes it in both documents and query terms. Items without tokens are ignored.

Unmatched quotes or parentheses, missing `OR` operands, and an AND group or OR branch without a positive term are invalid. A query with only exclusions returns `SESSION_QUERY_EXCLUSION_ONLY`: the Web session list retries the complete text as one literal phrase. A query with no searchable tokens returns `SESSION_QUERY_INVALID_QUERY`.

`searchEvents` returns individual matches across the corpus or in an explicit set of sessions. It supplies the session header with each hit; exact-id requests can refresh their selected sessions without waiting for the whole corpus to warm up, under the [bounded warmup decision](../bug-fix/2026-11-24-bounded-search-warmup-wait.md).

### Ranking

A single phrase keeps the existing ordering. For a compound query, the complete expression and metadata filters select candidates in each index. One scoring `MATCH` cursor per positive phrase and source traverses the posting list; a `CROSS JOIN` checks each matching rowid against the candidate set before calling `bm25`. Each phrase uses the historical IDF and average document length for both sources. Live native scores yield the term frequency for that recalculation. Scores from distinct positive phrases add; missing OR terms and exclusions add zero. Highlighting uses the complete expression.

## Alternatives considered

**Use native scores from each source.** The indexes have different IDF values and average lengths. Equal documents can receive different scores just because one is still live, skewing the rankings when the two indexes are merged.

**Run an FTS MATCH for each candidate rowid.** Constraining `rowid = ?` does not make a common phrase cheap to reopen. The repeated scoring work grows nearly quadratically; walking the phrase once and looking up candidate rowids keeps the same scores.

**Treat spaces as OR.** Queries with several narrowing terms would return events with only one common term, adding noise to the model's bounded results.

## Consequences

Users can broaden or narrow their search without guessing token order. Every AND still applies to a single indexed event, not all events of a session. The [cross-source ranking test](../../../../packages/session-query/session-query-sqlite/tests/store-ranking.spec.ts) requires equal scores for identical persisted and live bodies even when their source statistics differ.
