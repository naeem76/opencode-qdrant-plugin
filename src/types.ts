export type EmbeddingProviderKind = "local" | "api"

export type PluginOptions = {
  qdrantUrl: string
  embeddingProvider?: EmbeddingProviderKind
  embeddingModel?: string
  embeddingApiKey?: string
  embeddingApiUrl?: string
  embeddingDimensions?: number
  maxFileSize?: number
  chunkMaxLines?: number
  chunkOverlapLines?: number
  excludePatterns?: string[]
  includePatterns?: string[]
  searchLimit?: number
  scoreThreshold?: number
  collectionName?: string
  concurrency?: number
  indexOnStart?: boolean
  watchFiles?: boolean
  watchDebounceMs?: number
  localWorkerCommand?: string
}

export type ResolvedConfig = Required<
  Omit<
    PluginOptions,
    "embeddingApiKey" | "embeddingDimensions" | "collectionName" | "includePatterns"
  >
> & {
  embeddingApiKey?: string
  embeddingDimensions: number
  collectionName?: string
  concurrency: number
  watchFiles: boolean
  watchDebounceMs: number
  includePatterns?: string[]
}

export type ChunkType = "code" | "summary"

export type PointPayload = {
  file_path: string
  chunk_type: ChunkType
  content: string
  start_line: number
  end_line: number
  language: string
  content_hash: string
  indexed_at: number
}

export type Chunk = {
  content: string
  startLine: number
  endLine: number
  type: ChunkType
}

export type IndexedPoint = {
  id: string
  vector: number[]
  payload: PointPayload
}

export type SearchHit = {
  id: string | number
  score: number
  payload: PointPayload
}

export type FileEntry = {
  absolutePath: string
  relativePath: string
  size: number
}

export type FileSnapshot = FileEntry & {
  content: string
  hash: string
  language: string
}

export type IndexingStatus =
  | "idle"
  | "discovering"
  | "indexing"
  | "complete"
  | "error"
  | "unavailable"

export type IndexingError = {
  file: string
  error: string
}

export type IndexingState = {
  status: IndexingStatus
  totalFiles: number
  processedFiles: number
  skippedFiles: number
  totalChunks: number
  errorCount: number
  errors: IndexingError[]
  startedAt: number | null
  completedAt: number | null
  collectionName: string
  collectionPointCount: number | null
  provider: string
  timings?: {
    discovery: number
    chunking: number
    embedding: number
    upsert: number
    batches: number
    totalChunks: number
  }
}

export interface EmbeddingProvider {
  readonly name: string
  readonly dimensions: number
  embed(texts: string[]): Promise<number[][]>
}

export type CollectionInfo = {
  name: string
  pointsCount: number | null
  healthy: boolean
}
