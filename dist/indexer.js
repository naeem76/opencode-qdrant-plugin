import { v4 as uuidv4 } from "uuid";
import { retryRead } from "./fs-helpers.js";
import { chunkFile, extractFileSummary } from "./chunker.js";
import { discoverFiles } from "./discovery.js";
import { mapWithConcurrency } from "./concurrency.js";
import { detectLanguage, sha256 } from "./utils.js";
/** Maximum number of per-file errors retained in state. Older errors are dropped. */
const MAX_RETAINED_ERRORS = 50;
const API_FILE_GROUP_MULTIPLIER = 8;
const emptyTimings = () => ({
    discovery: 0,
    chunking: 0,
    embedding: 0,
    upsert: 0,
    batches: 0,
    totalChunks: 0,
});
export class Indexer {
    rootDirectory;
    qdrant;
    embeddings;
    config;
    onStateChange;
    currentAbort = null;
    currentRun = null;
    state;
    timings = emptyTimings();
    /** Throttle: don't write status more often than this (ms). */
    static EMIT_INTERVAL_MS = 500;
    lastEmitAt = 0;
    emitPending = false;
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
    /**
     * Throttled state emit. Writes the status file at most once per
     * EMIT_INTERVAL_MS to avoid EBUSY storms when many concurrent files
     * finish at once. A final flush is guaranteed by emitStateNow().
     * Trailing-edge throttle: the last call within a window always fires.
     */
    async emitState() {
        const now = Date.now();
        if (now - this.lastEmitAt >= Indexer.EMIT_INTERVAL_MS) {
            this.lastEmitAt = now;
            this.emitPending = false;
            try {
                await this.onStateChange?.(this.getState());
            }
            catch {
                // Status file write failed — non-fatal.
            }
            return;
        }
        // Within throttle window — schedule a trailing flush if one isn't already.
        if (!this.emitPending) {
            this.emitPending = true;
            const delay = Indexer.EMIT_INTERVAL_MS - (now - this.lastEmitAt);
            setTimeout(() => {
                if (!this.emitPending)
                    return;
                this.emitPending = false;
                this.lastEmitAt = Date.now();
                try {
                    const result = this.onStateChange?.(this.getState());
                    if (result)
                        result.catch(() => { });
                }
                catch {
                    // non-fatal
                }
            }, delay);
        }
    }
    /**
     * Force an immediate state emit, bypassing the throttle. Used at the
     * end of a run (finishState) and on status transitions.
     */
    async emitStateNow() {
        this.lastEmitAt = Date.now();
        this.emitPending = false;
        try {
            await this.onStateChange?.(this.getState());
        }
        catch {
            // Status file write failed — non-fatal.
        }
    }
    isRunning() {
        return this.currentRun !== null;
    }
    async waitForIdle() {
        if (!this.currentRun)
            return;
        try {
            await this.currentRun;
        }
        catch {
        }
    }
    async stop() {
        this.currentAbort?.abort();
        await this.waitForIdle();
    }
    startIncremental() {
        void this.runIncremental();
    }
    startFull() {
        void this.runFull();
    }
    async runIncremental() {
        await this.runExclusive(() => this.indexIncremental());
    }
    async runFull() {
        await this.runExclusive(() => this.indexFull());
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
        this.timings = emptyTimings();
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
            timings: undefined,
        };
    }
    async indexFull() {
        this.timings = emptyTimings();
        this.resetState("discovering");
        await this.emitStateNow();
        await this.qdrant.deleteCollection();
        await this.qdrant.ensureCollection();
        const t0 = Date.now();
        const files = await discoverFiles(this.rootDirectory, this.config);
        this.timings.discovery = Date.now() - t0;
        this.state.totalFiles = files.length;
        this.state.status = "indexing";
        await this.emitStateNow();
        const snapshots = [];
        await mapWithConcurrency(files, this.config.concurrency, async (file) => {
            await this.ensureNotAborted();
            const snapshot = await this.trySnapshot(file.absolutePath, file.relativePath);
            if (!snapshot) {
                this.state.processedFiles += 1;
                await this.emitState();
                return;
            }
            snapshots.push(snapshot);
        });
        await this.processSnapshotBatches(snapshots, false);
        await this.finishState();
    }
    async indexIncremental() {
        this.timings = emptyTimings();
        this.resetState("discovering");
        await this.emitStateNow();
        const t0 = Date.now();
        const files = await discoverFiles(this.rootDirectory, this.config);
        const existing = await this.qdrant.getFileHashes();
        this.timings.discovery = Date.now() - t0;
        this.state.totalFiles = files.length;
        this.state.status = "indexing";
        await this.emitStateNow();
        const seen = new Set();
        const changed = [];
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
            changed.push(snapshot);
        });
        await this.processSnapshotBatches(changed, true);
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
    /**
     * Process changed snapshots in deterministic file groups. Progress only
     * advances after each group's vectors have been embedded and upserted.
     * For incremental runs, stale points are deleted after the replacement
     * points exist so a failed embed never removes the last good version.
     */
    async processSnapshotBatches(snapshots, deleteStaleVersions) {
        const groupSize = this.config.embeddingProvider === "local"
            ? this.config.concurrency
            : this.config.concurrency * API_FILE_GROUP_MULTIPLIER;
        for (let start = 0; start < snapshots.length; start += groupSize) {
            await this.ensureNotAborted();
            const batch = snapshots.slice(start, start + groupSize);
            const indexed = await this.indexSnapshotBatch(batch);
            if (indexed && deleteStaleVersions) {
                await mapWithConcurrency(batch, this.config.concurrency, (snapshot) => this.qdrant.deleteStaleFileVersion(snapshot.relativePath, snapshot.hash));
            }
            this.state.processedFiles += batch.length;
            await this.emitState();
        }
    }
    /** Chunk, embed, and upsert one group of files. */
    async indexSnapshotBatch(batch) {
        if (batch.length === 0)
            return true;
        const tChunk = Date.now();
        const allChunks = [];
        for (const snapshot of batch) {
            const chunks = [
                extractFileSummary(snapshot.content),
                ...chunkFile(snapshot.content, this.config.chunkMaxLines, this.config.chunkOverlapLines, snapshot.language),
            ];
            for (const chunk of chunks) {
                allChunks.push({ chunk, snapshot });
            }
        }
        this.timings.chunking += Date.now() - tChunk;
        if (allChunks.length === 0) {
            return true;
        }
        try {
            const tEmbed = Date.now();
            const vectors = await this.embeddings.embed(allChunks.map(({ chunk }) => chunk.content));
            this.timings.embedding += Date.now() - tEmbed;
            const points = allChunks.map(({ chunk, snapshot }, index) => ({
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
            const tUpsert = Date.now();
            await this.qdrant.upsertPoints(points);
            this.timings.upsert += Date.now() - tUpsert;
            this.timings.totalChunks += allChunks.length;
            this.timings.batches += 1;
            this.state.totalChunks += points.length;
            return true;
        }
        catch (error) {
            for (const snapshot of batch) {
                this.recordError(snapshot.relativePath, error);
            }
            return false;
        }
    }
    async finishState() {
        const info = await this.qdrant.getCollectionInfo();
        this.state.collectionPointCount = info.pointsCount;
        this.state.timings = { ...this.timings };
        this.state.status = this.state.errorCount > 0 ? "error" : "complete";
        this.state.completedAt = Date.now();
        await this.emitStateNow();
    }
    async ensureNotAborted() {
        if (this.currentAbort?.signal.aborted) {
            throw new Error("Indexing aborted");
        }
    }
}
