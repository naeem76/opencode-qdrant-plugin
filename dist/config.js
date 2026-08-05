export function resolveConfig(options) {
    if (!options?.qdrantUrl) {
        throw new Error("Missing required plugin option: qdrantUrl");
    }
    const embeddingProvider = options.embeddingProvider ?? "local";
    const embeddingModel = options.embeddingModel ??
        (embeddingProvider === "api" ? "text-embedding-3-small" : "Xenova/all-MiniLM-L6-v2");
    const embeddingDimensions = options.embeddingDimensions ?? (embeddingProvider === "api" ? 1536 : 384);
    if (embeddingProvider === "api" && !options.embeddingApiKey) {
        throw new Error("embeddingApiKey is required when embeddingProvider is 'api'");
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
        concurrency: options.concurrency ?? 8,
        indexOnStart: options.indexOnStart ?? true,
        watchFiles: options.watchFiles ?? true,
        watchDebounceMs: options.watchDebounceMs ?? 2000,
        localEmbeddingBatchSize: options.localEmbeddingBatchSize ?? 16,
        localEmbeddingDtype: options.localEmbeddingDtype ?? "q8",
        localWorkerCommand: options.localWorkerCommand ?? "node",
    };
}
