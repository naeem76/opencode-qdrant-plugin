import type { EmbeddingProvider } from "../types.js"

type ApiEmbeddingOptions = {
  apiUrl: string
  apiKey: string
  model: string
  dimensions: number
}

/** Max texts per embedding request — keeps requests under provider token limits. */
const API_BATCH_SIZE = 100

export class ApiEmbeddingProvider implements EmbeddingProvider {
  readonly name: string
  readonly dimensions: number

  constructor(private readonly options: ApiEmbeddingOptions) {
    this.name = `api:${options.model}`
    this.dimensions = options.dimensions
  }

  async embed(texts: string[]) {
    if (texts.length === 0) {
      return []
    }

    const vectors: number[][] = []
    for (let index = 0; index < texts.length; index += API_BATCH_SIZE) {
      const batch = texts.slice(index, index + API_BATCH_SIZE)
      const response = await fetch(new URL("/embeddings", this.options.apiUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.options.model,
          input: batch,
          dimensions: this.options.dimensions,
        }),
      })

      if (!response.ok) {
        throw new Error(`Embedding API failed with ${response.status}`)
      }

      const json = (await response.json()) as { data?: Array<{ embedding: number[] }> }
      const batchVectors = json.data?.map((item) => item.embedding) ?? []
      if (batchVectors.length !== batch.length) {
        throw new Error("Embedding API returned an unexpected number of vectors")
      }
      vectors.push(...batchVectors)
    }

    if (vectors.length !== texts.length) {
      throw new Error("Embedding API returned an unexpected number of vectors")
    }
    return vectors
  }
}
