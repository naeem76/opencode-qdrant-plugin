/**
 * Long-running local embedding worker.
 *
 * Protocol: newline-delimited JSON over stdin/stdout.
 *   Request:  {"id":1,"model":"Xenova/all-MiniLM-L6-v2","texts":["..."],"batchSize":16,"dtype":"q8"}
 *   Response: {"id":1,"vectors":[[...],...]}
 *   Error:    {"id":1,"error":"..."}
 *
 * The pipeline is loaded once per model and cached, so subsequent requests
 * skip the (expensive) model-load step. The process stays alive until stdin
 * closes; the parent spawns it once and reuses it for every embed() call.
 */

import process from "node:process"
import readline from "node:readline"
import { pipeline } from "@huggingface/transformers"

/** Cache of model + dtype -> pipeline promise (loaded once, reused). */
const extractors = new Map()

async function getExtractor(model, dtype) {
  const key = `${model}:${dtype}`
  if (!extractors.has(key)) {
    const options = dtype === "auto" ? {} : { dtype }
    extractors.set(key, pipeline("feature-extraction", model, options))
  }
  return extractors.get(key)
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

for await (const line of rl) {
  if (!line.trim()) continue
  let id = null
  try {
    const req = JSON.parse(line)
    id = req.id
    const extractor = await getExtractor(req.model, req.dtype ?? "q8")
    const batchSize = Math.max(1, req.batchSize ?? 16)

    // ONNX pads every text in a batch to the longest sequence. Sorting by
    // length and using bounded micro-batches avoids one long code chunk
    // forcing hundreds of short chunks to pay the same padding cost.
    const sorted = req.texts
      .map((text, index) => ({ text, index }))
      .sort((a, b) => a.text.length - b.text.length)
    const vectors = new Array(req.texts.length)

    for (let start = 0; start < sorted.length; start += batchSize) {
      const items = sorted.slice(start, start + batchSize)
      const output = await extractor(
        items.map((item) => item.text),
        { pooling: "mean", normalize: true },
      )
      const batchVectors = output.tolist()
      for (let index = 0; index < items.length; index += 1) {
        vectors[items[index].index] = batchVectors[index]
      }
    }

    process.stdout.write(JSON.stringify({ id, vectors }) + "\n")
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ id, error: error instanceof Error ? error.message : String(error) }) + "\n",
    )
  }
}
