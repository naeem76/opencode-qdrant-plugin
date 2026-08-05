/**
 * Long-running local embedding worker.
 *
 * Protocol: newline-delimited JSON over stdin/stdout.
 *   Request:  {"id":1,"model":"Xenova/all-MiniLM-L6-v2","texts":["..."]}
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

/** Cache of model name -> pipeline promise (loaded once, reused). */
const extractors = new Map()

async function getExtractor(model) {
  if (!extractors.has(model)) {
    extractors.set(model, pipeline("feature-extraction", model))
  }
  return extractors.get(model)
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

for await (const line of rl) {
  if (!line.trim()) continue
  let id = null
  try {
    const req = JSON.parse(line)
    id = req.id
    const extractor = await getExtractor(req.model)
    const output = await extractor(req.texts, { pooling: "mean", normalize: true })
    process.stdout.write(JSON.stringify({ id, vectors: output.tolist() }) + "\n")
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ id, error: error instanceof Error ? error.message : String(error) }) + "\n",
    )
  }
}