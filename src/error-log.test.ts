import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { appendErrorLog, getErrorLogPath } from "./error-log.js"

const originalLocalAppData = process.env.LOCALAPPDATA
const originalXdg = process.env.XDG_DATA_HOME
let tempHome: string | null = null

afterEach(async () => {
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = originalLocalAppData
  if (originalXdg === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalXdg
  if (tempHome) await fs.rm(tempHome, { recursive: true, force: true })
  tempHome = null
})

describe("error log", () => {
  test("appends JSON lines under the global plugin data directory", async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "qdrant-error-log-"))
    process.env.LOCALAPPDATA = tempHome
    process.env.XDG_DATA_HOME = tempHome

    await appendErrorLog({
      level: "error",
      source: "test",
      message: "boom",
      projectDirectory: "D:/projects/demo",
      details: { code: 429 },
    })

    const logPath = getErrorLogPath()
    expect(logPath.endsWith("errors-opencode-qdrant.log")).toBe(true)
    const raw = await fs.readFile(logPath, "utf8")
    const entry = JSON.parse(raw.trim()) as {
      level: string
      message: string
      projectKey: string
      details: { code: number }
    }
    expect(entry.level).toBe("error")
    expect(entry.message).toBe("boom")
    expect(entry.details.code).toBe(429)
    expect(entry.projectKey).toHaveLength(12)
  })
})
