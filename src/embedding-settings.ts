import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import { atomicWriteFile, atomicWriteFileSync, retryRead, retryReadSync } from "./fs-helpers.js"
import { getProjectDataDir } from "./paths.js"
import type { EmbeddingProfile } from "./types.js"

export type EmbeddingSettings = {
  version: 1
  desiredProfile: EmbeddingProfile
  fallbackToLocalOnRateLimit: boolean
  updatedAt: number
}

export function getEmbeddingSettingsPath(rootDirectory: string): string {
  return path.join(getProjectDataDir(rootDirectory), "embedding-settings.json")
}

function parseSettings(raw: string): EmbeddingSettings | null {
  const parsed = JSON.parse(raw) as Partial<EmbeddingSettings>
  if (parsed.version !== 1 || !parsed.desiredProfile || typeof parsed.updatedAt !== "number") {
    return null
  }
  return parsed as EmbeddingSettings
}

export async function readEmbeddingSettings(
  rootDirectory: string,
): Promise<EmbeddingSettings | null> {
  try {
    return parseSettings(await retryRead(getEmbeddingSettingsPath(rootDirectory)))
  } catch {
    return null
  }
}

export function readEmbeddingSettingsSync(rootDirectory: string): EmbeddingSettings | null {
  try {
    return parseSettings(retryReadSync(getEmbeddingSettingsPath(rootDirectory)))
  } catch {
    return null
  }
}

export async function writeEmbeddingSettings(
  rootDirectory: string,
  settings: EmbeddingSettings,
): Promise<void> {
  const filePath = getEmbeddingSettingsPath(rootDirectory)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await atomicWriteFile(filePath, JSON.stringify(settings, null, 2))
}

export function writeEmbeddingSettingsSync(
  rootDirectory: string,
  settings: EmbeddingSettings,
): void {
  const filePath = getEmbeddingSettingsPath(rootDirectory)
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true })
  atomicWriteFileSync(filePath, JSON.stringify(settings, null, 2))
}
