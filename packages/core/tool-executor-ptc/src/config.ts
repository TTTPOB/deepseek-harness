/** Configuration shared by plugin mounting and direct executor construction. @module */
import z from '@deepseek-ai/schemastery'

/** Program execution limits and model-direct exceptions. */
export interface Config {
  /** Maximum overlapping concurrency-safe program subcalls. */
  maxParallelSubCalls: number
  /**
   * Exact tool names the model may also call directly. A name is offered only
   * when the step's visible definitions include it; it stays in the SDK.
   */
  ptcNativeTools: string[]
}

/** Validated program subcall concurrency and native exception names. */
export const Config: z<Partial<Config>, Config> = z.object({
  maxParallelSubCalls: z.natural().min(1).default(10),
  ptcNativeTools: z.array(z.string().min(1)).default([]),
})
