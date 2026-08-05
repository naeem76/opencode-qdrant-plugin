import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { IndexManager } from "./index-manager.js"
import { collectionNameForProject } from "./utils.js"
import type {
  EmbeddingProfile,
  EmbeddingProvider,
  IndexedPoint,
  PointPayload,
  ResolvedConfig,
} from "./types.js"

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "qdrant-manager-"))
  await fs.writeFile(path.join(root, "file.ts"), "export const value = 1\n")
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const config = (): ResolvedConfig => ({
  qdrantUrl: "http://qdrant",
  embeddingProvider: "local",
  embeddingModel: "local-model",
  embeddingApiKey: undefined,
  embeddingApiKeyEnv: undefined,
  embeddingApiUrl: "https://api.openai.com/v1",
  embeddingApiSendDimensions: true,
  embeddingDimensions: 2,
  maxFileSize: 100_000,
  chunkMaxLines: 80,
  chunkOverlapLines: 10,
  excludePatterns: [],
  includePatterns: undefined,
  searchLimit: 10,
  scoreThreshold: 0.3,
  collectionName: undefined,
  concurrency: 8,
  indexOnStart: false,
  watchFiles: false,
  watchDebounceMs: 2000,
  localEmbeddingBatchSize: 16,
  localEmbeddingDtype: "q8",
  openrouterDataCollection: "allow",
  openrouterZdr: false,
  localWorkerCommand: "node",
})

function fakes(options: { healthy?: boolean; uncertainPromotion?: boolean } = {}) {
  const collections = new Map<string, IndexedPoint[]>()
  const aliases = new Map<string, string>()
  const events: string[] = []
  let healthy = options.healthy ?? true
  let aliasReadable = true
  let promotionAttempted = false

  class FakeQdrant {
    healthy = true
    constructor(
      readonly qdrantUrl: string,
      readonly collectionName: string,
      readonly vectorSize: number,
    ) {}
    isHealthy() {
      return this.healthy
    }
    async healthCheck() {
      this.healthy = healthy
      return healthy
    }
    async ensureCollection() {
      if (!collections.has(this.collectionName)) collections.set(this.collectionName, [])
    }
    async collectionExists(name = this.collectionName) {
      return collections.has(name)
    }
    async getAliasTarget(alias: string) {
      if (!aliasReadable) throw new Error("alias status unavailable")
      return aliases.get(alias) ?? null
    }
    async switchAlias(alias: string, target: string, expected?: string | null) {
      const current = aliases.get(alias) ?? null
      if (expected !== undefined && current !== expected) throw new Error("changed concurrently")
      if (!collections.has(target)) throw new Error("missing collection")
      events.push(`alias:${target}`)
      aliases.set(alias, target)
      if (options.uncertainPromotion && current !== null) {
        promotionAttempted = true
        aliasReadable = false
        throw new Error("alias update timed out")
      }
    }
    async upsertPoints(points: IndexedPoint[]) {
      await this.ensureCollection()
      const collection = collections.get(this.collectionName)
      if (!collection) throw new Error("collection was not created")
      collection.push(...points)
    }
    async getFileHashes() {
      const hashes = new Map<string, string>()
      for (const point of collections.get(this.collectionName) ?? []) {
        hashes.set(point.payload.file_path, point.payload.content_hash)
      }
      return hashes
    }
    async deleteStaleFileVersion() {}
    async deleteByFilePaths() {}
    async deleteCollection() {
      collections.delete(this.collectionName)
    }
    async deleteCollectionByName(name: string) {
      events.push(`delete:${name}`)
      collections.delete(name)
    }
    async getCollectionInfo() {
      return {
        name: this.collectionName,
        pointsCount: collections.get(this.collectionName)?.length ?? null,
        healthy: collections.has(this.collectionName),
      }
    }
    async search() {
      return (collections.get(this.collectionName) ?? []).map((point) => ({
        id: point.id,
        score: 1,
        payload: point.payload as PointPayload,
      }))
    }
  }

  const embeddings: EmbeddingProvider = {
    name: "fake",
    dimensions: 2,
    async embed(texts) {
      return texts.map(() => [0.1, 0.2])
    },
  }

  return {
    collections,
    aliases,
    events,
    embeddings,
    setHealthy(value: boolean) {
      healthy = value
    },
    setAliasReadable(value: boolean) {
      aliasReadable = value
    },
    promotionAttempted() {
      return promotionAttempted
    },
    dependencies: {
      createQdrant: (url: string, name: string, dimensions: number) =>
        new FakeQdrant(url, name, dimensions) as never,
      createEmbeddings: () => embeddings,
    },
  }
}

