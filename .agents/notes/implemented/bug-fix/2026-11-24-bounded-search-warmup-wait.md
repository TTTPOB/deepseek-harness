# Agent Note: Bounded wait for search warmup

Status: implemented

English | [中文](2026-11-24-bounded-search-warmup-wait.zh.md)

## Problem

The SQLite provider warms its index in a background worker. Until warmup finished, cross-session search returned `SESSION_QUERY_INDEX_WARMING` immediately. A 14-day audit of one installation found 14 such failures in three sessions; in one burst, seven different queries were rejected almost at once. The error is retryable, but a model reads it as a failed search, and session tools that deliberately do not retry provider requests pass it straight through.

## Decision

`searchSessions` waits at most [`warmupWaitMs`](../../../../packages/session-query/session-query-sqlite/README.md) milliseconds for the warmup already in progress; the default is 3000, and `0` returns immediately. The wait observes the service-owned warmup and never starts another scan. If warmup completes within the wait, the search proceeds; if warmup fails, the search reports that failure; if the wait expires, the search fails with `SESSION_QUERY_INDEX_WARMING`. Aborting a request ends only that request's wait. With `openAt: first-search`, the first search starts warmup and then waits the same way. `searchEvents` uses the same wait without exact-id filters; with exact ids, it refreshes just those sessions once document keys are ready ([event search](../architecture/2026-11-28-session-search-query-syntax.md)). The setting accepts integers from 0 to 2,147,483,647, the longest delay that `setTimeout` accepts.

## Alternatives considered

**Block until warmup completes.** Upstream DeepSeek Harness opens and reconciles the whole index before the first search returns. On a 1,000-session corpus that first search takes about 144 seconds ([corpus baselines](../testing/2026-09-28-session-corpus-performance.md)), far beyond the 30-second default timeout of the experimental search tools.

**Retry in each consumer.** Every consumer would need its own retry loop and budget, session tools that forbid provider retries would have to drop that rule, and models retry without backoff.

**A long default wait.** A wait close to a tool's timeout would hold PTC programs and parallel calls behind one slow warmup. The 3-second default bounds the added latency; it is not derived from measured warmup durations, which depend on corpus size.

## Consequences

During warmup a cross-session search can take up to `warmupWaitMs` longer before it succeeds or fails. A search that arrives shortly before warmup finishes succeeds instead of failing. A long warmup still produces `SESSION_QUERY_INDEX_WARMING` after the wait. Deployments that prefer an immediate answer set `warmupWaitMs` to `0`.
