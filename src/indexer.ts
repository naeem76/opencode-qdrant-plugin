import { v4 as uuidv4 } from "uuid"
import { retryRead } from "./fs-helpers.js"
import { chunkFile, extractFileSummary } from "./chunker.js"
import { discoverFiles } from "./discovery.js"
import { mapWithConcurrency } from "./concurrency.js"
import type {
  Chunk,
  EmbeddingProvider,
  FileSnapshot,
  IndexedPoint,
  IndexingState,
  ResolvedConfig,
} from "./types.js"
import { detectLanguage, sha256 } from "./utils.js"
import { QdrantWrapper } from "./qdrant.js"

/** Maximum number of per-file errors retained in state. Older errors are dropped. */
const MAX_RETAINED_ERRORS = 50

/** Cumulative timing for the current run, in ms. Reset on each indexFull/indexIncremental. */
interface RunTimings {
  discovery: number
  chunking: number
  embedding: number
  upsert: number
  batches: number
  totalChunks: number
}
const emptyTimings = (): RunTimings => ({
  discovery: 0,
  chunking: 0,
  embedding: 0,
  upsert: 0,
  batches: 0,
  totalChunks: 0,
})

interface QueuedSnapshot {
  snapshot: FileSnapshot
  resolve: () => void
}

export class Indexer {
  private currentAbort: AbortController | null = null
  private currentRun: Promise<void> | null = null
  private state: IndexingState
  private timings: RunTimings = emptyTimings()

  /** Snapshots waiting for the next batch embed+upsert flush. */
  private batchQueue: QueuedSnapshot[] = []
  /** In-flight flush promise, prevents overlapping flushes. */
  private batchFlush: Promise<void> | null = null

  constructor(
    private readonly rootDirectory: string,
    private readonly qdrant: QdrantWrapper,
    private readonly embeddings: EmbeddingProvider,
    private readonly config: ResolvedConfig,
    private readonly onStateChange?: (state: IndexingState) => Promise<void> | void,
  ) {
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
    }
  }

  getState() {
    return structuredClone(this.state)
  }

  private recordError(file: string, error: unknown) {
    this.state.errorCount += 1
    this.state.errors.push({
      file,
      error: error instanceof Error ? error.message : String(error),
    })
    if (this.state.errors.length > MAX_RETAINED_ERRORS) {
      this.state.errors.splice(0, this.state.errors.length - MAX_RETAINED_ERRORS)
    }
  }

  private async emitState() {
    try {
      await this.onStateChange?.(this.getState())
    } catch {
      // Status file write failed (e.g. EBUSY) — non-fatal, indexing continues.
      // The next emitState() call will overwrite with current progress anyway.
    }
  }

  isRunning() {
    return this.currentRun !== null
  }

  startIncremental() {
    void this.runExclusive(() => this.indexIncremental())
  }

  startFull() {
    void this.runExclusive(() => this.indexFull())
  }

  private async runExclusive(run: () => Promise<void>) {
    if (this.currentAbort) {
      this.currentAbort.abort()
    }
    if (this.currentRun) {
      try {
        await this.currentRun
      } catch {
      }
    }

    this.currentAbort = new AbortController()
    this.currentRun = run()
    try {
      await this.currentRun
    } catch (err) {
      console.error("[opencode-qdrant] indexer error:", err)
      this.state.status = "error"
      this.recordError("(indexer)", err)
      this.state.completedAt = Date.now()
      await this.emitState().catch(() => {})
    } finally {
      this.currentRun = null
      this.currentAbort = null
    }
  }

  private resetState(status: IndexingState["status"]) {
    this.timings = emptyTimings()
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
    }
  }

  private async indexFull() {
    this.timings = emptyTimings()
    this.resetState("discovering")
    await this.emitState()
    await this.qdrant.deleteCollection()
    await this.qdrant.ensureCollection()
    const t0 = Date.now()
    const files = await discoverFiles(this.rootDirectory, this.config)
    this.timings.discovery = Date.now() - t0
    this.state.totalFiles = files.length
    this.state.status = "indexing"
    await this.emitState()
    await mapWithConcurrency(files, this.config.concurrency, async (file) => {
      await this.ensureNotAborted()
      const snapshot = await this.trySnapshot(file.absolutePath, file.relativePath)
      if (!snapshot) {
        this.state.processedFiles += 1
        await this.emitState()
        return
      }
      await this.queueForBatch(snapshot)
      this.state.processedFiles += 1
      await this.emitState()
    })
    await this.flushBatch()
    this.logTimings("full")
    await this.finishState()
  }

  private async indexIncremental() {
    this.timings = emptyTimings()
    this.resetState("discovering")
    await this.emitState()
    const t0 = Date.now()
    const files = await discoverFiles(this.rootDirectory, this.config)
    const existing = await this.qdrant.getFileHashes()
    this.timings.discovery = Date.now() - t0
    this.state.totalFiles = files.length
    this.state.status = "indexing"
    await this.emitState()

    const seen = new Set<string>()
    await mapWithConcurrency(files, this.config.concurrency, async (file) => {
      await this.ensureNotAborted()
      const snapshot = await this.trySnapshot(file.absolutePath, file.relativePath)
      if (!snapshot) {
        this.state.processedFiles += 1
        await this.emitState()
        return
      }
      seen.add(snapshot.relativePath)
      if (existing.get(snapshot.relativePath) === snapshot.hash) {
        this.state.skippedFiles += 1
        this.state.processedFiles += 1
        await this.emitState()
        return
      }

      await this.queueForBatch(snapshot)
      await this.qdrant.deleteStaleFileVersion(snapshot.relativePath, snapshot.hash)
      this.state.processedFiles += 1
      await this.emitState()
    })
    await this.flushBatch()

    const removed = [...existing.keys()].filter((filePath) => !seen.has(filePath))
    await this.qdrant.deleteByFilePaths(removed)
    this.logTimings("incremental")
    await this.finishState()
  }

  /**
   * Attempt to snapshot a file, returning `null` (and recording an error) if
   * the file cannot be read after retries (e.g. EBUSY lock from antivirus).
   */
  private async trySnapshot(
    absolutePath: string,
    relativePath: string,
  ): Promise<FileSnapshot | null> {
    try {
      return await this.snapshot(absolutePath, relativePath)
    } catch (err) {
      this.recordError(relativePath, err)
      await this.emitState()
      return null
    }
  }

  private async snapshot(absolutePath: string, relativePath: string): Promise<FileSnapshot> {
    // Use more aggressive retries for indexer reads — antivirus / editor locks
    // can persist longer than the default 200ms total window.
    const content = await retryRead(absolutePath, { maxRetries: 5, baseDelayMs: 100 })
    return {
      absolutePath,
      relativePath,
      size: Buffer.byteLength(content, "utf8"),
      content,
      hash: sha256(content),
      language: detectLanguage(relativePath),
    }
  }

