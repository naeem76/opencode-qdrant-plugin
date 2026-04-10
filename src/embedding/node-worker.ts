import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import type { EmbeddingProvider } from "../types.js"

type NodeWorkerEmbeddingOptions = {
  command: string
  model: string
  dimensions: number
}

export class NodeWorkerEmbeddingProvider implements EmbeddingProvider {
  readonly name: string
  readonly dimensions: number

  constructor(private readonly options: NodeWorkerEmbeddingOptions) {
    this.name = `local-worker:${options.model}`
    this.dimensions = options.dimensions
  }

  async embed(texts: string[]) {
    if (texts.length === 0) {
      return []
    }

    const workerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../worker/embed-worker.mjs")
    const child = spawn(this.options.command, [workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
    })

    const stdout: Buffer[] = []
    const stderr: Buffer[] = []

    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)))

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject)
      child.on("close", resolve)
      child.stdin.end(
        JSON.stringify({
          model: this.options.model,
          texts,
        }),
      )
    })

    if (exitCode !== 0) {
      throw new Error(`Local embedding worker failed: ${Buffer.concat(stderr).toString("utf8")}`)
    }

    const json = JSON.parse(Buffer.concat(stdout).toString("utf8")) as { vectors: number[][] }
    if (!Array.isArray(json.vectors) || json.vectors.length !== texts.length) {
      throw new Error("Local embedding worker returned invalid output")
    }
    return json.vectors
  }
}
