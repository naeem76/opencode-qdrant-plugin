/**
 * Generic async retry with exponential backoff.
 *
 * Network operations (Qdrant REST, embedding API) can fail transiently
 * with 429/5xx, ECONNRESET, ETIMEDOUT, or fetch throws. This helper
 * retries a callable up to `maxRetries` times, asking the caller via
 * `shouldRetry(err, attempt)` whether the failure is worth retrying.
 */
const DEFAULTS = { maxRetries: 3, baseDelayMs: 200 };
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export async function retryAsync(fn, shouldRetry, opts) {
    const { maxRetries, baseDelayMs } = { ...DEFAULTS, ...opts };
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
            return await fn();
        }
        catch (err) {
            lastErr = err;
            if (attempt === maxRetries || !shouldRetry(err, attempt))
                break;
            await sleep(baseDelayMs * 2 ** attempt);
        }
    }
    throw lastErr;
}
/**
 * Predicate: is this error a transient HTTP/network failure worth retrying?
 *
 * - HTTP 429 (rate limit) and 5xx (server errors)
 * - Network-layer throws (TypeError from fetch, ECONNRESET, ETIMEDOUT, etc.)
 */
export function isTransientNetworkError(err) {
    if (err instanceof Error) {
        const code = err.code;
        if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND" || code === "EAI_AGAIN") {
            return true;
        }
        // fetch() throws TypeError for network failures
        if (err.name === "TypeError")
            return true;
    }
    return false;
}
/**
 * Predicate builder for HTTP responses. Use together with a sentinel that
 * the caller throws when the response status is retryable.
 */
export class HttpRetryableError extends Error {
    status;
    constructor(status) {
        super(`HTTP ${status}`);
        this.status = status;
        this.name = "HttpRetryableError";
    }
}
export function isRetryableHttpStatus(status) {
    return status === 429 || (status >= 500 && status <= 599);
}
