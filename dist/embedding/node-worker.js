import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import path from "node:path";
/**
 * Embedding provider backed by a single long-running child process.
 *
 * The worker (`worker/embed-worker.mjs`) loads the transformers.js pipeline
 * once and then serves newline-delimited JSON requests over stdin/stdout.
 * This eliminates the per-call process startup + model-load cost that the
 * previous spawn-per-embed design paid on every file.
 *
 * Multiple concurrent `embed()` calls are multiplexed by a monotonically
 * increasing request id; the worker processes them sequentially but the
 * parent can pipeline file I/O and Qdrant upserts in parallel.
 */
export class NodeWorkerEmbeddingProvider {
    options;
    name;
    dimensions;
    workerPath;
    child = null;
    pending = new Map();
    nextId = 1;
    constructor(options) {
        this.options = options;
        this.name = `local-worker:${options.model}:${options.dtype}`;
        this.dimensions = options.dimensions;
        this.workerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../worker/embed-worker.mjs");
    }
    ensureChild() {
        if (this.child)
            return;
        const child = spawn(this.options.command, [this.workerPath], {
            stdio: ["pipe", "pipe", "pipe"],
        });
        const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        rl.on("line", (line) => this.handleLine(line));
        child.on("error", (err) => this.failAll(err));
        child.on("close", (code) => {
            // Reject any still-pending requests; the worker won't answer them.
            if (this.pending.size > 0) {
                this.failAll(new Error(`Local embedding worker exited (code ${code})`));
            }
            this.child = null;
        });
        this.child = child;
    }
    handleLine(line) {
        try {
            const msg = JSON.parse(line);
            const id = msg.id;
            if (id === undefined)
                return;
            const pending = this.pending.get(id);
            if (!pending)
                return;
            this.pending.delete(id);
            if (msg.error) {
                pending.reject(new Error(msg.error));
            }
            else if (Array.isArray(msg.vectors)) {
                pending.resolve(msg.vectors);
            }
            else {
                pending.reject(new Error("Local embedding worker returned invalid output"));
            }
        }
        catch {
            // Ignore malformed lines — keeps the worker alive on a bad message.
        }
    }
    failAll(err) {
        for (const pending of this.pending.values()) {
            pending.reject(err);
        }
        this.pending.clear();
    }
    async embed(texts) {
        if (texts.length === 0) {
            return [];
        }
        this.ensureChild();
        if (!this.child || !this.child.stdin.writable) {
            throw new Error("Local embedding worker is not running");
        }
        const id = this.nextId++;
        const promise = new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
        });
        this.child.stdin.write(`${JSON.stringify({
            id,
            model: this.options.model,
            texts,
            batchSize: this.options.batchSize,
            dtype: this.options.dtype,
        })}\n`);
        const vectors = await promise;
        if (vectors.length !== texts.length) {
            throw new Error("Local embedding worker returned an unexpected number of vectors");
        }
        return vectors;
    }
}
