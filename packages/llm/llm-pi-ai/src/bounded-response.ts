/** Bounded response-body reading shared by model discovery and catalog refresh. */

/** Default maximum response size for remote model metadata. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** Signals that a response exceeded the byte ceiling while it was read. */
export class ResponseTooLargeError extends Error {
  /**
   * @param maxBytes - maximum number of response bytes allowed.
   */
  constructor(maxBytes: number) {
    super(`response exceeded ${maxBytes} bytes`)
    this.name = 'ResponseTooLargeError'
  }
}

/**
 * Read a response body while enforcing the limit on bytes actually received.
 * @param response - response whose body should be consumed.
 * @param maxBytes - maximum body size in bytes.
 * @param signal - operation cancellation signal.
 * @returns the decoded UTF-8 body.
 */
export async function readBoundedResponse(
  response: Response,
  maxBytes = MAX_RESPONSE_BYTES,
  signal?: AbortSignal,
): Promise<string> {
  const oversized = (): ResponseTooLargeError => new ResponseTooLargeError(maxBytes)
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel()
    throw oversized()
  }
  signal?.throwIfAborted()
  /* v8 ignore next -- fetch always exposes a body stream on a 2xx Response; the null guard is defensive. */
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      signal?.throwIfAborted()
      const pending = reader.read()
      pending.catch(() => {})
      const { done, value } = signal === undefined
        ? await pending
        : await Promise.race([
          pending,
          new Promise<never>((_, reject) => {
            const abort = (): void => {
              reject(new Error('operation aborted'))
            }
            signal.addEventListener('abort', abort, { once: true })
            pending.finally(() => { signal.removeEventListener('abort', abort) }).catch(() => {})
            if (signal.aborted) abort()
          }),
        ])
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw oversized()
      chunks.push(value)
    }
  } finally {
    /* v8 ignore next 4 -- cancel() after a drained read or abort is best-effort cleanup. */
    await reader.cancel().catch(() => {
      // The response is already decided; cleanup cannot change the result.
    })
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}
