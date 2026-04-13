import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, retryRead, retryUnlink } from "./fs-helpers.js";
export function getStatusFilePath(rootDirectory) {
    return path.join(rootDirectory, ".opencode", "qdrant-status.json");
}
export async function writeStatusFile(rootDirectory, state) {
    const filePath = getStatusFilePath(rootDirectory);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await atomicWriteFile(filePath, JSON.stringify({
        ...state,
        updatedAt: Date.now(),
    }, null, 2));
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
    return path.join(rootDirectory, ".opencode", "qdrant-reindex-trigger.json");
}
export async function writeReindexTrigger(rootDirectory, full = false) {
    const filePath = getTriggerFilePath(rootDirectory);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await atomicWriteFile(filePath, JSON.stringify({ full, timestamp: Date.now() }));
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
