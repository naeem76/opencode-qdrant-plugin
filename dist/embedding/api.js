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
        const response = await fetch(new URL("/embeddings", this.options.apiUrl), {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.options.apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: this.options.model,
                input: texts,
                dimensions: this.options.dimensions,
            }),
        });
        if (!response.ok) {
            throw new Error(`Embedding API failed with ${response.status}`);
        }
        const json = (await response.json());
        const vectors = json.data?.map((item) => item.embedding) ?? [];
        if (vectors.length !== texts.length) {
            throw new Error("Embedding API returned an unexpected number of vectors");
        }
        return vectors;
    }
}
