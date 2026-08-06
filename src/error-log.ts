import fs from "node:fs/promises"
import path from "node:path"
import { getDataDir, projectKey } from "./paths.js"

export type ErrorLogLevel = "warn" | "error"

export type ErrorLogEntry = {
  at: string
  level: ErrorLogLevel
  source: string
  message: string
  project?: string
  projectKey?: string
  details?: unknown
}

export function getErrorLogPath(): string {
  return path.join(getDataDir(), "errors-opencode-qdrant.log")
}

export async function appendErrorLog(entry: {
  level: ErrorLogLevel
  source: string
  message: string
  projectDirectory?: string
  details?: unknown
}): Promise<void> {
  const filePath = getErrorLogPath()
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const line: ErrorLogEntry = {
    at: new Date().toISOString(),
    level: entry.level,
    source: entry.source,
    message: entry.message,
    ...(entry.projectDirectory
      ? {
          project: entry.projectDirectory,
          projectKey: projectKey(entry.projectDirectory),
        }
      : {}),
    ...(entry.details !== undefined ? { details: entry.details } : {}),
  }
  await fs.appendFile(filePath, `${JSON.stringify(line)}\n`, "utf8")
}