describe("IndexManager generations", () => {
  test("builds an initial generation and activates the stable alias", async () => {
    const fake = fakes()
    const profile: EmbeddingProfile = {
      version: 1,
      provider: "local",
      tier: "local",
      model: "local-model",
      dimensions: 2,
      dtype: "q8",
    }
    const manager = new IndexManager(
      root,
      config(),
      profile,
      null,
      () => {},
      async () => {},
      false,
      fake.dependencies,
    )

    expect(await manager.initialize()).toBe(true)
    const active = manager.getActiveInfo().generation
    expect(fake.aliases.get(manager.aliasName)).toBe(active.collectionName)
    expect(manager.getState().deployment?.phase).toBe("ready")
    expect(fake.collections.get(active.collectionName)).toHaveLength(0)
  })

  test("recovers after Qdrant becomes available", async () => {
    const fake = fakes({ healthy: false })
    const profile: EmbeddingProfile = {
      version: 1,
      provider: "local",
      tier: "local",
      model: "local-model",
      dimensions: 2,
      dtype: "q8",
    }
    const manager = new IndexManager(
      root,
      config(),
      profile,
      null,
      () => {},
      async () => {},
      false,
      fake.dependencies,
    )

    expect(await manager.initialize()).toBe(false)
    expect(manager.hasActiveIndex()).toBe(false)
    expect((await manager.getCollectionInfo()).healthy).toBe(false)
    fake.setHealthy(true)
    expect(await manager.initialize()).toBe(true)
    expect(manager.hasActiveIndex()).toBe(true)
  })

  test("rebuilds instead of labeling a legacy model as the desired model", async () => {
    const fake = fakes()
    const legacyCollection = collectionNameForProject(root, 2)
    fake.collections.set(legacyCollection, [])
    const remote: EmbeddingProfile = {
      version: 1,
      provider: "openrouter",
      tier: "free",
      model: "remote-model",
      dimensions: 2,
      apiUrl: "https://openrouter.ai/api/v1",
      apiKeyEnv: "TEST_OPENROUTER_KEY",
    }
    process.env.TEST_OPENROUTER_KEY = "key"
    const manager = new IndexManager(
      root,
      config(),
      remote,
      {
        status: "complete",
        totalFiles: 1,
        processedFiles: 1,
        skippedFiles: 0,
        totalChunks: 1,
        errorCount: 0,
        errors: [],
        startedAt: 1,
        completedAt: 2,
        collectionName: legacyCollection,
        collectionPointCount: 1,
        provider: "local-worker:legacy-model:q8",
      },
      () => {},
      async () => {},
      false,
      fake.dependencies,
    )

    await manager.initialize()
    expect(manager.getActiveInfo().generation.profile.model).toBe("legacy-model")
    await manager.switchTo(remote, "user_requested")
    expect(manager.getActiveInfo().generation.profile.model).toBe("remote-model")
    expect(fake.collections.has(legacyCollection)).toBe(true)
    delete process.env.TEST_OPENROUTER_KEY
  })

  test("atomically promotes a new profile and retains the previous collection", async () => {
    const fake = fakes()
    const local: EmbeddingProfile = {
      version: 1,
      provider: "local",
      tier: "local",
      model: "local-model",
      dimensions: 2,
      dtype: "q8",
    }
    const manager = new IndexManager(
      root,
      config(),
      local,
      null,
      () => {},
      async () => {},
      false,
      fake.dependencies,
    )
    await manager.initialize()
    const previous = manager.getActiveInfo().collectionName
    process.env.TEST_OPENROUTER_KEY = "key"
    const remote: EmbeddingProfile = {
      version: 1,
      provider: "openrouter",
      tier: "free",
      model: "remote-model",
      dimensions: 2,
      apiUrl: "https://openrouter.ai/api/v1",
      apiKeyEnv: "TEST_OPENROUTER_KEY",
    }

    await manager.switchTo(
      remote,
      "user_requested",
    )

    const active = manager.getActiveInfo().collectionName
    expect(active).not.toBe(previous)
    expect(fake.aliases.get(manager.aliasName)).toBe(active)
    expect(fake.collections.has(previous)).toBe(true)
    expect(manager.getState().deployment?.retained?.some((item) => item.collectionName === previous)).toBe(
      true,
    )
    delete process.env.TEST_OPENROUTER_KEY
  })

  test("reuses a retained same-model generation without rebuilding", async () => {
    const fake = fakes()
    const local: EmbeddingProfile = {
      version: 1,
      provider: "local",
      tier: "local",
      model: "local-model",
      dimensions: 2,
      dtype: "q8",
    }
    const remote: EmbeddingProfile = {
      version: 1,
      provider: "openrouter",
      tier: "free",
      model: "remote-model",
      dimensions: 2,
      apiUrl: "https://openrouter.ai/api/v1",
      apiKeyEnv: "TEST_OPENROUTER_KEY",
    }
    process.env.TEST_OPENROUTER_KEY = "key"
    const manager = new IndexManager(
      root,
      config(),
      local,
      null,
      () => {},
      async () => {},
      false,
      fake.dependencies,
    )
    await manager.initialize()
    const localCollection = manager.getActiveInfo().collectionName
    await manager.switchTo(remote, "user_requested")
    const remoteCollection = manager.getActiveInfo().collectionName
    const deletesBefore = fake.events.filter((event) => event.startsWith("delete:")).length

    await manager.switchTo(local, "user_requested")

    expect(manager.getActiveInfo().collectionName).toBe(localCollection)
    expect(fake.aliases.get(manager.aliasName)).toBe(localCollection)
    expect(fake.collections.has(remoteCollection)).toBe(true)
    expect(fake.events.filter((event) => event.startsWith("delete:")).length).toBe(deletesBefore)
    delete process.env.TEST_OPENROUTER_KEY
  })

  test("cancels an in-flight cloud build when the active local model is reselected", async () => {
    const fake = fakes()
    let releaseEmbed: (() => void) | undefined
    const embedBlocked = new Promise<void>((resolve) => {
      releaseEmbed = resolve
    })
    const local: EmbeddingProfile = {
      version: 1,
      provider: "local",
      tier: "local",
      model: "local-model",
      dimensions: 2,
      dtype: "q8",
    }
    const remote: EmbeddingProfile = {
      version: 1,
      provider: "openrouter",
      tier: "free",
      model: "remote-model",
      dimensions: 2,
      apiUrl: "https://openrouter.ai/api/v1",
      apiKeyEnv: "TEST_OPENROUTER_KEY",
    }
    process.env.TEST_OPENROUTER_KEY = "key"
    const manager = new IndexManager(
      root,
      config(),
      local,
      null,
      () => {},
      async () => {},
      false,
      {
        ...fake.dependencies,
        createEmbeddings: (resolved) =>
          resolved.embeddingProvider === "openrouter"
            ? {
                name: "slow-remote",
                dimensions: 2,
                async embed(texts) {
                  await embedBlocked
                  return texts.map(() => [0.1, 0.2])
                },
              }
            : fake.embeddings,
      },
    )
    await manager.initialize()
    const localCollection = manager.getActiveInfo().collectionName

    const cloudSwitch = manager.switchTo(remote, "user_requested")
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (manager.getState().deployment?.phase === "building") break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(manager.getState().deployment?.phase).toBe("building")

    const cancel = manager.switchTo(local, "user_requested")
    releaseEmbed?.()
    await Promise.all([cloudSwitch, cancel])

    expect(manager.getActiveInfo().collectionName).toBe(localCollection)
    expect(fake.aliases.get(manager.aliasName)).toBe(localCollection)
    expect(manager.getState().deployment?.phase).toBe("ready")
    expect(manager.getState().deployment?.staging).toBeUndefined()
    delete process.env.TEST_OPENROUTER_KEY
  })

  test("no-ops when the requested model is already active", async () => {
    const fake = fakes()
    const local: EmbeddingProfile = {
      version: 1,
      provider: "local",
      tier: "local",
      model: "local-model",
      dimensions: 2,
      dtype: "q8",
    }
    const manager = new IndexManager(
      root,
      config(),
      local,
      null,
      () => {},
      async () => {},
      false,
      fake.dependencies,
    )
    await manager.initialize()
    const active = manager.getActiveInfo().collectionName
    const aliasEvents = fake.events.filter((event) => event.startsWith("alias:")).length

    await manager.switchTo(local, "user_requested")

    expect(manager.getActiveInfo().collectionName).toBe(active)
    expect(fake.events.filter((event) => event.startsWith("alias:")).length).toBe(aliasEvents)
  })

  test("keeps the active alias and collection when staging fails", async () => {
    const fake = fakes()
    const local: EmbeddingProfile = {
      version: 1,
      provider: "local",
      tier: "local",
      model: "local-model",
      dimensions: 2,
      dtype: "q8",
    }
    const manager = new IndexManager(
      root,
      config(),
      local,
      null,
      () => {},
      async () => {},
      false,
      {
        ...fake.dependencies,
        createEmbeddings: (resolved) =>
          resolved.embeddingProvider === "openrouter"
            ? {
                name: "failing",
                dimensions: 2,
                async embed() {
                  throw new Error("remote unavailable")
                },
              }
            : fake.embeddings,
      },
    )
    await manager.initialize()
    const previous = manager.getActiveInfo().collectionName
    process.env.TEST_OPENROUTER_KEY = "key"
    const remote: EmbeddingProfile = {
      version: 1,
      provider: "openrouter",
      tier: "free",
      model: "remote-model",
      dimensions: 2,
      apiUrl: "https://openrouter.ai/api/v1",
      apiKeyEnv: "TEST_OPENROUTER_KEY",
    }

    await manager.switchTo(
      remote,
      "user_requested",
    )

    expect(manager.getState().deployment?.phase).toBe("failed")
    expect(fake.aliases.get(manager.aliasName)).toBe(previous)
    expect(fake.collections.has(previous)).toBe(true)
    delete process.env.TEST_OPENROUTER_KEY
  })

  test("retains an uncertain promotion and reconciles it on restart", async () => {
    const fake = fakes({ uncertainPromotion: true })
    const local: EmbeddingProfile = {
      version: 1,
      provider: "local",
      tier: "local",
      model: "local-model",
      dimensions: 2,
      dtype: "q8",
    }
    const manager = new IndexManager(
      root,
      config(),
      local,
      null,
      () => {},
      async () => {},
      false,
      fake.dependencies,
    )
    await manager.initialize()
    const previous = manager.getActiveInfo().collectionName
    process.env.TEST_OPENROUTER_KEY = "key"
    const remote: EmbeddingProfile = {
      version: 1,
      provider: "openrouter",
      tier: "free",
      model: "remote-model",
      dimensions: 2,
      apiUrl: "https://openrouter.ai/api/v1",
      apiKeyEnv: "TEST_OPENROUTER_KEY",
    }

    await manager.switchTo(remote, "user_requested")

    const failed = manager.getState()
    const retained = failed.deployment?.staging?.collectionName
    expect(fake.promotionAttempted()).toBe(true)
    expect(failed.deployment?.phase).toBe("failed")
    expect(retained).toBe(fake.aliases.get(manager.aliasName))
    expect(fake.collections.has(previous)).toBe(true)
    expect(fake.collections.has(retained ?? "")).toBe(true)

    fake.setAliasReadable(true)
    const restarted = new IndexManager(
      root,
      config(),
      remote,
      failed,
      () => {},
      async () => {},
      false,
      fake.dependencies,
    )
    expect(await restarted.initialize()).toBe(true)
    expect(restarted.getActiveInfo().collectionName).toBe(retained)
    delete process.env.TEST_OPENROUTER_KEY
  })

  test("waits for in-flight searches before disposing the previous runtime", async () => {
    const fake = fakes()
    let releaseSearch: (() => void) | undefined
    const searchBlocked = new Promise<void>((resolve) => {
      releaseSearch = resolve
    })
    let disposed = false
    const embeddings: EmbeddingProvider = {
      name: "leased",
      dimensions: 2,
      async embed(texts) {
        if (texts[0] === "query") await searchBlocked
        return texts.map(() => [0.1, 0.2])
      },
      async dispose() {
        disposed = true
      },
    }
    const local: EmbeddingProfile = {
      version: 1,
      provider: "local",
      tier: "local",
      model: "local-model",
      dimensions: 2,
      dtype: "q8",
    }
    const manager = new IndexManager(
      root,
      config(),
      local,
      null,
      () => {},
      async () => {},
      false,
      { ...fake.dependencies, createEmbeddings: () => embeddings },
    )
    await manager.initialize()
    const previous = manager.getActiveInfo().collectionName
    const search = manager.embedAndSearch("query", { limit: 1, scoreThreshold: 0 })
    const switching = manager.switchTo({ ...local, model: "next-model" }, "user_requested")

    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (fake.aliases.get(manager.aliasName) !== previous) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(fake.aliases.get(manager.aliasName)).not.toBe(previous)
    expect(fake.collections.has(previous)).toBe(true)
    expect(disposed).toBe(false)
    releaseSearch?.()
    await Promise.all([search, switching])
    expect(fake.collections.has(previous)).toBe(true)
    expect(disposed).toBe(true)
  })
})
