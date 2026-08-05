import { QdrantClient } from "@qdrant/js-client-rest";
import { isTransientNetworkError, retryAsync } from "./retry.js";
export class QdrantWrapper {
    qdrantUrl;
    collectionName;
    vectorSize;
    client;
    healthy = false;
    ensured = false;
    ensurePromise = null;
    constructor(qdrantUrl, collectionName, vectorSize) {
        this.qdrantUrl = qdrantUrl;
        this.collectionName = collectionName;
        this.vectorSize = vectorSize;
        this.client = new QdrantClient({ url: qdrantUrl, checkCompatibility: false });
    }
    isHealthy() {
        return this.healthy;
    }
    async healthCheck() {
        try {
            const response = await fetch(new URL("/collections", this.qdrantUrl));
            this.healthy = response.ok;
            return this.healthy;
        }
        catch {
            this.healthy = false;
            return false;
        }
    }
    async ensureCollection() {
        if (this.ensured) {
            return;
        }
        if (this.ensurePromise) {
            return this.ensurePromise;
        }
        this.ensurePromise = this.doEnsureCollection();
        try {
            await this.ensurePromise;
        }
        finally {
            this.ensurePromise = null;
        }
    }
    async doEnsureCollection() {
        try {
            await this.client.getCollection(this.collectionName);
        }
        catch {
            await this.client.createCollection(this.collectionName, {
                vectors: { size: this.vectorSize, distance: "Cosine" },
            });
        }
        for (const fieldName of ["file_path", "language", "chunk_type", "content_hash"]) {
            try {
                await this.client.createPayloadIndex(this.collectionName, {
                    field_name: fieldName,
                    field_schema: "keyword",
                });
            }
            catch {
            }
        }
        this.healthy = true;
        this.ensured = true;
    }
    async getCollectionInfo() {
        try {
            const info = await this.client.getCollection(this.collectionName);
            this.healthy = true;
            return {
                name: this.collectionName,
                pointsCount: info.points_count ?? null,
                healthy: true,
            };
        }
        catch {
            this.healthy = false;
            return { name: this.collectionName, pointsCount: null, healthy: false };
        }
    }
    async upsertPoints(points) {
        if (points.length === 0) {
            return;
        }
        await this.ensureCollection();
        for (let index = 0; index < points.length; index += 100) {
            const chunk = points.slice(index, index + 100);
            await retryAsync(() => this.client.upsert(this.collectionName, { wait: true, points: chunk }), (err) => isTransientNetworkError(err));
        }
        this.healthy = true;
    }
    async search(vector, options) {
        await this.ensureCollection();
        const result = await retryAsync(() => this.client.search(this.collectionName, {
            vector,
            limit: Math.max(options.limit, 1),
            score_threshold: options.scoreThreshold,
            with_payload: true,
            filter: options.chunkType
                ? {
                    must: [{ key: "chunk_type", match: { value: options.chunkType } }],
                }
                : undefined,
        }), (err) => isTransientNetworkError(err));
        this.healthy = true;
        return result.flatMap((item) => {
            const payload = item.payload;
            if (!payload) {
                return [];
            }
            return [{ id: item.id, score: item.score, payload }];
        });
    }
    /**
     * Build a `file_path → content_hash` map of currently indexed files.
     *
     * Scrolls the whole collection (no chunk_type filter) so the result is
     * robust to files that lack a `summary` chunk — every file with at
     * least one chunk is included. When a file has multiple chunks, all
     * chunks of a given file share the same `content_hash` (it's the hash
     * of the whole file, set in indexSnapshot), so any chunk's hash is
     * authoritative.
     */
    async getFileHashes() {
        await this.ensureCollection();
        const hashes = new Map();
        let offset;
        do {
            const page = await this.client.scroll(this.collectionName, {
                limit: 256,
                offset,
                with_payload: true,
                with_vector: false,
            });
            for (const point of page.points) {
                const payload = point.payload;
                if (payload?.file_path && !hashes.has(payload.file_path)) {
                    hashes.set(payload.file_path, payload.content_hash);
                }
            }
            const nextOffset = page.next_page_offset;
            offset = typeof nextOffset === "string" || typeof nextOffset === "number" ? nextOffset : undefined;
        } while (offset !== undefined);
        this.healthy = true;
        return hashes;
    }
    async deleteByFilePaths(filePaths) {
        if (filePaths.length === 0) {
            return;
        }
        await this.ensureCollection();
        await this.client.delete(this.collectionName, {
            wait: true,
            filter: { should: filePaths.map((filePath) => ({ key: "file_path", match: { value: filePath } })) },
        });
        this.healthy = true;
    }
    async deleteStaleFileVersion(filePath, currentHash) {
        await this.ensureCollection();
        await this.client.delete(this.collectionName, {
            wait: true,
            filter: {
                must: [{ key: "file_path", match: { value: filePath } }],
                must_not: [{ key: "content_hash", match: { value: currentHash } }],
            },
        });
        this.healthy = true;
    }
    async deleteCollection() {
        try {
            await this.client.deleteCollection(this.collectionName);
        }
        catch {
        }
        this.ensured = false;
        this.ensurePromise = null;
    }
}
