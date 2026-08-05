import type { EmbeddingProvider, ResolvedConfig } from "../types.js"
import { ApiEmbeddingProvider } from "./api.js"
import { NodeWorkerEmbeddingProvider } from "./node-worker.js"

export function createEmbeddingProvider(config: ResolvedConfig): EmbeddingProvider {
  if (config.embeddingProvider === "api") {
    return new ApiEmbeddingProvider({
      apiUrl: config.embeddingApiUrl,
      apiKey: config.embeddingApiKey!,
      model: config.embeddingModel,
      dimensions: config.embeddingDimensions,
    })
  }

  return new NodeWorkerEmbeddingProvider({
    command: config.localWorkerCommand,
    model: config.embeddingModel,
    dimensions: config.embeddingDimensions,
    batchSize: config.localEmbeddingBatchSize,
    dtype: config.localEmbeddingDtype,
  })
}
