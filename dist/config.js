export function resolveConfig(options) {
    if (!options?.qdrantUrl) {
        throw new Error("Missing required plugin option: qdrantUrl");
    }
    const embeddingProvider = options.embeddingProvider ?? "local";
    const embeddingApiKeyEnv = options.embeddingApiKeyEnv ??
        (!options.embeddingApiKey && embeddingProvider === "openrouter"
            ? "OPENROUTER_API_KEY"
            : undefined);
    const embeddingApiKey = options.embeddingApiKey ??
        (embeddingApiKeyEnv ? process.env[embeddingApiKeyEnv] : undefined);
    const embeddingModel = options.embeddingModel ??
        (embeddingProvider === "openrouter"
            ? "nvidia/nemotron-3-embed-1b:free"
            : embeddingProvider === "api"
                ? "text-embedding-3-small"
                : "Xenova/all-MiniLM-L6-v2");
    const embeddingDimensions = options.embeddingDimensions ??
        (embeddingProvider === "openrouter" ? 2048 : embeddingProvider === "api" ? 1536 : 384);
    if (embeddingProvider !== "local" && !embeddingApiKey) {
        const source = embeddingApiKeyEnv
            ? ` or set environment variable '${embeddingApiKeyEnv}'`
            : "";
        throw new Error(`embeddingApiKey is required when embeddingProvider is '${embeddingProvider}'${source}`);
    }
    return {
        qdrantUrl: options.qdrantUrl,
        embeddingProvider,
        embeddingModel,
        embeddingApiKey,
        embeddingApiKeyEnv,
        embeddingApiUrl: options.embeddingApiUrl ??
            (embeddingProvider === "openrouter"
                ? "https://openrouter.ai/api/v1"
                : "https://api.openai.com/v1"),
        embeddingApiSendDimensions: options.embeddingApiSendDimensions ?? embeddingProvider !== "openrouter",
        embeddingDimensions,
        maxFileSize: options.maxFileSize ?? 100_000,
        chunkMaxLines: options.chunkMaxLines ?? 80,
        chunkOverlapLines: options.chunkOverlapLines ?? 10,
        excludePatterns: options.excludePatterns ?? [],
        includePatterns: options.includePatterns,
        searchLimit: options.searchLimit ?? 10,
        scoreThreshold: options.scoreThreshold ?? 0.3,
        collectionName: options.collectionName,
        concurrency: options.concurrency ?? 8,
        indexOnStart: options.indexOnStart ?? true,
        watchFiles: options.watchFiles ?? true,
        watchDebounceMs: options.watchDebounceMs ?? 2000,
        localEmbeddingBatchSize: options.localEmbeddingBatchSize ?? 16,
        localEmbeddingDtype: options.localEmbeddingDtype ?? "q8",
        openrouterDataCollection: options.openrouterDataCollection ?? "allow",
        openrouterZdr: options.openrouterZdr ?? false,
        localWorkerCommand: options.localWorkerCommand ?? "node",
    };
}
