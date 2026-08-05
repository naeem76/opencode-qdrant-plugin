import { tool } from "@opencode-ai/plugin"
import { minimatch } from "minimatch"
import { Indexer } from "./indexer.js"
import { QdrantWrapper } from "./qdrant.js"
import type { EmbeddingProvider, IndexingState, ResolvedConfig } from "./types.js"
import { truncate } from "./utils.js"

type ToolLogger = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => Promise<void>

/**
 * Format an indexing run's duration from its state. Returns null if the run
 * hasn't started or is still running and has no elapsed time yet.
 */
function formatDuration(state: IndexingState): string | null {
  if (state.startedAt === null) return null
  const end = state.completedAt ?? Date.now()
  const ms = end - state.startedAt
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds}s`
}

export function createTools(
  qdrant: QdrantWrapper,
  embeddings: EmbeddingProvider,
  indexer: Indexer,
  config: ResolvedConfig,
  log: ToolLogger,
) {
  return {
    qdrant_ping: tool({
      description: "Diagnostic tool to confirm the Qdrant plugin is loaded.",
      args: {},
      async execute(_args, context) {
        await log("info", "qdrant_ping invoked", {
          sessionID: context.sessionID,
          messageID: context.messageID,
        })
        context.metadata({ title: "Qdrant plugin ping" })
        const healthy = await qdrant.healthCheck()
        const output = [
          "opencode-qdrant plugin is loaded.",
          `Collection: ${qdrant.collectionName}`,
          `Provider: ${embeddings.name}`,
          `Qdrant healthy: ${healthy ? "yes" : "no"}`,
        ].join("\n")
        await log("info", "qdrant_ping completed", {
          sessionID: context.sessionID,
        })
        return output
      },
    }),
    codebase_search: tool({
      description:
        "Search the project codebase semantically. Use this to find relevant files, functions, classes, and code snippets from natural-language descriptions.",
      args: {
        query: tool.schema.string().min(1),
        limit: tool.schema.number().int().min(1).max(20).default(config.searchLimit),
        file_pattern: tool.schema.string().optional(),
        chunk_type: tool.schema.enum(["code", "summary"]).optional(),
      },
      async execute(args, context) {
        await log("info", "codebase_search invoked", {
          sessionID: context.sessionID,
          query: args.query,
          limit: args.limit,
          file_pattern: args.file_pattern,
          chunk_type: args.chunk_type,
        })
        context.metadata({ title: `Searching codebase: ${args.query}` })
        await qdrant.ensureCollection()
        const [vector] = await embeddings.embed([args.query])
        // When a file_pattern filter is applied client-side, over-fetch to
        // compensate for matches that the glob will discard. Qdrant keyword
        // filters can't express glob patterns, so we pull a larger pool and
        // trim. Cap the pool at 20x the requested limit to bound cost.
        const searchLimit = args.file_pattern ? Math.min(args.limit * 20, 200) : args.limit
        const results = await qdrant.search(vector, {
          limit: searchLimit,
          scoreThreshold: config.scoreThreshold,
          chunkType: args.chunk_type,
        })

        const filtered = args.file_pattern
          ? results.filter((result) => minimatch(result.payload.file_path, args.file_pattern!))
          : results

        const output = filtered.slice(0, args.limit)
        if (output.length === 0) {
          await log("info", "codebase_search completed with no results", {
            sessionID: context.sessionID,
            query: args.query,
          })
          return `No semantic matches found for \"${args.query}\".`
        }

        const response = [
          `Found ${output.length} result(s) for \"${args.query}\":`,
          ...output.map((result, index) => {
            const payload = result.payload
            const header = `${index + 1}. [${result.score.toFixed(2)}] ${payload.file_path}:${payload.start_line}-${payload.end_line} (${payload.language})${payload.chunk_type === "summary" ? " [summary]" : ""}`
            return `${header}\n${truncate(payload.content, 1200)}`
          }),
        ].join("\n\n")
        await log("info", "codebase_search completed", {
          sessionID: context.sessionID,
          query: args.query,
          results: output.length,
        })
        return response
      },
    }),
    index_status: tool({
      description: "Check the current semantic indexing status for this project.",
      args: {},
      async execute(_args, context) {
        await log("info", "index_status invoked", {
          sessionID: context.sessionID,
          messageID: context.messageID,
        })
        context.metadata({ title: "Qdrant index status" })
        const state = indexer.getState()
        const info = await qdrant.getCollectionInfo()
        const lines = [
          `Status: ${state.status}`,
          `Collection: ${state.collectionName}`,
          `Provider: ${state.provider}`,
          `Files: ${state.processedFiles}/${state.totalFiles} processed, ${state.skippedFiles} skipped`,
          `Chunks indexed this run: ${state.totalChunks}`,
          `Collection points: ${info.pointsCount ?? "unknown"}`,
          `Healthy: ${info.healthy ? "yes" : "no"}`,
          `Errors: ${state.errorCount}`,
        ]
        const durationMs = formatDuration(state)
        if (durationMs !== null) {
          lines.push(`Duration: ${durationMs}`)
        }
        const output = lines.join("\n")
        await log("info", "index_status completed", {
          sessionID: context.sessionID,
          status: state.status,
          processedFiles: state.processedFiles,
          totalFiles: state.totalFiles,
          healthy: info.healthy,
          points: info.pointsCount,
        })
        return output
      },
    }),
    reindex: tool({
      description: "Trigger semantic re-indexing of the project. By default this runs incrementally.",
      args: {
        full: tool.schema.boolean().default(false),
      },
      async execute(args, context) {
        await log("info", "reindex invoked", {
          sessionID: context.sessionID,
          full: args.full,
        })
        context.metadata({ title: args.full ? "Starting full reindex" : "Starting incremental reindex" })
        if (args.full) {
          indexer.startFull()
          await log("info", "reindex started", {
            sessionID: context.sessionID,
            full: true,
          })
          return "Started full re-index in the background."
        }
        indexer.startIncremental()
        await log("info", "reindex started", {
          sessionID: context.sessionID,
          full: false,
        })
        return "Started incremental re-index in the background."
      },
    }),
  }
}
