import { tool } from "@opencode-ai/plugin";
import { minimatch } from "minimatch";
import { truncate } from "./utils.js";
export function createTools(qdrant, embeddings, indexer, config, log) {
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
                const output = [
                    "opencode-qdrant plugin is loaded.",
                    `Collection: ${qdrant.collectionName}`,
                    `Provider: ${embeddings.name}`,
                    `Qdrant healthy: ${qdrant.isHealthy() ? "yes" : "no"}`,
                ].join("\n");
                await log("info", "qdrant_ping completed", {
                    sessionID: context.sessionID,
                });
                return output;
            },
        }),
        codebase_search: tool({
            description: "Search the project codebase semantically. Use this to find relevant files, functions, classes, and code snippets from natural-language descriptions.",
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
                await qdrant.ensureCollection();
                const [vector] = await embeddings.embed([args.query]);
                const results = await qdrant.search(vector, {
                    limit: args.limit * (args.file_pattern ? 3 : 1),
                    scoreThreshold: config.scoreThreshold,
                    chunkType: args.chunk_type,
                });
                const filtered = args.file_pattern
                    ? results.filter((result) => minimatch(result.payload.file_path, args.file_pattern))
                    : results;
                const output = filtered.slice(0, args.limit);
                if (output.length === 0) {
                    await log("info", "codebase_search completed with no results", {
                        sessionID: context.sessionID,
                        query: args.query,
                    });
                    return `No semantic matches found for \"${args.query}\".`;
                }
                const response = [
                    `Found ${output.length} result(s) for \"${args.query}\":`,
                    ...output.map((result, index) => {
                        const payload = result.payload;
                        const header = `${index + 1}. [${result.score.toFixed(2)}] ${payload.file_path}:${payload.start_line}-${payload.end_line} (${payload.language})${payload.chunk_type === "summary" ? " [summary]" : ""}`;
                        return `${header}\n${truncate(payload.content, 1200)}`;
                    }),
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
                const state = indexer.getState();
                const info = await qdrant.getCollectionInfo();
                const output = [
                    `Status: ${state.status}`,
                    `Collection: ${state.collectionName}`,
                    `Provider: ${state.provider}`,
                    `Files: ${state.processedFiles}/${state.totalFiles} processed, ${state.skippedFiles} skipped`,
                    `Chunks indexed this run: ${state.totalChunks}`,
                    `Collection points: ${info.pointsCount ?? "unknown"}`,
                    `Healthy: ${info.healthy ? "yes" : "no"}`,
                    `Errors: ${state.errorCount}`,
                ].join("\n");
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
                if (args.full) {
                    indexer.startFull();
                    await log("info", "reindex started", {
                        sessionID: context.sessionID,
                        full: true,
                    });
                    return "Started full re-index in the background.";
                }
                indexer.startIncremental();
                await log("info", "reindex started", {
                    sessionID: context.sessionID,
                    full: false,
                });
                return "Started incremental re-index in the background.";
            },
        }),
    };
}
