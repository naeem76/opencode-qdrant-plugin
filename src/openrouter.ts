import {
  OPENROUTER_API_KEY_ENV,
  OPENROUTER_API_URL,
  OPENROUTER_FREE_MODEL,
} from "./profiles.js"

export type OpenRouterEmbeddingModel = {
  id: string
  name: string
  contextLength?: number
  free: boolean
  knownDimensions?: number
}

type FetchLike = typeof fetch

const KNOWN_DIMENSIONS: Record<string, number> = {
  "nvidia/nemotron-3-embed-1b:free": 2048,
}

export function getOpenRouterApiKey(env = process.env): string | null {
  return env[OPENROUTER_API_KEY_ENV]?.trim() || null
}

export async function listOpenRouterEmbeddingModels(
  apiKey: string,
  fetchFn: FetchLike = fetch,
): Promise<OpenRouterEmbeddingModel[]> {
  const response = await fetchFn(`${OPENROUTER_API_URL}/embeddings/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!response.ok) {
    throw new Error(`OpenRouter model discovery failed with ${response.status}`)
  }

  const json = (await response.json()) as {
    data?: Array<{
      id?: string
      name?: string
      context_length?: number
      pricing?: { prompt?: string }
    }>
  }

  return (json.data ?? [])
    .filter((model): model is typeof model & { id: string } => Boolean(model.id))
    .map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      contextLength: model.context_length,
      free: model.id.endsWith(":free") || Number(model.pricing?.prompt ?? 1) === 0,
      knownDimensions: KNOWN_DIMENSIONS[model.id],
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function selectRecommendedFreeModel(
  models: OpenRouterEmbeddingModel[],
): OpenRouterEmbeddingModel | null {
  const free = models.filter((model) => model.free)
  return free.find((model) => model.id === OPENROUTER_FREE_MODEL) ?? free[0] ?? null
}

export async function probeOpenRouterDimensions(
  apiKey: string,
  model: string,
  requestedDimensions?: number,
  fetchFn: FetchLike = fetch,
): Promise<number> {
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
  })
  if (!response.ok) {
    throw new Error(`OpenRouter model probe failed with ${response.status}`)
  }
  const json = (await response.json()) as { data?: Array<{ embedding?: number[] }> }
  const vector = json.data?.[0]?.embedding
  if (!Array.isArray(vector) || vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("OpenRouter model probe returned an invalid vector")
  }
  return vector.length
}
