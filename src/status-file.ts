import fs from "node:fs/promises"
import path from "node:path"
import { atomicWriteFile, retryRead, retryUnlink } from "./fs-helpers.js"
import { getProjectDataDir } from "./paths.js"
import type { IndexingState } from "./types.js"

export type PersistedStatus = IndexingState & {
  updatedAt: number
}

// Track dirs that have already had their legacy `.opencode/qdrant-*.json`
// files cleaned up, so we don't hammer unlink on every write.
const LEGACY_CLEANED = new Set<string>()

function legacyStatusPath(rootDirectory: string) {
  return path.join(rootDirectory, ".opencode", "qdrant-status.json")
}

function legacyTriggerPath(rootDirectory: string) {
  return path.join(rootDirectory, ".opencode", "qdrant-reindex-trigger.json")
}

async function cleanupLegacyFiles(rootDirectory: string) {
  if (LEGACY_CLEANED.has(rootDirectory)) return
  LEGACY_CLEANED.add(rootDirectory)
  // Fire-and-forget — ENOENT is expected and silently ignored.
  for (const legacy of [legacyStatusPath(rootDirectory), legacyTriggerPath(rootDirectory)]) {
    try {
      await retryUnlink(legacy)
    } catch {
      // no-op
    }
  }
}

export function getStatusFilePath(rootDirectory: string) {
  return path.join(getProjectDataDir(rootDirectory), "status.json")
}

export async function writeStatusFile(rootDirectory: string, state: IndexingState) {
  const filePath = getStatusFilePath(rootDirectory)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await atomicWriteFile(
    filePath,
    JSON.stringify(
      {
        ...state,
        updatedAt: Date.now(),
      } satisfies PersistedStatus,
      null,
      2,
    ),
  )
  void cleanupLegacyFiles(rootDirectory)
}

export async function readStatusFile(rootDirectory: string): Promise<PersistedStatus | null> {
  try {
    const raw = await retryRead(getStatusFilePath(rootDirectory))
    return JSON.parse(raw) as PersistedStatus
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Reindex trigger file — TUI writes it, server polls & consumes it
// ---------------------------------------------------------------------------

export type ReindexTrigger = {
  action?: "reindex" | "settings"
  full: boolean
  timestamp: number
}

export function getTriggerFilePath(rootDirectory: string) {
  return path.join(getProjectDataDir(rootDirectory), "trigger.json")
}

export async function writeReindexTrigger(rootDirectory: string, full = false) {
  await writeTrigger(rootDirectory, { action: "reindex", full, timestamp: Date.now() })
}

export async function writeTrigger(rootDirectory: string, trigger: ReindexTrigger) {
  const filePath = getTriggerFilePath(rootDirectory)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await atomicWriteFile(
    filePath,
    JSON.stringify(trigger),
  )
  void cleanupLegacyFiles(rootDirectory)
}

export async function consumeReindexTrigger(rootDirectory: string): Promise<ReindexTrigger | null> {
  const filePath = getTriggerFilePath(rootDirectory)
  const processingPath = `${filePath}.${process.pid}.${Date.now()}.processing`
  try {
    await fs.rename(filePath, processingPath)
  } catch {
    return null
  }
  try {
    return JSON.parse(await retryRead(processingPath)) as ReindexTrigger
  } finally {
    await retryUnlink(processingPath).catch(() => {})
  }
}
