import { ApiEmbeddingProvider } from "./api.js";
import { NodeWorkerEmbeddingProvider } from "./node-worker.js";
export function createEmbeddingProvider(config) {
    if (config.embeddingProvider !== "local") {
        if (!config.embeddingApiKey) {
            throw new Error(`Missing API key for embedding provider '${config.embeddingProvider}'`);
        }
        return new ApiEmbeddingProvider({
            apiUrl: config.embeddingApiUrl,
            apiKey: config.embeddingApiKey,
            model: config.embeddingModel,
            dimensions: config.embeddingDimensions,
            provider: config.embeddingProvider,
            sendDimensions: config.embeddingApiSendDimensions,
            headers: config.embeddingProvider === "openrouter"
                ? {
                    "HTTP-Referer": "https://github.com/naeem76/opencode-qdrant-plugin",
                    "X-OpenRouter-Title": "OpenCode Qdrant",
                }
                : undefined,
            extraBody: config.embeddingProvider === "openrouter"
                ? {
                    provider: {
                        data_collection: config.openrouterDataCollection,
                        zdr: config.openrouterZdr,
                    },
                }
                : undefined,
        });
    }
    return new NodeWorkerEmbeddingProvider({
        command: config.localWorkerCommand,
        model: config.embeddingModel,
        dimensions: config.embeddingDimensions,
        batchSize: config.localEmbeddingBatchSize,
        dtype: config.localEmbeddingDtype,
    });
}
