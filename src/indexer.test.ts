import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Indexer } from "./indexer.js"
import type { EmbeddingProvider, IndexedPoint, ResolvedConfig } from "./types.js"

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "qdrant-indexer-"))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const config = (concurrency: number): ResolvedConfig => ({
  qdrantUrl: "http://localhost:6333",
  embeddingProvider: "local",
  embeddingModel: "Xenova/all-MiniLM-L6-v2",
  embeddingApiKey: undefined,
  embeddingApiUrl: "https://api.openai.com/v1",
  embeddingDimensions: 384,
  maxFileSize: 100_000,
  chunkMaxLines: 80,
  chunkOverlapLines: 10,
  excludePatterns: [],
  includePatterns: undefined,
  searchLimit: 10,
  scoreThreshold: 0.3,
  collectionName: undefined,
  concurrency,
  indexOnStart: true,
  watchFiles: true,
  watchDebounceMs: 2000,
  localEmbeddingBatchSize: 16,
  localEmbeddingDtype: "q8",
  localWorkerCommand: "node",
})

async function writeFiles(count: number) {
  for (let index = 0; index < count; index += 1) {
    await fs.writeFile(path.join(root, `file-${index}.ts`), `export const value${index} = ${index}\n`)
  }
}

async function waitForCompletion(indexer: Indexer) {
  const deadline = Date.now() + 3000
  while (indexer.isRunning() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(indexer.isRunning()).toBe(false)
}

function mocks(existing = new Map<string, string>()) {
  const events: string[] = []
  let points = 0
  const qdrant = {
    collectionName: "test_collection",
    async deleteCollection() {
      points = 0
    },
    async ensureCollection() {},
    async getFileHashes() {
      return existing
    },
    async upsertPoints(items: IndexedPoint[]) {
      events.push("upsert")
      points += items.length
    },
    async deleteStaleFileVersion(filePath: string) {
      events.push(`delete:${filePath}`)
    },
    async deleteByFilePaths() {},
    async getCollectionInfo() {
      return { name: "test_collection", pointsCount: points, healthy: true }
    },
  }

  let embedCalls = 0
  const embeddings: EmbeddingProvider = {
    name: "test",
    dimensions: 2,
    async embed(texts) {
      embedCalls += 1
      return texts.map(() => [0.1, 0.2])
    },
  }

  return { qdrant, embeddings, events, getEmbedCalls: () => embedCalls }
}

describe("Indexer batching", () => {
  test("completes when fewer files than concurrency need embedding", async () => {
    await writeFiles(5)
    const { qdrant, embeddings, getEmbedCalls } = mocks()
    const indexer = new Indexer(root, qdrant as never, embeddings, config(8))

    indexer.startFull()
    await waitForCompletion(indexer)

    expect(indexer.getState().status).toBe("complete")
    expect(indexer.getState().processedFiles).toBe(5)
    expect(getEmbedCalls()).toBe(1)
  })

  test("processes files in deterministic concurrency-sized groups", async () => {
    await writeFiles(10)
    const { qdrant, embeddings, getEmbedCalls } = mocks()
    const indexer = new Indexer(root, qdrant as never, embeddings, config(4))

    indexer.startFull()
    await waitForCompletion(indexer)

    expect(indexer.getState().processedFiles).toBe(10)
    expect(getEmbedCalls()).toBe(3)
  })

  test("uses wider file groups for remote embedding schedulers", async () => {
    await writeFiles(10)
    const { qdrant, embeddings, getEmbedCalls } = mocks()
    const remoteConfig = { ...config(2), embeddingProvider: "openrouter" as const }
    const indexer = new Indexer(root, qdrant as never, embeddings, remoteConfig)

    indexer.startFull()
    await waitForCompletion(indexer)

    expect(indexer.getState().processedFiles).toBe(10)
    expect(getEmbedCalls()).toBe(1)
  })

  test("deletes stale versions only after replacement points are upserted", async () => {
    await writeFiles(3)
    const existing = new Map(Array.from({ length: 3 }, (_, index) => [`file-${index}.ts`, "old"]))
    const { qdrant, embeddings, events } = mocks(existing)
    const indexer = new Indexer(root, qdrant as never, embeddings, config(8))

    indexer.startIncremental()
    await waitForCompletion(indexer)

    expect(events[0]).toBe("upsert")
    expect(events.slice(1).every((event) => event.startsWith("delete:"))).toBe(true)
    expect(indexer.getState().processedFiles).toBe(3)
  })
})
