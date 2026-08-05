/**
 * Tests for the retry helper and transient-error predicates.
 *
 * Run with: `bun test src/retry.test.ts`
 */

import { describe, expect, test } from "bun:test"
import {
  HttpRetryableError,
  isRetryableHttpStatus,
  isTransientNetworkError,
  retryAsync,
} from "./retry.js"

describe("isRetryableHttpStatus", () => {
  test("retries 429", () => {
    expect(isRetryableHttpStatus(429)).toBe(true)
  })

  test("retries all 5xx", () => {
    expect(isRetryableHttpStatus(500)).toBe(true)
    expect(isRetryableHttpStatus(502)).toBe(true)
    expect(isRetryableHttpStatus(503)).toBe(true)
    expect(isRetryableHttpStatus(599)).toBe(true)
  })

  test("does not retry 4xx (except 429)", () => {
    expect(isRetryableHttpStatus(400)).toBe(false)
    expect(isRetryableHttpStatus(401)).toBe(false)
    expect(isRetryableHttpStatus(403)).toBe(false)
    expect(isRetryableHttpStatus(404)).toBe(false)
    expect(isRetryableHttpStatus(422)).toBe(false)
  })

  test("does not retry 2xx / 3xx", () => {
    expect(isRetryableHttpStatus(200)).toBe(false)
    expect(isRetryableHttpStatus(301)).toBe(false)
  })
})

describe("isTransientNetworkError", () => {
  test("retries ECONNRESET / ETIMEDOUT / ENOTFOUND / EAI_AGAIN", () => {
    expect(isTransientNetworkError(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe(true)
    expect(isTransientNetworkError(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))).toBe(true)
    expect(isTransientNetworkError(Object.assign(new Error("dns"), { code: "ENOTFOUND" }))).toBe(true)
    expect(isTransientNetworkError(Object.assign(new Error("dns retry"), { code: "EAI_AGAIN" }))).toBe(true)
  })

  test("retries fetch TypeError (network failure)", () => {
    const err = new TypeError("fetch failed")
    expect(isTransientNetworkError(err)).toBe(true)
  })

  test("does not retry generic errors", () => {
    expect(isTransientNetworkError(new Error("boom"))).toBe(false)
    expect(isTransientNetworkError("string")).toBe(false)
    expect(isTransientNetworkError(null)).toBe(false)
  })

  test("does not retry other errno codes", () => {
    expect(isTransientNetworkError(Object.assign(new Error("busy"), { code: "EBUSY" }))).toBe(false)
  })
})

describe("retryAsync", () => {
  test("returns the result on first success without retrying", async () => {
    let calls = 0
    const result = await retryAsync(
      async () => {
        calls += 1
        return "ok"
      },
      () => false,
    )
    expect(result).toBe("ok")
    expect(calls).toBe(1)
  })

  test("retries while shouldRetry returns true, then succeeds", async () => {
    let calls = 0
    const result = await retryAsync(
      async () => {
        calls += 1
        if (calls < 3) throw new Error("transient")
        return "ok"
      },
      () => true,
      { maxRetries: 5, baseDelayMs: 1 },
    )
    expect(result).toBe("ok")
    expect(calls).toBe(3)
  })

  test("throws after exhausting retries", async () => {
    let calls = 0
    await expect(
      retryAsync(
        async () => {
          calls += 1
          throw new Error("nope")
        },
        () => true,
        { maxRetries: 2, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("nope")
    expect(calls).toBe(3) // initial + 2 retries
  })

  test("stops retrying when shouldRetry returns false", async () => {
    let calls = 0
    await expect(
      retryAsync(
        async () => {
          calls += 1
          throw new Error("permanent")
        },
        () => false,
        { maxRetries: 5, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("permanent")
    expect(calls).toBe(1)
  })

  test("does not retry non-transient errors via HttpRetryableError + isTransientNetworkError predicate", async () => {
    let calls = 0
    await expect(
      retryAsync(
        async () => {
          calls += 1
          throw new Error("HTTP 400")
        },
        (err) => err instanceof HttpRetryableError || isTransientNetworkError(err),
        { maxRetries: 5, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("HTTP 400")
    expect(calls).toBe(1)
  })

  test("retries HttpRetryableError", async () => {
    let calls = 0
    const result = await retryAsync(
      async () => {
        calls += 1
        if (calls < 2) throw new HttpRetryableError(503)
        return "ok"
      },
      (err) => err instanceof HttpRetryableError,
      { maxRetries: 5, baseDelayMs: 1 },
    )
    expect(result).toBe("ok")
    expect(calls).toBe(2)
  })

  test("respects maxRetries=0 (no retries)", async () => {
    let calls = 0
    await expect(
      retryAsync(
        async () => {
          calls += 1
          throw new Error("x")
        },
        () => true,
        { maxRetries: 0, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("x")
    expect(calls).toBe(1)
  })
})

describe("HttpRetryableError", () => {
  test("carries the status code", () => {
    const err = new HttpRetryableError(503)
    expect(err.status).toBe(503)
    expect(err.message).toBe("HTTP 503")
    expect(err.name).toBe("HttpRetryableError")
    expect(err).toBeInstanceOf(Error)
  })
})