import type { EmbeddingProvider } from "../types.js"
import {
  HttpRetryableError,
  isRetryableHttpStatus,
  isTransientNetworkError,
  retryAsync,
} from "../retry.js"

type ApiEmbeddingOptions = {
  apiUrl: string
  apiKey: string
  model: string
  dimensions: number
  provider: "api" | "openrouter"
  sendDimensions: boolean
  headers?: Record<string, string>
  extraBody?: Record<string, unknown>
  fetchFn?: typeof fetch
  scheduler?: {
    batchSize?: number
    initialConcurrency?: number
    maxConcurrency?: number
    requestIntervalMs?: number
  }
}

/** Max texts per embedding request — keeps requests under provider token limits. */
const API_BATCH_SIZE = 32
const OPENROUTER_BATCH_SIZE = 16
const OPENROUTER_FREE_REQUEST_INTERVAL_MS = 3000
/** Soft char cap per input; oversized chunks are truncated to avoid provider 400s. */
const MAX_INPUT_CHARS = 8_000

type RequestJob = {
  texts: string[]
  group: RequestGroup
  resolve: (vectors: number[][]) => void
  reject: (error: unknown) => void
}

type RequestGroup = { cancelled: boolean }

export class ApiEmbeddingProvider implements EmbeddingProvider {
  readonly name: string
  readonly dimensions: number

  private readonly batchSize: number
  private readonly maxConcurrency: number
  private readonly requestIntervalMs: number
  private currentConcurrency: number
  private successfulRequests = 0
  private activeRequests = 0
  private blockedUntil = 0
  private nextRequestAt = 0
  private pumpTimer: ReturnType<typeof setTimeout> | null = null
  private readonly queue: RequestJob[] = []

  constructor(private readonly options: ApiEmbeddingOptions) {
    this.name = `${options.provider}:${options.model}`
    this.dimensions = options.dimensions
    const isOpenRouterFree =
      options.provider === "openrouter" && options.model.endsWith(":free")
    this.batchSize = Math.max(
      1,
      options.scheduler?.batchSize ??
        (options.provider === "openrouter" ? OPENROUTER_BATCH_SIZE : API_BATCH_SIZE),
    )
    this.maxConcurrency = Math.max(
      1,
      options.scheduler?.maxConcurrency ??
        (isOpenRouterFree ? 1 : options.provider === "openrouter" ? 8 : 4),
    )
    this.currentConcurrency = Math.min(
      this.maxConcurrency,
      Math.max(1, options.scheduler?.initialConcurrency ?? (isOpenRouterFree ? 1 : 2)),
    )
    this.requestIntervalMs = Math.max(
      0,
      options.scheduler?.requestIntervalMs ??
        (isOpenRouterFree ? OPENROUTER_FREE_REQUEST_INTERVAL_MS : 0),
    )
  }

  async embed(texts: string[]) {
    if (texts.length === 0) {
      return []
    }

    const sanitized = texts.map((text) => sanitizeEmbeddingInput(text))
    const group: RequestGroup = { cancelled: false }
    const requests: Array<Promise<number[][]>> = []
    const prioritized = sanitized.length === 1
    for (let index = 0; index < sanitized.length; index += this.batchSize) {
      requests.push(
        this.enqueue(sanitized.slice(index, index + this.batchSize), group, prioritized),
      )
    }
    let vectors: number[][]
    try {
      vectors = (await Promise.all(requests)).flat()
    } catch (error) {
      group.cancelled = true
      for (let index = this.queue.length - 1; index >= 0; index -= 1) {
        const job = this.queue[index]
        if (job.group !== group) continue
        this.queue.splice(index, 1)
        job.reject(error)
      }
      throw error
    }

    if (vectors.length !== texts.length) {
      throw new Error("Embedding API returned an unexpected number of vectors")
    }
    return vectors
  }

  private enqueue(
    texts: string[],
    group: RequestGroup,
    prioritized: boolean,
  ): Promise<number[][]> {
    const promise = new Promise<number[][]>((resolve, reject) => {
      const job = { texts, group, resolve, reject }
      if (prioritized) this.queue.unshift(job)
      else this.queue.push(job)
    })
    this.pump()
    return promise
  }

