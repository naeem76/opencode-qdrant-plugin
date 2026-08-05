import { tool } from "@opencode-ai/plugin";
import { minimatch } from "minimatch";
import { truncate } from "./utils.js";
/**
 * Format an indexing run's duration from its state. Returns null if the run
 * hasn't started or is still running and has no elapsed time yet.
 */
function formatDuration(state) {
    if (state.startedAt === null)
        return null;
    const end = state.completedAt ?? Date.now();
    const ms = end - state.startedAt;
    if (ms < 1000)
        return `${ms}ms`;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
}
export function createTools(manager, config, log) {
    return {
        qdrant_ping: tool({
            description: "Diagnostic tool to confirm the Qdrant plugin is loaded.",
            args: {},
            async execute(_args, context) {
                await log("info", "qdrant_ping invoked", {
                    sessionID: context.sessionID,
                    messageID: context.messageID,
                });
                context.metadata({ title: "Qdrant plugin ping" });
                const healthy = await manager.initialize();
                const active = manager.hasActiveIndex() ? manager.getActiveInfo() : null;
                const state = manager.getState();
                const output = [
                    "opencode-qdrant plugin is loaded.",
                    `Collection: ${active?.collectionName ?? state.collectionName}`,
                    `Provider: ${active?.provider ?? state.provider}`,
                    `Qdrant healthy: ${healthy ? "yes" : "no"}`,
                ].join("\n");
                await log("info", "qdrant_ping completed", {
                    sessionID: context.sessionID,
                });
                return output;
            },
        }),
        codebase_search: tool({
            description: "Search the project codebase semantically. Use this to find relevant files, functions, classes, and code snippets from natural-language descriptions. Returns a human-readable result list followed by a ```json block containing machine-readable results with {file, startLine, endLine, language, chunkType, score, content} per match — prefer parsing the JSON block when post-processing results.",
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
                });
                context.metadata({ title: `Searching codebase: ${args.query}` });
                if (!(await manager.initialize())) {
                    throw new Error("Qdrant is unavailable; semantic search cannot run");
                }
                // When a file_pattern filter is applied client-side, over-fetch to
                // compensate for matches that the glob will discard. Qdrant keyword
                // filters can't express glob patterns, so we pull a larger pool and
                // trim. Cap the pool at 20x the requested limit to bound cost.
                const searchLimit = args.file_pattern ? Math.min(args.limit * 20, 200) : args.limit;
                const results = await manager.embedAndSearch(args.query, {
                    limit: searchLimit,
                    scoreThreshold: config.scoreThreshold,
                    chunkType: args.chunk_type,
                });
                const filePattern = args.file_pattern;
                const filtered = filePattern
                    ? results.filter((result) => minimatch(result.payload.file_path, filePattern))
                    : results;
                const output = filtered.slice(0, args.limit);
                if (output.length === 0) {
                    await log("info", "codebase_search completed with no results", {
                        sessionID: context.sessionID,
                        query: args.query,
                    });
                    return `No semantic matches found for "${args.query}".`;
                }
                const structured = output.map((result) => ({
                    file: result.payload.file_path,
                    startLine: result.payload.start_line,
                    endLine: result.payload.end_line,
                    language: result.payload.language,
                    chunkType: result.payload.chunk_type,
                    score: Number(result.score.toFixed(4)),
                    content: truncate(result.payload.content, 1200),
                }));
                const response = [
                    `Found ${output.length} result(s) for "${args.query}":`,
                    ...output.map((result, index) => {
                        const payload = result.payload;
                        const header = `${index + 1}. [${result.score.toFixed(2)}] ${payload.file_path}:${payload.start_line}-${payload.end_line} (${payload.language})${payload.chunk_type === "summary" ? " [summary]" : ""}`;
                        return `${header}\n${truncate(payload.content, 1200)}`;
                    }),
                    "",
                    "```json",
                    JSON.stringify(structured),
                    "```",
                ].join("\n\n");
                await log("info", "codebase_search completed", {
                    sessionID: context.sessionID,
                    query: args.query,
                    results: output.length,
                });
                return response;
            },
        }),
        index_status: tool({
            description: "Check the current semantic indexing status for this project.",
            args: {},
            async execute(_args, context) {
                await log("info", "index_status invoked", {
                    sessionID: context.sessionID,
                    messageID: context.messageID,
                });
                context.metadata({ title: "Qdrant index status" });
                const state = manager.getState();
                const info = await manager.getCollectionInfo();
                const lines = [
                    `Status: ${state.status}`,
                    `Collection: ${state.collectionName}`,
                    `Provider: ${state.provider}`,
                    `Files: ${state.processedFiles}/${state.totalFiles} processed, ${state.skippedFiles} skipped`,
                    `Chunks indexed this run: ${state.totalChunks}`,
                    `Collection points: ${info.pointsCount ?? "unknown"}`,
                    `Healthy: ${info.healthy ? "yes" : "no"}`,
                    `Errors: ${state.errorCount}`,
                ];
                const durationMs = formatDuration(state);
                if (durationMs !== null) {
                    lines.push(`Duration: ${durationMs}`);
                }
                if (state.deployment) {
                    const deployment = state.deployment;
                    lines.push(`Deployment: ${deployment.phase}`);
                    if (deployment.active) {
                        lines.push(`  Active: ${deployment.active.profile.provider}/${deployment.active.profile.model} (${deployment.active.profile.dimensions}d)`);
                    }
                    if (deployment.staging) {
                        lines.push(`  Building: ${deployment.staging.profile.provider}/${deployment.staging.profile.model} (${deployment.staging.profile.dimensions}d)`);
                        lines.push("  Search remains pinned to the active index");
                    }
                    if (deployment.switchReason)
                        lines.push(`  Reason: ${deployment.switchReason}`);
                    if (deployment.lastError)
                        lines.push(`  Switch error: ${deployment.lastError}`);
                }
                if (state.timings) {
                    const t = state.timings;
                    lines.push(`Timings:`);
                    lines.push(`  Discovery: ${t.discovery}ms`);
                    lines.push(`  Chunking: ${t.chunking}ms`);
                    lines.push(`  Embedding: ${t.embedding}ms (${t.totalChunks} chunks, ${t.batches} batches, ${Math.round(t.embedding / Math.max(t.batches, 1))}ms/batch)`);
                    lines.push(`  Upsert: ${t.upsert}ms`);
                    lines.push(`  Total measured: ${t.discovery + t.chunking + t.embedding + t.upsert}ms`);
                }
                const output = lines.join("\n");
                await log("info", "index_status completed", {
                    sessionID: context.sessionID,
                    status: state.status,
                    processedFiles: state.processedFiles,
                    totalFiles: state.totalFiles,
                    healthy: info.healthy,
                    points: info.pointsCount,
                });
                return output;
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
                });
                context.metadata({ title: args.full ? "Starting full reindex" : "Starting incremental reindex" });
                const healthy = await manager.initialize();
                if (args.full) {
                    manager.startFull();
                    await log("info", "reindex started", {
                        sessionID: context.sessionID,
                        full: true,
                    });
                    return healthy
                        ? "Started full re-index in the background."
                        : "Qdrant is unavailable; full re-index queued for recovery.";
                }
                manager.startIncremental();
                await log("info", "reindex started", {
                    sessionID: context.sessionID,
                    full: false,
                });
                return healthy
                    ? "Started incremental re-index in the background."
                    : "Qdrant is unavailable; incremental re-index queued for recovery.";
            },
        }),
    };
}
