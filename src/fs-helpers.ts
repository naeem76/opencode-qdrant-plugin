/**
 * File-system helpers for Windows EBUSY resilience.
 *
 * Two strategies combined:
 * 1. **Atomic writes** — write to a `.tmp` sibling then `rename()` over the
 *    target.  On Windows (NTFS) `rename` within the same directory is atomic
 *    and doesn't conflict with concurrent readers.
 * 2. **Retry-with-backoff** — transient EBUSY / EPERM locks (antivirus,
 *    editor auto-save, etc.) are retried up to `maxRetries` times with
 *    exponential backoff.
 */

import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RETRYABLE_CODES = new Set(["EBUSY", "EPERM", "EACCES"])

function isRetryable(err: unknown): boolean {
  return err instanceof Error && RETRYABLE_CODES.has((err as NodeJS.ErrnoException).code ?? "")
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Async — retry wrapper
// ---------------------------------------------------------------------------

interface RetryOptions {
  maxRetries?: number
  baseDelayMs?: number
}

const DEFAULTS: Required<RetryOptions> = { maxRetries: 3, baseDelayMs: 50 }

async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
  const { maxRetries, baseDelayMs } = { ...DEFAULTS, ...opts }
  let lastErr: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isRetryable(err) || attempt === maxRetries) break
      await sleep(baseDelayMs * 2 ** attempt)
    }
  }
  throw lastErr
}

// ---------------------------------------------------------------------------
// Sync — retry wrapper
// ---------------------------------------------------------------------------

function withRetrySync<T>(fn: () => T, opts?: RetryOptions): T {
  const { maxRetries, baseDelayMs } = { ...DEFAULTS, ...opts }
  let lastErr: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return fn()
    } catch (err) {
      lastErr = err
      if (!isRetryable(err) || attempt === maxRetries) break
      // Busy-wait is acceptable here — TUI uses sync I/O on purpose and
      // the delays are tiny (50-200 ms total worst-case).
      const end = Date.now() + baseDelayMs * 2 ** attempt
      while (Date.now() < end) {
        /* spin */
      }
    }
  }
  throw lastErr
}

// ---------------------------------------------------------------------------
// Atomic write (async)
// ---------------------------------------------------------------------------

/**
 * Write `content` to `filePath` atomically by first writing to a temporary
 * file in the same directory, then renaming over the target.
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmpPath = filePath + ".tmp"
  await withRetry(async () => {
    await fs.writeFile(tmpPath, content, "utf8")
  })
  await withRetry(async () => {
    await fs.rename(tmpPath, filePath)
  })
}

// ---------------------------------------------------------------------------
// Atomic write (sync — for TUI)
// ---------------------------------------------------------------------------

/**
 * Sync version of {@link atomicWriteFile} for the TUI side, which must use
 * synchronous I/O.
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  const tmpPath = filePath + ".tmp"
  withRetrySync(() => {
    fsSync.writeFileSync(tmpPath, content, "utf8")
  })
  withRetrySync(() => {
    fsSync.renameSync(tmpPath, filePath)
  })
}

// ---------------------------------------------------------------------------
// Retry read (async)
// ---------------------------------------------------------------------------

/**
 * Read a UTF-8 file, retrying on transient Windows file-lock errors.
 */
export async function retryRead(filePath: string, opts?: RetryOptions): Promise<string> {
  return withRetry(() => fs.readFile(filePath, "utf8"), opts)
}

// ---------------------------------------------------------------------------
// Retry read (sync — for TUI)
// ---------------------------------------------------------------------------

/**
 * Sync version of {@link retryRead}.
 */
export function retryReadSync(filePath: string, opts?: RetryOptions): string {
  return withRetrySync(() => fsSync.readFileSync(filePath, "utf8"), opts)
}

// ---------------------------------------------------------------------------
// Retry unlink (async)
// ---------------------------------------------------------------------------

/**
 * Delete a file, retrying on transient Windows file-lock errors.
 */
export async function retryUnlink(filePath: string, opts?: RetryOptions): Promise<void> {
  return withRetry(() => fs.unlink(filePath), opts)
}

// ---------------------------------------------------------------------------
// Retry open (async) — for discovery's looksBinary
// ---------------------------------------------------------------------------

/**
 * Open a file handle, retrying on transient Windows file-lock errors.
 */
export async function retryOpen(
  filePath: string,
  flags: string,
  opts?: RetryOptions,
): Promise<fs.FileHandle> {
  return withRetry(() => fs.open(filePath, flags), opts)
}