  private pump(): void {
    if (this.pumpTimer || this.queue.length === 0) return
    const now = Date.now()
    const waitUntil = Math.max(this.blockedUntil, this.nextRequestAt)
    if (waitUntil > now) {
      this.pumpTimer = setTimeout(() => {
        this.pumpTimer = null
        this.pump()
      }, waitUntil - now)
      return
    }

    while (this.activeRequests < this.currentConcurrency && this.queue.length > 0) {
      const job = this.queue.shift()
      if (!job) break
      if (job.group.cancelled) continue
      this.activeRequests += 1
      if (this.requestIntervalMs > 0) {
        this.nextRequestAt = Date.now() + this.requestIntervalMs
      }
      void this.requestBatch(job.texts)
        .then((vectors) => {
          this.recordSuccess()
          job.resolve(vectors)
        })
        .catch(job.reject)
        .finally(() => {
          this.activeRequests -= 1
          this.pump()
        })

      if (this.requestIntervalMs > 0) break
    }
  }

  private async requestBatch(batch: string[]): Promise<number[][]> {
    try {
      return await this.requestBatchOnce(batch)
    } catch (error) {
      // Oversized/invalid multi-input batches often return 400; split and retry.
      if (
        batch.length > 1 &&
        error instanceof Error &&
        /\b400\b/.test(error.message)
      ) {
        const mid = Math.ceil(batch.length / 2)
        const left = await this.requestBatch(batch.slice(0, mid))
        const right = await this.requestBatch(batch.slice(mid))
        return [...left, ...right]
      }
      throw error
    }
  }

  private async requestBatchOnce(batch: string[]): Promise<number[][]> {
    return retryAsync(
      async () => {
        const endpoint = `${this.options.apiUrl.replace(/\/+$/, "")}/embeddings`
        const response = await (this.options.fetchFn ?? fetch)(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            "Content-Type": "application/json",
            ...this.options.headers,
          },
          body: JSON.stringify({
            model: this.options.model,
            input: batch.length === 1 ? batch[0] : batch,
            ...(this.options.sendDimensions ? { dimensions: this.options.dimensions } : {}),
            ...this.options.extraBody,
          }),
        })

        if (!response.ok) {
          const body = (await response.text()).slice(0, 500)
          if (isRetryableHttpStatus(response.status)) {
            const retryAfterMs = this.retryDelay(response)
            if (response.status === 429) this.recordThrottle(retryAfterMs)
            throw new HttpRetryableError(response.status, retryAfterMs)
          }
          throw new Error(
            `Embedding API failed with ${response.status}${body ? `: ${body}` : ""}`,
          )
        }

        const json = (await response.json()) as {
          data?: Array<{ embedding: number[]; index?: number }>
        }
        const data = json.data ?? []
        const result = new Array<number[]>(data.length)
        for (let index = 0; index < data.length; index += 1) {
          result[data[index].index ?? index] = data[index].embedding
        }
        if (result.length !== batch.length) {
          throw new Error("Embedding API returned an unexpected number of vectors")
        }
        for (const vector of result) {
          if (
            !Array.isArray(vector) ||
            vector.length !== this.options.dimensions ||
            vector.some((value) => !Number.isFinite(value))
          ) {
            throw new Error(
              `Embedding API returned an invalid vector (expected ${this.options.dimensions} finite dimensions)`,
            )
          }
        }
        return result
      },
      (err) => err instanceof HttpRetryableError || isTransientNetworkError(err),
    )
  }

  private recordSuccess(): void {
    this.successfulRequests += 1
    if (
      this.currentConcurrency < this.maxConcurrency &&
      this.successfulRequests >= this.currentConcurrency
    ) {
      this.currentConcurrency += 1
      this.successfulRequests = 0
    }
  }

  private recordThrottle(retryAfterMs: number | undefined): void {
    this.currentConcurrency = Math.max(1, Math.floor(this.currentConcurrency / 2))
    this.successfulRequests = 0
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + (retryAfterMs ?? 1000))
  }

  private retryDelay(response: Response): number | undefined {
    const retryAfter = response.headers.get("retry-after")
    if (retryAfter) {
      const seconds = Number(retryAfter)
      if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
      const date = Date.parse(retryAfter)
      if (Number.isFinite(date)) return Math.max(0, date - Date.now())
    }

    const reset = Number(response.headers.get("x-ratelimit-reset"))
    if (Number.isFinite(reset) && reset > 0) {
      const resetMs = reset < 1_000_000_000_000 ? reset * 1000 : reset
      return Math.max(0, resetMs - Date.now())
    }
    return response.status === 429 ? 1000 : undefined
  }
}

export function sanitizeEmbeddingInput(text: string): string {
  const normalized = text.replace(/\u0000/g, " ").trim()
  if (!normalized) return "."
  if (normalized.length <= MAX_INPUT_CHARS) return normalized
  return normalized.slice(0, MAX_INPUT_CHARS)
}
