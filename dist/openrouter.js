import { OPENROUTER_API_KEY_ENV, OPENROUTER_API_URL, OPENROUTER_FREE_MODEL, } from "./profiles.js";
const KNOWN_DIMENSIONS = {
    "nvidia/nemotron-3-embed-1b:free": 2048,
};
export function getOpenRouterApiKey(env = process.env) {
    return env[OPENROUTER_API_KEY_ENV]?.trim() || null;
}
export async function listOpenRouterEmbeddingModels(apiKey, fetchFn = fetch) {
    const response = await fetchFn(`${OPENROUTER_API_URL}/embeddings/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
        throw new Error(`OpenRouter model discovery failed with ${response.status}`);
    }
    const json = (await response.json());
    return (json.data ?? [])
        .filter((model) => Boolean(model.id))
        .map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        contextLength: model.context_length,
        free: model.id.endsWith(":free") || Number(model.pricing?.prompt ?? 1) === 0,
        knownDimensions: KNOWN_DIMENSIONS[model.id],
    }))
        .sort((a, b) => a.name.localeCompare(b.name));
}
export function selectRecommendedFreeModel(models) {
    const free = models.filter((model) => model.free);
    return free.find((model) => model.id === OPENROUTER_FREE_MODEL) ?? free[0] ?? null;
}
export async function probeOpenRouterDimensions(apiKey, model, requestedDimensions, fetchFn = fetch) {
    const response = await fetchFn(`${OPENROUTER_API_URL}/embeddings`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/naeem76/opencode-qdrant-plugin",
            "X-OpenRouter-Title": "OpenCode Qdrant",
        },
        body: JSON.stringify({
            model,
            input: ["dimension probe"],
            ...(requestedDimensions ? { dimensions: requestedDimensions } : {}),
        }),
    });
    if (!response.ok) {
        throw new Error(`OpenRouter model probe failed with ${response.status}`);
    }
    const json = (await response.json());
    const vector = json.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
        throw new Error("OpenRouter model probe returned an invalid vector");
    }
    return vector.length;
}