/**
   * Queue a snapshot for batched embedding + upsert. Returns a promise that
   * resolves once the batch containing this snapshot has been flushed. When
   * the queue reaches `concurrency` items, a flush is triggered immediately
   * so embeddings run while other files are still being read.
   */
  private async queueForBatch(snapshot: FileSnapshot): Promise<void> {
    return new Promise<void>((resolve) => {
      this.batchQueue.push({ snapshot, resolve })
      if (this.batchQueue.length >= this.config.concurrency && !this.batchFlush) {
        this.batchFlush = this.flushBatch().finally(() => {
          this.batchFlush = null
        })
      }
    })
  }

  /**
   * Flush all queued snapshots: chunk every file, embed all chunks in a
   * single call, upsert all points in one request. This is the key
   * performance optimization — transformers.js processes batches far
   * more efficiently than per-file requests.
   */
  private async flushBatch(): Promise<void> {
    const batch = this.batchQueue.splice(0)
    if (batch.length === 0) return

    const tChunk = Date.now()
    const allChunks: Array<{ chunk: Chunk; snapshot: FileSnapshot }> = []
    for (const { snapshot } of batch) {
      const chunks = [
        extractFileSummary(snapshot.content),
        ...chunkFile(
          snapshot.content,
          this.config.chunkMaxLines,
          this.config.chunkOverlapLines,
          snapshot.language,
        ),
      ]
      for (const chunk of chunks) {
        allChunks.push({ chunk, snapshot })
      }
    }
    this.timings.chunking += Date.now() - tChunk

    if (allChunks.length === 0) {
      for (const item of batch) item.resolve()
      return
    }

    try {
      const tEmbed = Date.now()
      const vectors = await this.embeddings.embed(allChunks.map(({ chunk }) => chunk.content))
      this.timings.embedding += Date.now() - tEmbed

      const points: IndexedPoint[] = allChunks.map(({ chunk, snapshot }, index) => ({
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
      }))

      const tUpsert = Date.now()
      await this.qdrant.upsertPoints(points)
      this.timings.upsert += Date.now() - tUpsert

      this.timings.totalChunks += allChunks.length
      this.timings.batches += 1
      this.state.totalChunks += points.length
    } catch (error) {
      for (const { snapshot } of batch) {
        this.recordError(snapshot.relativePath, error)
      }
    }

    for (const item of batch) item.resolve()
  }

  private async finishState() {
    const info = await this.qdrant.getCollectionInfo()
    this.state.collectionPointCount = info.pointsCount
    this.state.timings = { ...this.timings }
    this.state.status = this.state.errorCount > 0 ? "error" : "complete"
    this.state.completedAt = Date.now()
    await this.emitState()
  }

  private async ensureNotAborted() {
    if (this.currentAbort?.signal.aborted) {
      throw new Error("Indexing aborted")
    }
  }

  private logTimings(mode: string) {
    const t = this.timings
    console.error(
      `[opencode-qdrant] ${mode} reindex timings:`,
      `discovery=${t.discovery}ms`,
      `chunking=${t.chunking}ms`,
      `embedding=${t.embedding}ms (${t.totalChunks} chunks in ${t.batches} batches, avg=${Math.round(t.embedding / Math.max(t.batches, 1))}ms/batch)`,
      `upsert=${t.upsert}ms`,
      `total=${t.discovery + t.chunking + t.embedding + t.upsert}ms`,
    )
  }
}
