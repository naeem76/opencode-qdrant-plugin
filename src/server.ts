import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { resolveConfig } from "./config.js"
import { readEmbeddingSettings } from "./embedding-settings.js"
import { appendErrorLog } from "./error-log.js"
import { IndexManager } from "./index-manager.js"
import { readStoredOpenRouterApiKey } from "./opencode-auth.js"
import { embeddingProfileFromConfig } from "./profiles.js"
import {
  consumeReindexTrigger,
  readStatusFile,
  writeStatusFile,
} from "./status-file.js"
import { createTools } from "./tools.js"
import { startFileWatcher, type FileWatcher } from "./watcher.js"
import type { IndexingState, PluginOptions } from "./types.js"

const server: Plugin = async (input, rawOptions) => {
  let credentialLoadedFromOpenCode = false
  const refreshStoredOpenRouterKey = async () => {
    if (!credentialLoadedFromOpenCode && process.env.OPENROUTER_API_KEY?.trim()) return
    const storedApiKey = await readStoredOpenRouterApiKey()
    if (storedApiKey) {
      process.env.OPENROUTER_API_KEY = storedApiKey
      credentialLoadedFromOpenCode = true
    }
  }
  await refreshStoredOpenRouterKey()
  const options = resolveConfig(rawOptions as PluginOptions | undefined)
  const settings = await readEmbeddingSettings(input.directory)
  const desiredProfile = settings?.desiredProfile ?? embeddingProfileFromConfig(options)

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

  const log = async (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>,
  ) => {
    try {
      await input.client.app.log({
        body: {
          service: "opencode-qdrant",
          level,
          message,
          extra,
        },
      })
    } catch {
      // OpenCode logging may be unavailable during teardown.
    }
    if (level === "warn" || level === "error") {
      await appendErrorLog({
        level,
        source: "opencode-qdrant",
        message,
        projectDirectory: input.directory,
        details: extra,
      }).catch(() => {})
    }
  }

  const persisted = await readStatusFile(input.directory)
  const manager = new IndexManager(
    input.directory,
    options,
    desiredProfile,
    persisted,
    async (state) => {
      await writeStatusFile(input.directory, state)

      if (state.status !== lastToastStatus) {
        lastToastStatus = state.status
        switch (state.status) {
          case "discovering":
            await toast("Discovering files to index...", "info", 3000)
            break
          case "indexing":
            await toast(`Indexing ${state.totalFiles} files...`, "info", 4000)
            break
          case "switching":
            await toast("Switching to the new embedding index...", "info", 5000)
            break
          case "rate_limited":
            await toast("Cloud embeddings are rate limited", "warning", 8000)
            break
          case "complete":
            await toast(
              `Index ready (${state.collectionPointCount ?? 0} chunks)`,
              "success",
              4000,
            )
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
    },
    log,
    settings?.fallbackToLocalOnRateLimit ?? false,
  )

  let fileWatcher: FileWatcher | null = null
  const ensureWatcher = () => {
    if (fileWatcher || !options.watchFiles || !manager.hasActiveIndex()) return
    fileWatcher = startFileWatcher({
      rootDirectory: input.directory,
      debounceMs: options.watchDebounceMs,
      onChange: async (paths) => {
        if (!(await manager.healthCheck())) return
        await log("info", `Reindex triggered by file watcher (${paths.length} changed)`)
        manager.startIncremental()
      },
    })
  }

  const healthy = await manager.initialize()
  if (healthy) {
    const active = manager.getActiveInfo()
    await log("info", `Initialized Qdrant index ${active.collectionName}`)
    ensureWatcher()
  } else {
    await log("warn", `Qdrant unavailable at ${options.qdrantUrl}. Plugin loaded in degraded mode.`)
  }

  // Poll for reindex trigger file written by TUI Ctrl+P command
  const triggerPollInterval = setInterval(async () => {
    try {
      const trigger = await consumeReindexTrigger(input.directory)
      if (trigger) {
        if (trigger.action === "settings") {
          await refreshStoredOpenRouterKey()
          const nextSettings = await readEmbeddingSettings(input.directory)
          if (nextSettings) {
            await log("info", "Embedding provider switch triggered from TUI", {
              provider: nextSettings.desiredProfile.provider,
              model: nextSettings.desiredProfile.model,
            })
            await manager.initialize()
            void manager.switchTo(nextSettings.desiredProfile, "user_requested")
          }
          return
        }
        await log("info", `Reindex triggered from TUI (full=${trigger.full})`)
        if (await manager.initialize()) {
          ensureWatcher()
          if (trigger.full) {
            manager.startFull()
          } else {
            manager.startIncremental()
          }
        } else {
          if (trigger.full) manager.startFull()
          else manager.startIncremental()
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
  return {
    tool: createTools(manager, options, log),
    event: async ({ event }) => {
      if (event.type === "session.created") {
        if (await manager.initialize()) {
          ensureWatcher()
        }
        if (options.indexOnStart && !manager.isRunning() && manager.hasActiveIndex()) {
          manager.startIncremental()
        }
      }
      if (event.type === "server.instance.disposed") {
        clearInterval(triggerPollInterval)
        fileWatcher?.close()
        await manager.dispose()
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
