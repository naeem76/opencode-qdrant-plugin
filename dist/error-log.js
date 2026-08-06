import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir, projectKey } from "./paths.js";
export function getErrorLogPath() {
    return path.join(getDataDir(), "errors-opencode-qdrant.log");
}
export async function appendErrorLog(entry) {
    const filePath = getErrorLogPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const line = {
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
    };
    await fs.appendFile(filePath, `${JSON.stringify(line)}\n`, "utf8");
}
