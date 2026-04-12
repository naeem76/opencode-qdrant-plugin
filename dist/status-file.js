import fs from "node:fs/promises";
import path from "node:path";
export function getStatusFilePath(rootDirectory) {
    return path.join(rootDirectory, ".opencode", "qdrant-status.json");
}
export async function writeStatusFile(rootDirectory, state) {
    const filePath = getStatusFilePath(rootDirectory);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({
        ...state,
        updatedAt: Date.now(),
    }, null, 2), "utf8");
}
export async function readStatusFile(rootDirectory) {
    try {
        const raw = await fs.readFile(getStatusFilePath(rootDirectory), "utf8");
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
export function getTriggerFilePath(rootDirectory) {
    return path.join(rootDirectory, ".opencode", "qdrant-reindex-trigger.json");
}
export async function writeReindexTrigger(rootDirectory, full = false) {
    const filePath = getTriggerFilePath(rootDirectory);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ full, timestamp: Date.now() }), "utf8");
}
export async function consumeReindexTrigger(rootDirectory) {
    const filePath = getTriggerFilePath(rootDirectory);
    try {
        const raw = await fs.readFile(filePath, "utf8");
        const trigger = JSON.parse(raw);
        await fs.unlink(filePath);
        return trigger;
    }
    catch {
        return null;
    }
}
