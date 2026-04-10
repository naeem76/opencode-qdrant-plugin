import type { Plugin } from "@opencode-ai/plugin"
import { resolveConfig } from "./config.js"
import { createEmbeddingProvider } from "./embedding/index.js"
import { Indexer } from "./indexer.js"
import { QdrantWrapper } from "./qdrant.js"
import { writeStatusFile } from "./status-file.js"
import { createTools } from "./tools.js"
import { collectionNameForProject } from "./utils.js"
import type { PluginOptions } from "./types.js"

export const server: Plugin = async (input, rawOptions) => {
  const options = resolveConfig(rawOptions as PluginOptions | undefined)
  const collectionName =
    options.collectionName ?? collectionNameForProject(input.directory, options.embeddingDimensions)
  const qdrant = new QdrantWrapper(options.qdrantUrl, collectionName, options.embeddingDimensions)
  const embeddings = createEmbeddingProvider(options)
  const indexer = new Indexer(input.directory, qdrant, embeddings, options, async (state) => {
    await writeStatusFile(input.directory, state)
  })
  const log = async (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>,
  ) => {
    await input.client.app.log({
      body: {
        service: "opencode-qdrant",
        level,
        message,
        extra,
      },
    })
  }

  const healthy = await qdrant.healthCheck()
  if (healthy) {
    await qdrant.ensureCollection()
    if (options.indexOnStart) {
      indexer.startIncremental()
    }
    await log("info", `Initialized Qdrant index ${collectionName}`)
  } else {
    await log("warn", `Qdrant unavailable at ${options.qdrantUrl}. Plugin loaded in degraded mode.`)
  }

  await writeStatusFile(input.directory, indexer.getState())

  return {
    tool: createTools(qdrant, embeddings, indexer, options, log),
    event: async ({ event }) => {
      if (event.type === "session.created" && options.indexOnStart && !indexer.isRunning()) {
        if (await qdrant.healthCheck()) {
          indexer.startIncremental()
        }
      }
    },
  }
}
