export type EmbeddingProviderKind = "local" | "api" | "openrouter"
export type LocalEmbeddingDtype = "auto" | "q4" | "q8" | "fp32"
export type EmbeddingTier = "local" | "free" | "paid" | "custom"

export type PluginOptions = {
  qdrantUrl: string
  embeddingProvider?: EmbeddingProviderKind
  embeddingModel?: string
  embeddingApiKey?: string
  embeddingApiKeyEnv?: string
  embeddingApiUrl?: string
  embeddingApiSendDimensions?: boolean
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
  localEmbeddingBatchSize?: number
  localEmbeddingDtype?: LocalEmbeddingDtype
  openrouterDataCollection?: "allow" | "deny"
  openrouterZdr?: boolean
  localWorkerCommand?: string
}

export type ResolvedConfig = Required<
  Omit<
    PluginOptions,
    | "embeddingApiKey"
    | "embeddingApiKeyEnv"
    | "embeddingDimensions"
    | "collectionName"
    | "includePatterns"
  >
> & {
  embeddingApiKey?: string
  embeddingApiKeyEnv?: string
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
  | "switching"
  | "rate_limited"

export type EmbeddingProfile = {
  version: 1
  provider: EmbeddingProviderKind
  tier: EmbeddingTier
  model: string
  dimensions: number
  apiUrl?: string
  apiKeyEnv?: string
  sendDimensions?: boolean
  dtype?: LocalEmbeddingDtype
}

export type IndexGeneration = {
  id: string
  collectionName: string
  profile: EmbeddingProfile
  profileFingerprint: string
  createdAt: number
  activatedAt?: number
}

export type DeploymentPhase =
  | "ready"
  | "building"
  | "verifying"
  | "switching"
  | "cleanup"
  | "failed"

export type DeploymentState = {
  version: 1
  aliasName: string
  phase: DeploymentPhase
  active?: IndexGeneration
  staging?: IndexGeneration
  previous?: IndexGeneration
  /** Ready generations kept for same-model instant switch (one per fingerprint). */
  retained?: IndexGeneration[]
  switchReason?: "user_requested" | "rate_limit_fallback" | "model_unavailable"
  restartRequired?: boolean
  lastError?: string
}

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
  deployment?: DeploymentState
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
  dispose?(): Promise<void> | void
}

export type CollectionInfo = {
  name: string
  pointsCount: number | null
  healthy: boolean
}
