import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
export class NodeWorkerEmbeddingProvider {
    options;
    name;
    dimensions;
    constructor(options) {
        this.options = options;
        this.name = `local-worker:${options.model}`;
        this.dimensions = options.dimensions;
    }
    async embed(texts) {
        if (texts.length === 0) {
            return [];
        }
        const workerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../worker/embed-worker.mjs");
        const child = spawn(this.options.command, [workerPath], {
            stdio: ["pipe", "pipe", "pipe"],
        });
        const stdout = [];
        const stderr = [];
        child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
        child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
        const exitCode = await new Promise((resolve, reject) => {
            child.on("error", reject);
            child.on("close", resolve);
            child.stdin.end(JSON.stringify({
                model: this.options.model,
                texts,
            }));
        });
        if (exitCode !== 0) {
            throw new Error(`Local embedding worker failed: ${Buffer.concat(stderr).toString("utf8")}`);
        }
        const json = JSON.parse(Buffer.concat(stdout).toString("utf8"));
        if (!Array.isArray(json.vectors) || json.vectors.length !== texts.length) {
            throw new Error("Local embedding worker returned invalid output");
        }
        return json.vectors;
    }
}
