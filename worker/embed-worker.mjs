import process from "node:process"
import { pipeline } from "@xenova/transformers"

const stdin = await new Promise((resolve, reject) => {
  const chunks = []
  process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
  process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
  process.stdin.on("error", reject)
})

try {
  const input = JSON.parse(stdin)
  const extractor = await pipeline("feature-extraction", input.model)
  const output = await extractor(input.texts, { pooling: "mean", normalize: true })
  process.stdout.write(JSON.stringify({ vectors: output.tolist() }))
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
