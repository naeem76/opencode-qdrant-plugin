/**
 * Tests for config resolution: defaults, validation, provider branching.
 *
 * Run with: `bun test src/config.test.ts`
 */

import { describe, expect, test } from "bun:test"
import { resolveConfig } from "./config.js"
import type { PluginOptions } from "./types.js"

const VALID: PluginOptions = { qdrantUrl: "http://localhost:6333" }

describe("resolveConfig — required fields", () => {
  test("throws when qdrantUrl is missing", () => {
    expect(() => resolveConfig({} as PluginOptions)).toThrow("qdrantUrl")
  })

  test("throws when options is undefined", () => {
    expect(() => resolveConfig(undefined)).toThrow("qdrantUrl")
  })
})

describe("resolveConfig — local provider defaults", () => {
  test("uses local provider by default", () => {
    const cfg = resolveConfig(VALID)
    expect(cfg.embeddingProvider).toBe("local")
  })

  test("uses Xenova all-MiniLM-L6-v2 by default", () => {
    const cfg = resolveConfig(VALID)
    expect(cfg.embeddingModel).toBe("Xenova/all-MiniLM-L6-v2")
  })

  test("defaults dimensions to 384 for local", () => {
    const cfg = resolveConfig(VALID)
    expect(cfg.embeddingDimensions).toBe(384)
  })

  test("defaults localWorkerCommand to 'node'", () => {
    const cfg = resolveConfig(VALID)
    expect(cfg.localWorkerCommand).toBe("node")
  })
})

describe("resolveConfig — api provider", () => {
  test("throws when api provider selected without apiKey", () => {
    expect(() =>
      resolveConfig({ ...VALID, embeddingProvider: "api" }),
    ).toThrow("embeddingApiKey")
  })

  test("uses text-embedding-3-small by default for api", () => {
    const cfg = resolveConfig({ ...VALID, embeddingProvider: "api", embeddingApiKey: "k" })
    expect(cfg.embeddingModel).toBe("text-embedding-3-small")
  })

  test("defaults dimensions to 1536 for api", () => {
    const cfg = resolveConfig({ ...VALID, embeddingProvider: "api", embeddingApiKey: "k" })
    expect(cfg.embeddingDimensions).toBe(1536)
  })

  test("defaults embeddingApiUrl to OpenAI v1 endpoint", () => {
    const cfg = resolveConfig({ ...VALID, embeddingProvider: "api", embeddingApiKey: "k" })
    expect(cfg.embeddingApiUrl).toBe("https://api.openai.com/v1")
  })

  test("preserves provided embeddingApiUrl", () => {
    const cfg = resolveConfig({
      ...VALID,
      embeddingProvider: "api",
      embeddingApiKey: "k",
      embeddingApiUrl: "https://custom.example.com/v1",
    })
    expect(cfg.embeddingApiUrl).toBe("https://custom.example.com/v1")
  })
})

describe("resolveConfig — numeric / boolean defaults", () => {
  test("maxFileSize defaults to 100000", () => {
    expect(resolveConfig(VALID).maxFileSize).toBe(100_000)
  })

  test("chunkMaxLines defaults to 80", () => {
    expect(resolveConfig(VALID).chunkMaxLines).toBe(80)
  })

  test("chunkOverlapLines defaults to 10", () => {
    expect(resolveConfig(VALID).chunkOverlapLines).toBe(10)
  })

  test("searchLimit defaults to 10", () => {
    expect(resolveConfig(VALID).searchLimit).toBe(10)
  })

  test("scoreThreshold defaults to 0.3", () => {
    expect(resolveConfig(VALID).scoreThreshold).toBe(0.3)
  })

  test("indexOnStart defaults to true", () => {
    expect(resolveConfig(VALID).indexOnStart).toBe(true)
  })

  test("excludePatterns defaults to empty array", () => {
    const cfg = resolveConfig(VALID)
    expect(cfg.excludePatterns).toEqual([])
  })

  test("includePatterns defaults to undefined", () => {
    const cfg = resolveConfig(VALID)
    expect(cfg.includePatterns).toBeUndefined()
  })

  test("collectionName defaults to undefined", () => {
    const cfg = resolveConfig(VALID)
    expect(cfg.collectionName).toBeUndefined()
  })
})

describe("resolveConfig — overrides", () => {
  test("passes through all user-provided values", () => {
    const opts: PluginOptions = {
      qdrantUrl: "http://q:6333",
      embeddingProvider: "api",
      embeddingModel: "custom-model",
      embeddingApiKey: "secret",
      embeddingApiUrl: "https://api.example.com",
      embeddingDimensions: 768,
      maxFileSize: 50_000,
      chunkMaxLines: 60,
      chunkOverlapLines: 5,
      excludePatterns: ["dist/**"],
      includePatterns: ["src/**"],
      searchLimit: 15,
      scoreThreshold: 0.5,
      collectionName: "my_collection",
      indexOnStart: false,
      localWorkerCommand: "bun",
    }
    const cfg = resolveConfig(opts)
    expect(cfg.qdrantUrl).toBe("http://q:6333")
    expect(cfg.embeddingModel).toBe("custom-model")
    expect(cfg.embeddingApiKey).toBe("secret")
    expect(cfg.embeddingApiUrl).toBe("https://api.example.com")
    expect(cfg.embeddingDimensions).toBe(768)
    expect(cfg.maxFileSize).toBe(50_000)
    expect(cfg.chunkMaxLines).toBe(60)
    expect(cfg.chunkOverlapLines).toBe(5)
    expect(cfg.excludePatterns).toEqual(["dist/**"])
    expect(cfg.includePatterns).toEqual(["src/**"])
    expect(cfg.searchLimit).toBe(15)
    expect(cfg.scoreThreshold).toBe(0.5)
    expect(cfg.collectionName).toBe("my_collection")
    expect(cfg.indexOnStart).toBe(false)
    expect(cfg.localWorkerCommand).toBe("bun")
  })
})