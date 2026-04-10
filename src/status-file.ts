import fs from "node:fs/promises"
import path from "node:path"
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
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        ...state,
        updatedAt: Date.now(),
      } satisfies PersistedStatus,
      null,
      2,
    ),
    "utf8",
  )
}

export async function readStatusFile(rootDirectory: string): Promise<PersistedStatus | null> {
  try {
    const raw = await fs.readFile(getStatusFilePath(rootDirectory), "utf8")
    return JSON.parse(raw) as PersistedStatus
  } catch {
    return null
  }
}
