/**
 * Generic async retry with exponential backoff.
 *
 * Network operations (Qdrant REST, embedding API) can fail transiently
 * with 429/5xx, ECONNRESET, ETIMEDOUT, or fetch throws. This helper
 * retries a callable up to `maxRetries` times, asking the caller via
 * `shouldRetry(err, attempt)` whether the failure is worth retrying.
 */

interface RetryOptions {
  maxRetries?: number
  baseDelayMs?: number
}

const DEFAULTS: Required<RetryOptions> = { maxRetries: 3, baseDelayMs: 200 }

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export async function retryAsync<T>(
  fn: () => Promise<T>,
  shouldRetry: (err: unknown, attempt: number) => boolean,
  opts?: RetryOptions,
): Promise<T> {
  const { maxRetries, baseDelayMs } = { ...DEFAULTS, ...opts }
  let lastErr: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt === maxRetries || !shouldRetry(err, attempt)) break
      await sleep(baseDelayMs * 2 ** attempt)
    }
  }
  throw lastErr
}

/**
 * Predicate: is this error a transient HTTP/network failure worth retrying?
 *
 * - HTTP 429 (rate limit) and 5xx (server errors)
 * - Network-layer throws (TypeError from fetch, ECONNRESET, ETIMEDOUT, etc.)
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND" || code === "EAI_AGAIN") {
      return true
    }
    // fetch() throws TypeError for network failures
    if (err.name === "TypeError") return true
  }
  return false
}

/**
 * Predicate builder for HTTP responses. Use together with a sentinel that
 * the caller throws when the response status is retryable.
 */
export class HttpRetryableError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
    this.name = "HttpRetryableError"
  }
}

export function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599)
}