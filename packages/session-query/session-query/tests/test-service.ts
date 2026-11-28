import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import type {
  SessionEventSearchPage,
  SessionEventSearchRequest,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'

/** Test-only concrete query service for backend-independent behavior. */
export class TestSessionQueryEngine extends SessionQueryEngine {
  override searchSessions(
    _request: SessionSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    return Promise.resolve({ items: [] })
  }

  override searchEvents(
    _request: SessionEventSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    return Promise.resolve({ items: [] })
  }
}
