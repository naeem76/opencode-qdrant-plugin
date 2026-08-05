import { v4 as uuidv4 } from "uuid";
import { retryRead } from "./fs-helpers.js";
import { chunkFile, extractFileSummary } from "./chunker.js";
import { discoverFiles } from "./discovery.js";
import { mapWithConcurrency } from "./concurrency.js";
import { detectLanguage, sha256 } from "./utils.js";
/** Maximum number of per-file errors retained in state. Older errors are dropped. */
const MAX_RETAINED_ERRORS = 50;
export class Indexer {
    rootDirectory;
    qdrant;
    embeddings;
    config;
    onStateChange;
    currentAbort = null;
    currentRun = null;
    state;
    constructor(rootDirectory, qdrant, embeddings, config, onStateChange) {
        this.rootDirectory = rootDirectory;
        this.qdrant = qdrant;
        this.embeddings = embeddings;
        this.config = config;
        this.onStateChange = onStateChange;
        this.state = {
            status: "idle",
            totalFiles: 0,
            processedFiles: 0,
            skippedFiles: 0,
            totalChunks: 0,
            errorCount: 0,
            errors: [],
            startedAt: null,
            completedAt: null,
            collectionName: qdrant.collectionName,
            collectionPointCount: null,
            provider: embeddings.name,
        };
    }
    getState() {
        return structuredClone(this.state);
    }
    recordError(file, error) {
        this.state.errorCount += 1;
        this.state.errors.push({
            file,
            error: error instanceof Error ? error.message : String(error),
        });
        if (this.state.errors.length > MAX_RETAINED_ERRORS) {
            this.state.errors.splice(0, this.state.errors.length - MAX_RETAINED_ERRORS);
        }
    }
    async emitState() {
        try {
            await this.onStateChange?.(this.getState());
        }
        catch {
            // Status file write failed (e.g. EBUSY) — non-fatal, indexing continues.
            // The next emitState() call will overwrite with current progress anyway.
        }
    }
    isRunning() {
        return this.currentRun !== null;
    }
    startIncremental() {
        void this.runExclusive(() => this.indexIncremental());
    }
    startFull() {
        void this.runExclusive(() => this.indexFull());
    }
    async runExclusive(run) {
        if (this.currentAbort) {
            this.currentAbort.abort();
        }
        if (this.currentRun) {
            try {
                await this.currentRun;
            }
            catch {
            }
        }
        this.currentAbort = new AbortController();
        this.currentRun = run();
        try {
            await this.currentRun;
        }
        catch (err) {
            console.error("[opencode-qdrant] indexer error:", err);
            this.state.status = "error";
            this.recordError("(indexer)", err);
            this.state.completedAt = Date.now();
            await this.emitState().catch(() => { });
        }
        finally {
            this.currentRun = null;
            this.currentAbort = null;
        }
    }
    resetState(status) {
        this.state = {
            ...this.state,
            status,
            totalFiles: 0,
            processedFiles: 0,
            skippedFiles: 0,
            totalChunks: 0,
            errorCount: 0,
            errors: [],
            startedAt: Date.now(),
            completedAt: null,
        };
    }
    async indexFull() {
        this.resetState("discovering");
        await this.emitState();
        await this.qdrant.deleteCollection();
        await this.qdrant.ensureCollection();
        const files = await discoverFiles(this.rootDirectory, this.config);
        this.state.totalFiles = files.length;
        this.state.status = "indexing";
        await this.emitState();
        await mapWithConcurrency(files, this.config.concurrency, async (file) => {
            await this.ensureNotAborted();
            const snapshot = await this.trySnapshot(file.absolutePath, file.relativePath);
            if (!snapshot) {
                this.state.processedFiles += 1;
                await this.emitState();
                return;
            }
            await this.indexSnapshot(snapshot);
            this.state.processedFiles += 1;
            await this.emitState();
        });
        await this.finishState();
    }
    async indexIncremental() {
        this.resetState("discovering");
        await this.emitState();
        const files = await discoverFiles(this.rootDirectory, this.config);
        const existing = await this.qdrant.getFileHashes();
        this.state.totalFiles = files.length;
        this.state.status = "indexing";
        await this.emitState();
        const seen = new Set();
        await mapWithConcurrency(files, this.config.concurrency, async (file) => {
            await this.ensureNotAborted();
            const snapshot = await this.trySnapshot(file.absolutePath, file.relativePath);
            if (!snapshot) {
                this.state.processedFiles += 1;
                await this.emitState();
                return;
            }
            seen.add(snapshot.relativePath);
            if (existing.get(snapshot.relativePath) === snapshot.hash) {
                this.state.skippedFiles += 1;
                this.state.processedFiles += 1;
                await this.emitState();
                return;
            }
            await this.indexSnapshot(snapshot);
            await this.qdrant.deleteStaleFileVersion(snapshot.relativePath, snapshot.hash);
            this.state.processedFiles += 1;
            await this.emitState();
        });
        const removed = [...existing.keys()].filter((filePath) => !seen.has(filePath));
        await this.qdrant.deleteByFilePaths(removed);
        await this.finishState();
    }
    /**
     * Attempt to snapshot a file, returning `null` (and recording an error) if
     * the file cannot be read after retries (e.g. EBUSY lock from antivirus).
     */
    async trySnapshot(absolutePath, relativePath) {
        try {
            return await this.snapshot(absolutePath, relativePath);
        }
        catch (err) {
            this.recordError(relativePath, err);
            await this.emitState();
            return null;
        }
    }
    async snapshot(absolutePath, relativePath) {
        // Use more aggressive retries for indexer reads — antivirus / editor locks
        // can persist longer than the default 200ms total window.
        const content = await retryRead(absolutePath, { maxRetries: 5, baseDelayMs: 100 });
        return {
            absolutePath,
            relativePath,
            size: Buffer.byteLength(content, "utf8"),
            content,
            hash: sha256(content),
            language: detectLanguage(relativePath),
        };
    }
    async indexSnapshot(snapshot) {
        try {
            const chunks = [
                extractFileSummary(snapshot.content),
                ...chunkFile(snapshot.content, this.config.chunkMaxLines, this.config.chunkOverlapLines),
            ];
            const vectors = await this.embeddings.embed(chunks.map((chunk) => chunk.content));
            const points = chunks.map((chunk, index) => ({
                id: uuidv4(),
                vector: vectors[index],
                payload: {
                    file_path: snapshot.relativePath,
                    chunk_type: chunk.type,
                    content: chunk.content,
                    start_line: chunk.startLine,
                    end_line: chunk.endLine,
                    language: snapshot.language,
                    content_hash: snapshot.hash,
                    indexed_at: Date.now(),
                },
            }));
            await this.qdrant.upsertPoints(points);
            this.state.totalChunks += points.length;
        }
        catch (error) {
            this.recordError(snapshot.relativePath, error);
            await this.emitState();
        }
    }
    async finishState() {
        const info = await this.qdrant.getCollectionInfo();
        this.state.collectionPointCount = info.pointsCount;
        this.state.status = this.state.errorCount > 0 ? "error" : "complete";
        this.state.completedAt = Date.now();
        await this.emitState();
    }
    async ensureNotAborted() {
        if (this.currentAbort?.signal.aborted) {
            throw new Error("Indexing aborted");
        }
    }
}
