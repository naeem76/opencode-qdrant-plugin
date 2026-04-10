import type { PluginOptions, ResolvedConfig } from "./types.js"

export function resolveConfig(options?: PluginOptions): ResolvedConfig {
  if (!options?.qdrantUrl) {
    throw new Error("Missing required plugin option: qdrantUrl")
  }

  const embeddingProvider = options.embeddingProvider ?? "local"
  const embeddingModel =
    options.embeddingModel ??
    (embeddingProvider === "api" ? "text-embedding-3-small" : "Xenova/all-MiniLM-L6-v2")
  const embeddingDimensions =
    options.embeddingDimensions ?? (embeddingProvider === "api" ? 1536 : 384)

  if (embeddingProvider === "api" && !options.embeddingApiKey) {
    throw new Error("embeddingApiKey is required when embeddingProvider is 'api'")
  }

  return {
    qdrantUrl: options.qdrantUrl,
    embeddingProvider,
    embeddingModel,
    embeddingApiKey: options.embeddingApiKey,
    embeddingApiUrl: options.embeddingApiUrl ?? "https://api.openai.com/v1",
    embeddingDimensions,
    maxFileSize: options.maxFileSize ?? 100_000,
    chunkMaxLines: options.chunkMaxLines ?? 80,
    chunkOverlapLines: options.chunkOverlapLines ?? 10,
    excludePatterns: options.excludePatterns ?? [],
    includePatterns: options.includePatterns,
    searchLimit: options.searchLimit ?? 10,
    scoreThreshold: options.scoreThreshold ?? 0.3,
    collectionName: options.collectionName,
    batchSize: options.batchSize ?? 50,
    indexOnStart: options.indexOnStart ?? true,
    localWorkerCommand: options.localWorkerCommand ?? "node",
  }
}
