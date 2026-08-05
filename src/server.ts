import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { resolveConfig } from "./config.js"
import { createEmbeddingProvider } from "./embedding/index.js"
import { Indexer } from "./indexer.js"
import { QdrantWrapper } from "./qdrant.js"
import { consumeReindexTrigger, writeStatusFile } from "./status-file.js"
import { createTools } from "./tools.js"
import { startFileWatcher, type FileWatcher } from "./watcher.js"
import { collectionNameForProject } from "./utils.js"
import type { IndexingState, PluginOptions } from "./types.js"

const server: Plugin = async (input, rawOptions) => {
  const options = resolveConfig(rawOptions as PluginOptions | undefined)
  const collectionName =
    options.collectionName ?? collectionNameForProject(input.directory, options.embeddingDimensions)
  const qdrant = new QdrantWrapper(options.qdrantUrl, collectionName, options.embeddingDimensions)
  const embeddings = createEmbeddingProvider(options)

  const toast = async (
    message: string,
    variant: "info" | "success" | "warning" | "error" = "info",
    duration = 5000,
  ) => {
    try {
      await input.client.tui.showToast({
        body: { title: "Qdrant", message, variant, duration },
      })
    } catch {
      // TUI may not be connected yet during startup — silently ignore
    }
  }

  let lastToastStatus: IndexingState["status"] | null = null

  const indexer = new Indexer(input.directory, qdrant, embeddings, options, async (state) => {
    await writeStatusFile(input.directory, state)

    // Toast on status transitions only (not every progress tick)
    if (state.status !== lastToastStatus) {
      lastToastStatus = state.status
      switch (state.status) {
        case "discovering":
          await toast("Discovering files to index...", "info", 3000)
          break
        case "indexing":
          await toast(`Indexing ${state.totalFiles} files...`, "info", 4000)
          break
        case "complete":
          if (state.totalChunks === 0 && state.skippedFiles === state.processedFiles) {
            await toast(
              `Index up to date (${state.collectionPointCount ?? 0} chunks)`,
              "success",
              4000,
            )
          } else {
            await toast(
              `Indexed ${state.processedFiles} files (${state.totalChunks} chunks, ${state.skippedFiles} unchanged)`,
              "success",
              6000,
            )
          }
          break
        case "error":
          await toast(
            `Indexing finished with ${state.errorCount} error(s)`,
            "warning",
            8000,
          )
          break
      }
    }
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
    await writeStatusFile(input.directory, indexer.getState())
    if (options.indexOnStart) {
      indexer.startIncremental()
    }
    await log("info", `Initialized Qdrant index ${collectionName}`)
  } else {
    await log("warn", `Qdrant unavailable at ${options.qdrantUrl}. Plugin loaded in degraded mode.`)
    const state = indexer.getState()
    state.status = "unavailable"
    await writeStatusFile(input.directory, state)
  }

  // Poll for reindex trigger file written by TUI Ctrl+P command
  const triggerPollInterval = setInterval(async () => {
    try {
      const trigger = await consumeReindexTrigger(input.directory)
      if (trigger && !indexer.isRunning()) {
        await log("info", `Reindex triggered from TUI (full=${trigger.full})`)
        if (await qdrant.healthCheck()) {
          if (trigger.full) {
            indexer.startFull()
          } else {
            indexer.startIncremental()
          }
        } else {
          await toast("Qdrant unavailable — cannot reindex", "error")
        }
      }
    } catch {
      // ignore polling errors
    }
  }, 2000)

  // Watch the project tree and trigger a debounced incremental reindex
  // when files change. Skips binary / sensitive / generated paths and
  // SKIP_DIRS (.git, node_modules, dist, ...) so editor noise doesn't
  // fire constant reindexes.
  let fileWatcher: FileWatcher | null = null
  if (options.watchFiles && healthy) {
    fileWatcher = startFileWatcher({
      rootDirectory: input.directory,
      debounceMs: options.watchDebounceMs,
      onChange: async (paths) => {
        if (indexer.isRunning()) return
        if (!(await qdrant.healthCheck())) return
        await log("info", `Reindex triggered by file watcher (${paths.length} changed)`)
        indexer.startIncremental()
      },
    })
  }

  return {
    tool: createTools(qdrant, embeddings, indexer, options, log),
    event: async ({ event }) => {
      if (event.type === "session.created" && options.indexOnStart && !indexer.isRunning()) {
        if (await qdrant.healthCheck()) {
          indexer.startIncremental()
        }
      }
      if (event.type === "server.instance.disposed") {
        clearInterval(triggerPollInterval)
        fileWatcher?.close()
      }
    },
  }
}

// Named export for local dev wrappers
export { server }

// Default export — required by OpenCode v1 plugin format for npm/git distribution
const plugin: PluginModule & { id: string } = {
  id: "opencode-qdrant",
  server,
}

export default plugin
