import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  getEmbeddingSettingsPath,
  readEmbeddingSettings,
  readEmbeddingSettingsSync,
  writeEmbeddingSettings,
  writeEmbeddingSettingsSync,
  type EmbeddingSettings,
} from "./embedding-settings.js"

let root: string

const settings: EmbeddingSettings = {
  version: 1,
  desiredProfile: {
    version: 1,
    provider: "openrouter",
    tier: "free",
    model: "nvidia/nemotron-3-embed-1b:free",
    dimensions: 1024,
    apiUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
  fallbackToLocalOnRateLimit: true,
  updatedAt: 123,
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "qdrant-settings-"))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe("embedding settings", () => {
  test("round-trips asynchronously without secret fields", async () => {
    await writeEmbeddingSettings(root, settings)
    expect(await readEmbeddingSettings(root)).toEqual(settings)
    expect(await fs.readFile(getEmbeddingSettingsPath(root), "utf8")).not.toContain("apiKey\"")
  })

  test("round-trips synchronously for the TUI", () => {
    writeEmbeddingSettingsSync(root, settings)
    expect(readEmbeddingSettingsSync(root)).toEqual(settings)
  })

  test("returns null for missing or invalid settings", async () => {
    expect(await readEmbeddingSettings(root)).toBeNull()
    await fs.mkdir(path.dirname(getEmbeddingSettingsPath(root)), { recursive: true })
    await fs.writeFile(getEmbeddingSettingsPath(root), "{}")
    expect(await readEmbeddingSettings(root)).toBeNull()
  })
})
