import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import {
  getOpenCodeAuthPath,
  QDRANT_OPENROUTER_AUTH_ID,
  readStoredOpenRouterApiKey,
  readStoredOpenRouterApiKeySync,
} from "./opencode-auth.js"

let temporaryDirectory: string | null = null

afterEach(async () => {
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = null
})

describe("OpenCode credential lookup", () => {
  test("uses OpenCode's data directory", () => {
    expect(getOpenCodeAuthPath({ XDG_DATA_HOME: "D:/data" }, "D:/home")).toBe(
      path.join("D:/data", "opencode", "auth.json"),
    )
  })

  test("reads only the plugin-specific API credential", async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-auth-"))
    const authPath = path.join(temporaryDirectory, "auth.json")
    await fs.writeFile(
      authPath,
      JSON.stringify({
        openrouter: { type: "api", key: "code-model-key" },
        [QDRANT_OPENROUTER_AUTH_ID]: { type: "api", key: " embedding-key " },
      }),
    )

    expect(await readStoredOpenRouterApiKey(authPath)).toBe("embedding-key")
    expect(readStoredOpenRouterApiKeySync(authPath)).toBe("embedding-key")
  })

  test("returns null for missing or malformed credentials", async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-auth-"))
    const authPath = path.join(temporaryDirectory, "auth.json")
    await fs.writeFile(authPath, "not-json")

    expect(await readStoredOpenRouterApiKey(authPath)).toBeNull()
    expect(readStoredOpenRouterApiKeySync(authPath)).toBeNull()
  })
})
