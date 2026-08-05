import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { fileURLToPath } from "node:url"
import readline from "node:readline"
import path from "node:path"
import type { EmbeddingProvider, LocalEmbeddingDtype } from "../types.js"

type NodeWorkerEmbeddingOptions = {
  command: string
  model: string
  dimensions: number
  batchSize: number
  dtype: LocalEmbeddingDtype
}

type Pending = {
  resolve: (vectors: number[][]) => void
  reject: (err: Error) => void
}

/**
 * Embedding provider backed by a single long-running child process.
 *
 * The worker (`worker/embed-worker.mjs`) loads the transformers.js pipeline
 * once and then serves newline-delimited JSON requests over stdin/stdout.
 * This eliminates the per-call process startup + model-load cost that the
 * previous spawn-per-embed design paid on every file.
 *
 * Multiple concurrent `embed()` calls are multiplexed by a monotonically
 * increasing request id; the worker processes them sequentially but the
 * parent can pipeline file I/O and Qdrant upserts in parallel.
 */
export class NodeWorkerEmbeddingProvider implements EmbeddingProvider {
  readonly name: string
  readonly dimensions: number

  private readonly workerPath: string
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1

  constructor(private readonly options: NodeWorkerEmbeddingOptions) {
    this.name = `local-worker:${options.model}:${options.dtype}`
    this.dimensions = options.dimensions
    this.workerPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../worker/embed-worker.mjs",
    )
  }

  private ensureChild(): void {
    if (this.child) return

    const child = spawn(this.options.command, [this.workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
    })

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
    rl.on("line", (line) => this.handleLine(line))

    child.on("error", (err) => this.failAll(err))
    child.on("close", (code) => {
      // Reject any still-pending requests; the worker won't answer them.
      if (this.pending.size > 0) {
        this.failAll(new Error(`Local embedding worker exited (code ${code})`))
      }
      this.child = null
    })

    this.child = child
  }

  private handleLine(line: string): void {
    try {
      const msg = JSON.parse(line) as { id?: number; vectors?: number[][]; error?: string }
      const id = msg.id
      if (id === undefined) return
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      if (msg.error) {
        pending.reject(new Error(msg.error))
      } else if (Array.isArray(msg.vectors)) {
        pending.resolve(msg.vectors)
      } else {
        pending.reject(new Error("Local embedding worker returned invalid output"))
      }
    } catch {
      // Ignore malformed lines — keeps the worker alive on a bad message.
    }
  }

  private failAll(err: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(err)
    }
    this.pending.clear()
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return []
    }

    this.ensureChild()
    if (!this.child?.stdin.writable) {
      throw new Error("Local embedding worker is not running")
    }

    const id = this.nextId++
    const promise = new Promise<number[][]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })

    this.child.stdin.write(
      `${JSON.stringify({
        id,
        model: this.options.model,
        texts,
        batchSize: this.options.batchSize,
        dtype: this.options.dtype,
      })}\n`,
    )

    const vectors = await promise
    if (vectors.length !== texts.length) {
      throw new Error("Local embedding worker returned an unexpected number of vectors")
    }
    return vectors
  }

  dispose(): void {
    const child = this.child
    this.child = null
    if (!child) return
    this.failAll(new Error("Local embedding worker disposed"))
    child.stdin.end()
    child.kill()
  }
}
