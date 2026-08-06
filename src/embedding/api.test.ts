import { describe, expect, test } from "bun:test"
import { ApiEmbeddingProvider } from "./api.js"

describe("ApiEmbeddingProvider", () => {
  test("preserves the API base path and restores response index order", async () => {
    let requestedUrl = ""
    const provider = new ApiEmbeddingProvider({
      apiUrl: "https://openrouter.ai/api/v1/",
      apiKey: "key",
      model: "model",
      dimensions: 2,
      provider: "openrouter",
      sendDimensions: true,
      fetchFn: async (url, init) => {
        requestedUrl = String(url)
        expect(JSON.parse(String(init?.body)).dimensions).toBe(2)
        return new Response(
          JSON.stringify({
            data: [
              { index: 1, embedding: [0.3, 0.4] },
              { index: 0, embedding: [0.1, 0.2] },
            ],
          }),
          { status: 200 },
        )
      },
    })

    expect(await provider.embed(["first", "second"])).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ])
    expect(requestedUrl).toBe("https://openrouter.ai/api/v1/embeddings")
  })

  test("omits dimensions for fixed-size models", async () => {
    const provider = new ApiEmbeddingProvider({
      apiUrl: "https://example.com/v1",
      apiKey: "key",
      model: "model",
      dimensions: 2,
      provider: "api",
      sendDimensions: false,
      fetchFn: async (_url, init) => {
        expect(JSON.parse(String(init?.body))).not.toHaveProperty("dimensions")
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
          status: 200,
        })
      },
    })
    expect(await provider.embed(["text"])).toHaveLength(1)
  })

  test("includes API error body and splits oversized 400 batches", async () => {
    let calls = 0
    const provider = new ApiEmbeddingProvider({
      apiUrl: "https://example.com/v1",
      apiKey: "key",
      model: "model",
      dimensions: 2,
      provider: "openrouter",
      sendDimensions: false,
      scheduler: { batchSize: 2 },
      fetchFn: async (_url, init) => {
        calls += 1
        const body = JSON.parse(String(init?.body)) as { input: string | string[] }
        const count = Array.isArray(body.input) ? body.input.length : 1
        if (count > 1) {
          return new Response(JSON.stringify({ error: { message: "too many inputs" } }), {
            status: 400,
          })
        }
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
          status: 200,
        })
      },
    })

    expect(await provider.embed(["one", "two"])).toEqual([
      [0.1, 0.2],
      [0.1, 0.2],
    ])
    expect(calls).toBeGreaterThan(2)
  })

  test("rejects wrong-size or non-finite vectors", async () => {
    const provider = new ApiEmbeddingProvider({
      apiUrl: "https://example.com/v1",
      apiKey: "key",
      model: "model",
      dimensions: 2,
      provider: "api",
      sendDimensions: true,
      fetchFn: async () =>
        new Response(JSON.stringify({ data: [{ embedding: [Number.NaN] }] }), { status: 200 }),
    })
    await expect(provider.embed(["text"])).rejects.toThrow("invalid vector")
  })

  test("retries HTTP 429 using Retry-After", async () => {
    let calls = 0
    const provider = new ApiEmbeddingProvider({
      apiUrl: "https://example.com/v1",
      apiKey: "key",
      model: "model",
      dimensions: 2,
      provider: "api",
      sendDimensions: true,
      fetchFn: async () => {
        calls += 1
        if (calls === 1) {
          return new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } })
        }
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
          status: 200,
        })
      },
    })
    await provider.embed(["text"])
    expect(calls).toBe(2)
  })

  test("ramps API concurrency while preserving input order", async () => {
    let active = 0
    let peak = 0
    const provider = new ApiEmbeddingProvider({
      apiUrl: "https://example.com/v1",
      apiKey: "key",
      model: "paid-model",
      dimensions: 2,
      provider: "openrouter",
      sendDimensions: false,
      scheduler: { batchSize: 1, initialConcurrency: 1, maxConcurrency: 3 },
      fetchFn: async (_url, init) => {
        active += 1
        peak = Math.max(peak, active)
        const input = JSON.parse(String(init?.body)).input[0] as string
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        return new Response(
          JSON.stringify({ data: [{ embedding: [Number(input), Number(input) + 0.5] }] }),
          { status: 200 },
        )
      },
    })

    expect(await provider.embed(["1", "2", "3", "4", "5", "6"])).toEqual([
      [1, 1.5],
      [2, 2.5],
      [3, 3.5],
      [4, 4.5],
      [5, 5.5],
      [6, 6.5],
    ])
    expect(peak).toBe(3)
  })

  test("paces free OpenRouter requests", async () => {
    const starts: number[] = []
    const provider = new ApiEmbeddingProvider({
      apiUrl: "https://openrouter.ai/api/v1",
      apiKey: "key",
      model: "free-model:free",
      dimensions: 2,
      provider: "openrouter",
      sendDimensions: false,
      scheduler: { batchSize: 1, requestIntervalMs: 20 },
      fetchFn: async () => {
        starts.push(Date.now())
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
          status: 200,
        })
      },
    })

    await provider.embed(["one", "two", "three"])
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(15)
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(15)
  })

  test("halves concurrency when OpenRouter returns 429", async () => {
    let calls = 0
    let releaseRetries: (() => void) | undefined
    const retriesBlocked = new Promise<void>((resolve) => {
      releaseRetries = resolve
    })
    const provider = new ApiEmbeddingProvider({
      apiUrl: "https://openrouter.ai/api/v1",
      apiKey: "key",
      model: "paid-model",
      dimensions: 2,
      provider: "openrouter",
      sendDimensions: false,
      scheduler: { batchSize: 1, initialConcurrency: 2, maxConcurrency: 4 },
      fetchFn: async () => {
        calls += 1
        if (calls <= 2) {
          return new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } })
        }
        await retriesBlocked
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
          status: 200,
        })
      },
    })

    const embedding = provider.embed(["one", "two", "three"])
    for (let attempt = 0; attempt < 50 && calls < 4; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    const scheduler = provider as unknown as { currentConcurrency: number }
    expect(calls).toBe(4)
    expect(scheduler.currentConcurrency).toBe(1)
    releaseRetries?.()
    await embedding
  })

  test("prioritizes a search embedding over queued indexing batches", async () => {
    const requestOrder: string[] = []
    let releaseFirst: (() => void) | undefined
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const provider = new ApiEmbeddingProvider({
      apiUrl: "https://openrouter.ai/api/v1",
      apiKey: "key",
      model: "paid-model",
      dimensions: 2,
      provider: "openrouter",
      sendDimensions: false,
      scheduler: { batchSize: 1, initialConcurrency: 1, maxConcurrency: 1 },
      fetchFn: async (_url, init) => {
        const input = JSON.parse(String(init?.body)).input[0] as string
        requestOrder.push(input)
        if (input === "index-1") await firstBlocked
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
          status: 200,
        })
      },
    })

    const indexing = provider.embed(["index-1", "index-2", "index-3"])
    await new Promise((resolve) => setTimeout(resolve, 5))
    const search = provider.embed(["search"])
    releaseFirst?.()
    await Promise.all([indexing, search])

    expect(requestOrder).toEqual(["index-1", "search", "index-2", "index-3"])
  })
})
