import fsSync from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export const QDRANT_OPENROUTER_AUTH_ID = "opencode-qdrant-openrouter"

export function getOpenCodeAuthPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  const dataDirectory = env.XDG_DATA_HOME?.trim() || path.join(homeDirectory, ".local", "share")
  return path.join(dataDirectory, "opencode", "auth.json")
}

function parseApiKey(raw: string): string | null {
  const auth = JSON.parse(raw) as Record<string, { type?: string; key?: string }>
  const credential = auth[QDRANT_OPENROUTER_AUTH_ID]
  return credential?.type === "api" ? credential.key?.trim() || null : null
}

export async function readStoredOpenRouterApiKey(
  authPath = getOpenCodeAuthPath(),
): Promise<string | null> {
  try {
    return parseApiKey(await fs.readFile(authPath, "utf8"))
  } catch {
    return null
  }
}

export function readStoredOpenRouterApiKeySync(
  authPath = getOpenCodeAuthPath(),
): string | null {
  try {
    return parseApiKey(fsSync.readFileSync(authPath, "utf8"))
  } catch {
    return null
  }
}
