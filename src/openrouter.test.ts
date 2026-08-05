import { describe, expect, test } from "bun:test"
import {
  getOpenRouterApiKey,
  listOpenRouterEmbeddingModels,
  probeOpenRouterDimensions,
  selectRecommendedFreeModel,
} from "./openrouter.js"

describe("OpenRouter integration", () => {
  test("reads the conventional environment variable without exposing it elsewhere", () => {
    expect(getOpenRouterApiKey({ OPENROUTER_API_KEY: " secret " })).toBe("secret")
    expect(getOpenRouterApiKey({})).toBeNull()
  })

  test("discovers, classifies, and recommends free models", async () => {
    const models = await listOpenRouterEmbeddingModels("key", async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "paid/model", name: "Paid", pricing: { prompt: "0.01" } },
            {
              id: "nvidia/nemotron-3-embed-1b:free",
              name: "Nemotron",
              context_length: 32768,
              pricing: { prompt: "0" },
            },
          ],
        }),
        { status: 200 },
      ),
    )
    expect(models).toHaveLength(2)
    expect(selectRecommendedFreeModel(models)?.id).toBe("nvidia/nemotron-3-embed-1b:free")
    expect(selectRecommendedFreeModel(models)?.knownDimensions).toBe(2048)
  })

  test("probes actual output dimensions", async () => {
    const dimensions = await probeOpenRouterDimensions("key", "model", undefined, async (_url, init) => {
      expect(JSON.parse(String(init?.body)).dimensions).toBeUndefined()
      return new Response(
        JSON.stringify({ data: [{ embedding: Array.from({ length: 2048 }, () => 0.1) }] }),
        { status: 200 },
      )
    })
    expect(dimensions).toBe(2048)
  })
})
