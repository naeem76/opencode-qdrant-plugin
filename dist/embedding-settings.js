import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { atomicWriteFile, atomicWriteFileSync, retryRead, retryReadSync } from "./fs-helpers.js";
import { getProjectDataDir } from "./paths.js";
export function getEmbeddingSettingsPath(rootDirectory) {
    return path.join(getProjectDataDir(rootDirectory), "embedding-settings.json");
}
function parseSettings(raw) {
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1 || !parsed.desiredProfile || typeof parsed.updatedAt !== "number") {
        return null;
    }
    return parsed;
}
export async function readEmbeddingSettings(rootDirectory) {
    try {
        return parseSettings(await retryRead(getEmbeddingSettingsPath(rootDirectory)));
    }
    catch {
        return null;
    }
}
export function readEmbeddingSettingsSync(rootDirectory) {
    try {
        return parseSettings(retryReadSync(getEmbeddingSettingsPath(rootDirectory)));
    }
    catch {
        return null;
    }
}
export async function writeEmbeddingSettings(rootDirectory, settings) {
    const filePath = getEmbeddingSettingsPath(rootDirectory);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await atomicWriteFile(filePath, JSON.stringify(settings, null, 2));
}
export function writeEmbeddingSettingsSync(rootDirectory, settings) {
    const filePath = getEmbeddingSettingsPath(rootDirectory);
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteFileSync(filePath, JSON.stringify(settings, null, 2));
}
