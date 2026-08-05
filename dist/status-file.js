import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, retryRead, retryUnlink } from "./fs-helpers.js";
import { getProjectDataDir } from "./paths.js";
// Track dirs that have already had their legacy `.opencode/qdrant-*.json`
// files cleaned up, so we don't hammer unlink on every write.
const LEGACY_CLEANED = new Set();
function legacyStatusPath(rootDirectory) {
    return path.join(rootDirectory, ".opencode", "qdrant-status.json");
}
function legacyTriggerPath(rootDirectory) {
    return path.join(rootDirectory, ".opencode", "qdrant-reindex-trigger.json");
}
async function cleanupLegacyFiles(rootDirectory) {
    if (LEGACY_CLEANED.has(rootDirectory))
        return;
    LEGACY_CLEANED.add(rootDirectory);
    // Fire-and-forget — ENOENT is expected and silently ignored.
    for (const legacy of [legacyStatusPath(rootDirectory), legacyTriggerPath(rootDirectory)]) {
        try {
            await retryUnlink(legacy);
        }
        catch {
            // no-op
        }
    }
}
export function getStatusFilePath(rootDirectory) {
    return path.join(getProjectDataDir(rootDirectory), "status.json");
}
export async function writeStatusFile(rootDirectory, state) {
    const filePath = getStatusFilePath(rootDirectory);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await atomicWriteFile(filePath, JSON.stringify({
        ...state,
        updatedAt: Date.now(),
    }, null, 2));
    void cleanupLegacyFiles(rootDirectory);
}
export async function readStatusFile(rootDirectory) {
    try {
        const raw = await retryRead(getStatusFilePath(rootDirectory));
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
export function getTriggerFilePath(rootDirectory) {
    return path.join(getProjectDataDir(rootDirectory), "trigger.json");
}
export async function writeReindexTrigger(rootDirectory, full = false) {
    const filePath = getTriggerFilePath(rootDirectory);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await atomicWriteFile(filePath, JSON.stringify({ full, timestamp: Date.now() }));
    void cleanupLegacyFiles(rootDirectory);
}
export async function consumeReindexTrigger(rootDirectory) {
    const filePath = getTriggerFilePath(rootDirectory);
    try {
        const raw = await retryRead(filePath);
        const trigger = JSON.parse(raw);
        await retryUnlink(filePath);
        return trigger;
    }
    catch {
        return null;
    }
}
