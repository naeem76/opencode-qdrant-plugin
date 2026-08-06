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
                    "X-Title": "OpenCode Qdrant",
                    // Cache identical embedding requests at OpenRouter (zero cost on hit).
                    "X-OpenRouter-Cache": "true",
                }
                : undefined,
            extraBody: config.embeddingProvider === "openrouter" &&
                (config.openrouterDataCollection === "deny" || config.openrouterZdr)
                ? {
                    provider: {
                        ...(config.openrouterDataCollection === "deny"
                            ? { data_collection: "deny" }
                            : {}),
                        ...(config.openrouterZdr ? { zdr: true } : {}),
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
