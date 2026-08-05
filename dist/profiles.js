import { projectKey } from "./paths.js";
import { sha256 } from "./utils.js";
export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
export const OPENROUTER_FREE_MODEL = "nvidia/nemotron-3-embed-1b:free";
export function embeddingProfileFromConfig(config) {
    const provider = config.embeddingProvider;
    if (provider === "local") {
        return {
            version: 1,
            provider,
            tier: "local",
            model: config.embeddingModel,
            dimensions: config.embeddingDimensions,
            dtype: config.localEmbeddingDtype,
        };
    }
    return {
        version: 1,
        provider,
        tier: provider === "openrouter"
            ? config.embeddingModel.endsWith(":free")
                ? "free"
                : "paid"
            : "custom",
        model: config.embeddingModel,
        dimensions: config.embeddingDimensions,
        apiUrl: config.embeddingApiUrl,
        apiKeyEnv: config.embeddingApiKeyEnv,
        sendDimensions: config.embeddingApiSendDimensions,
    };
}
export function defaultLocalProfile(config) {
    return {
        version: 1,
        provider: "local",
        tier: "local",
        model: "Xenova/all-MiniLM-L6-v2",
        dimensions: 384,
        dtype: config.localEmbeddingDtype,
    };
}
export function configForEmbeddingProfile(base, profile) {
    const apiKeyEnv = profile.apiKeyEnv;
    const embeddingApiKey = profile.provider === "local"
        ? undefined
        : apiKeyEnv
            ? process.env[apiKeyEnv]?.trim() || undefined
            : base.embeddingApiKey;
    if (profile.provider !== "local" && !embeddingApiKey) {
        throw new Error(`Missing embedding API key environment variable '${apiKeyEnv ?? "(unset)"}'`);
    }
    return {
        ...base,
        embeddingProvider: profile.provider,
        embeddingModel: profile.model,
        embeddingDimensions: profile.dimensions,
        embeddingApiUrl: profile.apiUrl ?? base.embeddingApiUrl,
        embeddingApiKeyEnv: apiKeyEnv,
        embeddingApiKey,
        embeddingApiSendDimensions: profile.sendDimensions ?? base.embeddingApiSendDimensions,
        localEmbeddingDtype: profile.dtype ?? base.localEmbeddingDtype,
    };
}
export function profileFingerprint(profile) {
    const canonical = JSON.stringify({
        version: profile.version,
        provider: profile.provider,
        tier: profile.tier,
        model: profile.model,
        dimensions: profile.dimensions,
        apiUrl: profile.apiUrl ?? null,
        apiKeyEnv: profile.apiKeyEnv ?? null,
        sendDimensions: profile.sendDimensions ?? null,
        dtype: profile.dtype ?? null,
    });
    return sha256(canonical).slice(0, 12);
}
export function activeAliasForProject(directory) {
    return `opencode_${projectKey(directory)}_active`;
}
export function generationCollectionName(directory, profile, generationId) {
    return `opencode_${projectKey(directory)}_g_${profileFingerprint(profile)}_${generationId}`;
}
export function createGeneration(directory, profile, now = Date.now()) {
    const id = now.toString(36);
    return {
        id,
        collectionName: generationCollectionName(directory, profile, id),
        profile,
        profileFingerprint: profileFingerprint(profile),
        createdAt: now,
    };
}
