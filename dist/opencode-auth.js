import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
export const QDRANT_OPENROUTER_AUTH_ID = "opencode-qdrant-openrouter";
export function getOpenCodeAuthPath(env = process.env, homeDirectory = os.homedir()) {
    const dataDirectory = env.XDG_DATA_HOME?.trim() || path.join(homeDirectory, ".local", "share");
    return path.join(dataDirectory, "opencode", "auth.json");
}
function parseApiKey(raw) {
    const auth = JSON.parse(raw);
    const credential = auth[QDRANT_OPENROUTER_AUTH_ID];
    return credential?.type === "api" ? credential.key?.trim() || null : null;
}
export async function readStoredOpenRouterApiKey(authPath = getOpenCodeAuthPath()) {
    try {
        return parseApiKey(await fs.readFile(authPath, "utf8"));
    }
    catch {
        return null;
    }
}
export function readStoredOpenRouterApiKeySync(authPath = getOpenCodeAuthPath()) {
    try {
        return parseApiKey(fsSync.readFileSync(authPath, "utf8"));
    }
    catch {
        return null;
    }
}
