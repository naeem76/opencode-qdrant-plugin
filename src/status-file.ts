import fs from "node:fs/promises"
import path from "node:path"
import { atomicWriteFile, retryRead, retryUnlink } from "./fs-helpers.js"
import type { IndexingState } from "./types.js"

export type PersistedStatus = IndexingState & {
  updatedAt: number
}

export function getStatusFilePath(rootDirectory: string) {
  return path.join(rootDirectory, ".opencode", "qdrant-status.json")
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
  full: boolean
  timestamp: number
}

export function getTriggerFilePath(rootDirectory: string) {
  return path.join(rootDirectory, ".opencode", "qdrant-reindex-trigger.json")
}

export async function writeReindexTrigger(rootDirectory: string, full = false) {
  const filePath = getTriggerFilePath(rootDirectory)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await atomicWriteFile(
    filePath,
    JSON.stringify({ full, timestamp: Date.now() } satisfies ReindexTrigger),
  )
}

export async function consumeReindexTrigger(rootDirectory: string): Promise<ReindexTrigger | null> {
  const filePath = getTriggerFilePath(rootDirectory)
  try {
    const raw = await retryRead(filePath)
    const trigger = JSON.parse(raw) as ReindexTrigger
    await retryUnlink(filePath)
    return trigger
  } catch {
    return null
  }
}
