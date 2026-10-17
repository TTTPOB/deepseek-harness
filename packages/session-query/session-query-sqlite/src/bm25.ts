/** Single-phrase BM25 statistics from public FTS5 functions and a connection-local token probe. */
import type { DatabaseSync } from 'node:sqlite'
import { quoteFtsData } from './query.ts'

/** One phrase's native scores at two text-column weights. */
interface WeightedScores { s1: number; s2: number }

/** Recover the phrase IDF, including FTS5's positive floor. */
function phraseIdf(scores: WeightedScores): number {
  return 1 / (2.2 * (2 / -scores.s2 - 1 / -scores.s1))
}

/** Connection-owned calibration; invalidated after each successful historical transaction. */
export class SharedBm25 {
  private average: number | null | undefined

  /** @param db - The query service's serialized connection, with its TEMP schema initialized. */
  constructor(private readonly db: DatabaseSync) {}

  /** Discard calibration after a historical commit, including partial reconciliation progress. */
  invalidate(): void { this.average = undefined }

  /**
   * Tokenize only a changed live body; the count uses the same unicode61 tokenizer as both indexes.
   * @param text - Sanitized indexed body.
   * @returns Indexed token count, not character length.
   */
  tokenCount(text: string): number {
    this.probe(text)
    return (this.db.prepare('SELECT count(*) n FROM temp.token_vocab').get() as { n: number }).n
  }

  /**
   * Shared scoring parameters for one literal phrase. No historical match uses IDF=1;
   * no historical tokens uses the live average, with IDF=1 for every live candidate.
   * @param query - Normalized literal phrase.
   * @returns Live average, shared average, shared IDF and live IDF, in SQL binding order.
   */
  parameters(query: string): number[] {
    const historyAverage = this.historyAverage()
    const live = this.db.prepare('SELECT avg(token_count) average FROM temp.live_token_lengths').get() as {
      average: number | null
    }
    const liveAverage = live.average || 1
    const expression = quoteFtsData(query)
    const historical = historyAverage === null ? undefined : this.scores('persisted_docs', expression)
    const current = this.scores('live_docs', expression)
    return [liveAverage, historyAverage ?? liveAverage,
      historical === undefined ? 1 : phraseIdf(historical), current === undefined ? 1 : phraseIdf(current)]
  }

  /**
   * Whether scoring depends on the live corpus average rather than historical background.
   * @returns True when historical documents contain no indexed tokens.
   */
  usesLiveBackground(): boolean { return this.historyAverage() === null }

  private probe(text: string): void {
    this.db.exec('DELETE FROM temp.token_probe')
    this.db.prepare('INSERT INTO temp.token_probe(rowid,text) VALUES(1,?)').run(text)
  }

  private scores(table: 'persisted_docs' | 'live_docs', expression: string): WeightedScores | undefined {
    return this.db.prepare(`SELECT bm25(${table}) s1,bm25(${table},2.0) s2
      FROM ${table} WHERE ${table} MATCH ? LIMIT 1`).get(expression) as WeightedScores | undefined
  }

  private historyAverage(): number | null {
    if (this.average !== undefined) return this.average
    // Calibration needs one token-bearing body, not a scan of the historical vocabulary.
    for (const row of this.db.prepare('SELECT rowid,text FROM persisted_docs').iterate()) {
      const { rowid, text } = row as { rowid: number; text: string }
      this.probe(text)
      const token = this.db.prepare('SELECT term,count(*) tf FROM temp.token_vocab GROUP BY term LIMIT 1').get() as
        { term: string; tf: number } | undefined
      if (token === undefined) continue
      const dl = (this.db.prepare('SELECT count(*) n FROM temp.token_vocab').get() as { n: number }).n
      // BigInt is required for an INTEGER FTS rowid constraint alongside MATCH.
      const scores = this.db.prepare(`SELECT bm25(persisted_docs) s1,bm25(persisted_docs,2.0) s2
        FROM persisted_docs WHERE persisted_docs MATCH ? AND rowid=?`).get(
        quoteFtsData(token.term), BigInt(rowid),
      ) as WeightedScores | undefined
      if (scores === undefined) throw new Error('FTS5 calibration term did not match its source document')
      const ratio = scores.s2 / scores.s1
      const k = 2 * token.tf * (ratio - 1) / (2 - ratio)
      const average = 0.9 * dl / (k - 0.3)
      if (!Number.isFinite(average) || average <= 0) throw new Error('FTS5 historical BM25 calibration failed')
      this.average = average
      return average
    }
    this.average = null
    return null
  }
}
