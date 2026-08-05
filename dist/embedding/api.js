import { HttpRetryableError, isRetryableHttpStatus, isTransientNetworkError, retryAsync, } from "../retry.js";
/** Max texts per embedding request — keeps requests under provider token limits. */
const API_BATCH_SIZE = 100;
export class ApiEmbeddingProvider {
    options;
    name;
    dimensions;
    constructor(options) {
        this.options = options;
        this.name = `api:${options.model}`;
        this.dimensions = options.dimensions;
    }
    async embed(texts) {
        if (texts.length === 0) {
            return [];
        }
        const vectors = [];
        for (let index = 0; index < texts.length; index += API_BATCH_SIZE) {
            const batch = texts.slice(index, index + API_BATCH_SIZE);
            const batchVectors = await retryAsync(async () => {
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
                });
                if (!response.ok) {
                    if (isRetryableHttpStatus(response.status)) {
                        throw new HttpRetryableError(response.status);
                    }
                    throw new Error(`Embedding API failed with ${response.status}`);
                }
                const json = (await response.json());
                const result = json.data?.map((item) => item.embedding) ?? [];
                if (result.length !== batch.length) {
                    throw new Error("Embedding API returned an unexpected number of vectors");
                }
                return result;
            }, (err) => err instanceof HttpRetryableError || isTransientNetworkError(err));
            vectors.push(...batchVectors);
        }
        if (vectors.length !== texts.length) {
            throw new Error("Embedding API returned an unexpected number of vectors");
        }
        return vectors;
    }
}
