# Plan: Qdrant Semantic Indexing Plugin for OpenCode

Generated: 2026-04-10 | Steps: 10 | Parallel groups: 3
Reviewed: 2026-04-10 | Adversarial review passed (6 critical findings fixed)

## Overview

Build a local OpenCode plugin that semantically indexes project codebases using Qdrant vector database and provides search tools to AI agents. The plugin indexes git-tracked files on startup, supports incremental re-indexing, and exposes `codebase_search`, `index_status`, and `reindex` tools. A TUI component shows real-time indexing progress.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  OpenCode Server Plugin (server.ts)                             │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Plugin Init (onload)                                      │ │
│  │  - Validate config (Qdrant URL, embedding model)           │ │
│  │  - Health-check Qdrant connection                          │ │
│  │  - Create/verify per-project collection                    │ │
│  │  - Start background indexing                               │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐ │
│  │ Embedding     │  │ Chunker      │  │ File Discovery        │ │
│  │ Provider      │  │              │  │                       │ │
│  │ ┌──────────┐ │  │ Heuristic    │  │ git ls-files          │ │
│  │ │ Local    │ │  │ boundary     │  │ .gitignore respect    │ │
│  │ │ Xenova   │ │  │ detection    │  │ Content hashing       │ │
│  │ └──────────┘ │  │              │  │ (SHA-256)             │ │
│  │ ┌──────────┐ │  │ File-level   │  │                       │ │
│  │ │ API      │ │  │ summary      │  │ Change detection      │ │
│  │ │ OpenAI   │ │  │ extraction   │  │ via hash comparison   │ │
│  │ └──────────┘ │  │              │  │                       │ │
│  └──────────────┘  └──────────────┘  └───────────────────────┘ │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Indexer Engine                                            │ │
│  │  - Discover files → hash → diff against stored hashes     │ │
│  │  - Chunk changed files → batch embed → upsert to Qdrant   │ │
│  │  - Delete points for removed/renamed files                │ │
│  │  - Track progress: { total, indexed, skipped, errors }    │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Agent Tools                                               │ │
│  │  - codebase_search(query, limit?, file_pattern?)           │ │
│  │  - index_status()                                          │ │
│  │  - reindex(full?: boolean)                                 │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Qdrant Client Wrapper                                     │ │
│  │  - Collection: opencode_{project_hash}                     │ │
│  │  - Vectors: {size: 384|1536, distance: 'Cosine'}          │ │
│  │  - Payload indexes: file_path(keyword), language(keyword), │ │
│  │    chunk_type(keyword), content_hash(keyword)              │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  OpenCode TUI Plugin (tui.ts)                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Sidebar Slot: Indexing Status                             │ │
│  │  - "Indexing: 142/500 files (28%)"                         │ │
│  │  - "Index ready: 500 files, 3,241 chunks"                  │ │
│  │  - "Index error: Qdrant unreachable"                       │ │
│  └────────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Toast Notifications                                       │ │
│  │  - "Indexing started (500 files)"                          │ │
│  │  - "Indexing complete (3,241 chunks)"                      │ │
│  │  - "Qdrant connection failed"                              │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Design Decisions

1. **Embedding**: Configurable — local (Xenova/all-MiniLM-L6-v2, 384d, zero-config default) or API-based (OpenAI text-embedding-3-small, 1536d). Factory pattern selects provider based on config. **Bun compatibility validated in Step 1a before building embedding provider.**
2. **Chunking**: Heuristic boundary detection — splits at blank line sequences, function/class declarations, export statements. Falls back to fixed-size (~80 lines) when chunks exceed max size. Merges tiny chunks (<5 lines) with neighbors. Skip rules for generated/minified/vendor files.
3. **File summaries**: Each file gets a separate "summary" embedding from its first ~20 lines (imports/declarations) for "which file does X?" queries.
4. **Incremental indexing**: SHA-256 hash stored per file in Qdrant payload. On re-index, compare hashes to skip unchanged files. **Atomic replacement: upsert new points first, then delete old points** (never delete before upsert succeeds).
5. **Collection naming**: `opencode_{sha256(project_path)[:12]}` — deterministic, collision-resistant, human-debuggable. **Collection includes vector dimension in name** (`opencode_{hash}_{dim}`) to handle dimension migration.
6. **Local plugin**: Lives in project's `.opencode/plugins/opencode-qdrant/` directory. Can be extracted to npm later.
7. **Concurrency control**: Single-flight indexing — only one indexing job runs at a time. New requests cancel the in-progress job or queue behind it.
8. **Degraded mode**: When Qdrant is unreachable, plugin loads successfully but tools return "Qdrant unavailable" errors. Lazy reconnect on next tool call or reindex.
9. **Security**: Default denylist excludes `.env*`, `*.pem`, `*.key`, `*secret*`, `*credential*`, `*.p12`, `*.pfx`, lock files. Configurable via `excludePatterns`.
10. **Server-TUI communication**: TUI polls the server's index_status tool endpoint via SDK client at configurable intervals. No custom event transport needed — uses existing OpenCode client API.
11. **Error model**: All wrapper methods throw on error (no Result<T>). Callers use try/catch. Errors include context (operation, collection, etc.).

## Qdrant Point Schema

```typescript
// Each point in the collection:
{
  id: string,              // UUID v4
  vector: number[],        // 384d (local) or 1536d (API)
  payload: {
    file_path: string,     // Relative to project root, e.g. "src/auth/middleware.ts"
    chunk_type: string,    // "code" | "summary"
    content: string,       // The actual text chunk
    start_line: number,    // 1-indexed start line in original file
    end_line: number,      // 1-indexed end line in original file
    language: string,      // Detected from extension, e.g. "typescript"
    content_hash: string,  // SHA-256 of the file content (for change detection)
    indexed_at: number,    // Unix timestamp ms
  }
}
```

## Plugin Configuration (PluginOptions)

```typescript
type PluginOptions = {
  // Required
  qdrantUrl: string;              // e.g. "http://localhost:6333"

  // Embedding (optional, defaults to local)
  embeddingProvider?: "local" | "api";       // Default: "local"
  embeddingModel?: string;                   // Default: "Xenova/all-MiniLM-L6-v2" (local) or "text-embedding-3-small" (api)
  embeddingApiKey?: string;                  // Required if embeddingProvider is "api"
  embeddingApiUrl?: string;                  // Default: "https://api.openai.com/v1"
  embeddingDimensions?: number;              // Auto-detected from model

  // Indexing (optional)
  maxFileSize?: number;                      // Default: 100_000 bytes — skip files larger than this
  chunkMaxLines?: number;                    // Default: 80
  chunkOverlapLines?: number;                // Default: 10
  excludePatterns?: string[];                // Extra glob patterns to exclude (beyond .gitignore)
  includePatterns?: string[];                // If set, only index files matching these patterns

  // Search (optional)
  searchLimit?: number;                      // Default: 10
  scoreThreshold?: number;                   // Default: 0.3

  // Advanced (optional)
  collectionName?: string;                   // Override auto-generated collection name
  batchSize?: number;                        // Embedding batch size, default: 50
  indexOnStart?: boolean;                    // Default: true
};
```

Usage in opencode.json:
```json
{
  "plugin": [
    [".opencode/plugins/opencode-qdrant", {
      "qdrantUrl": "http://localhost:6333"
    }]
  ]
}
```

## Dependency Graph

```
Step 1 (Scaffolding) ─→ Step 1a (Bun Spike) ─┬─→ Step 2 (Qdrant Wrapper)  ──┐
                                              ├─→ Step 3 (Embedding Provider) ─┤
                                              └─→ Step 4 (File Discovery +     ├─→ Step 5 (Indexer) ─→ Step 6 (Tools) ─→ Step 7 (Server Plugin) ─→ Step 8 (TUI) ─→ Step 9 (Testing)
                                                      Chunker)                 ─┘
```

- **Gate**: Step 1a validates Bun runtime compatibility before any implementation proceeds
- **Parallel group 1**: Steps 2, 3, 4 (independent modules, can be built simultaneously after 1a passes)
- **Parallel group 2**: Step 8 can start once Step 7 skeleton exists
- **Serial chain**: Step 5 needs 2+3+4 → Step 6 needs 5 → Step 7 needs 6 → Step 9 needs 7+8

---

## Step 1: Project Scaffolding & Configuration

### Context Brief
Create the plugin directory structure, install dependencies, and define the configuration types. This is the foundation everything else builds on. OpenCode plugins are TypeScript modules that export either a `server` function (server plugin) or `tui` function (TUI plugin). A single package can export both.

OpenCode plugin system details:
- Plugins are loaded from paths specified in `opencode.json` `plugin` array
- Server plugins: `export const server: Plugin = async (input, options) => Hooks`
- TUI plugins: `export const tui: TuiPlugin = async (api, options, meta) => void`
- The `@opencode-ai/plugin` package provides types and the `tool()` helper
- Plugin options are passed as the second element in `["path", { options }]` config
- Dependencies are auto-installed via `bun install`

### Tasks
- [ ] Create directory: `.opencode/plugins/opencode-qdrant/`
- [ ] Create `package.json` with dependencies:
  - `@opencode-ai/plugin` (peer dep, version from parent)
  - `@qdrant/js-client-rest` (Qdrant client)
  - `@xenova/transformers` (local embeddings)
  - `uuid` (point ID generation)
- [ ] Create `tsconfig.json` for TypeScript compilation
- [ ] Create `src/index.ts` — main entry point exporting `{ server, tui }`
- [ ] Create `src/types.ts` — PluginOptions type, PointPayload type, IndexingState type, EmbeddingProvider interface
- [ ] Create `src/config.ts` — Config validation and defaults (validate qdrantUrl is present, set defaults for all optional fields)
- [ ] Create placeholder files for each module: `src/qdrant.ts`, `src/embedding.ts`, `src/chunker.ts`, `src/discovery.ts`, `src/indexer.ts`, `src/tools.ts`, `src/server.ts`, `src/tui.ts`

### Verification
```bash
cd .opencode/plugins/opencode-qdrant && bun install && bun run tsc --noEmit
```

### Exit Criteria
- All files exist with proper TypeScript structure
- `bun install` succeeds
- Type checking passes with no errors
- PluginOptions type is complete and documented

### Rollback
Delete `.opencode/plugins/opencode-qdrant/` directory.

---

## Step 1a: Bun Runtime Compatibility Spike

### Context Brief
OpenCode plugins run in Bun, not Node.js. Before building any real implementation, we must validate that our two critical dependencies actually work in Bun:
1. `@qdrant/js-client-rest` — REST client, likely fine since it uses fetch
2. `@xenova/transformers` — ONNX runtime for local embeddings, high risk

This is a **gate step**. If local embeddings fail in Bun, we must either:
- Find an alternative local embedding library that works in Bun
- Default to API-based embeddings and make local embeddings optional/deferred
- Use a subprocess approach (spawn a Node.js process for embeddings)

### Tasks
- [ ] Create a test script `src/spike.ts` that:
  1. Imports `QdrantClient` from `@qdrant/js-client-rest` and calls `getCollections()` against a running Qdrant instance
  2. Imports `pipeline` from `@xenova/transformers` and generates an embedding for "hello world"
  3. Reports success/failure for each
- [ ] Run `bun run src/spike.ts` and capture results
- [ ] If `@xenova/transformers` fails in Bun:
  - Try `@huggingface/transformers` (newer package, may have better Bun support)
  - Try `onnxruntime-node` directly
  - If all local options fail: switch default to API-based, add local as "experimental" with a Node.js subprocess fallback
- [ ] If `@qdrant/js-client-rest` fails in Bun:
  - Fall back to raw `fetch()` calls against the Qdrant REST API (straightforward, just more code)
- [ ] Validate that a single package can export both `server` and `tui` by checking plugin module types
- [ ] Document findings and update dependency choices in package.json
- [ ] Delete `src/spike.ts` after validation

### Verification
```bash
cd .opencode/plugins/opencode-qdrant && bun run src/spike.ts
# Should output:
# Qdrant client: OK (N collections found)
# Local embeddings: OK (384 dimensions)
# — OR —
# Local embeddings: FAILED (reason). Falling back to API-based default.
```

### Exit Criteria
- Clear go/no-go decision for each dependency
- package.json updated to reflect working dependencies
- If local embeddings don't work in Bun, plan is mutated: API becomes default, local is deferred
- Findings documented as comments in types.ts or a SPIKE.md

### Rollback
Delete spike script. No production code affected.

---

## Step 2: Qdrant Client Wrapper

### Context Brief
Build a thin wrapper around `@qdrant/js-client-rest` that handles collection lifecycle and point operations. The wrapper manages a single collection per project, named `opencode_{sha256(project_path)[:12]}`.

Key Qdrant JS client API:
```typescript
import { QdrantClient } from '@qdrant/js-client-rest';
const client = new QdrantClient({ url: 'http://localhost:6333' });

// Collection ops
await client.createCollection('name', { vectors: { size: 384, distance: 'Cosine' } });
await client.getCollection('name');  // throws if not found
await client.getCollections();       // { collections: [{name}] }
await client.deleteCollection('name');

// Point ops
await client.upsert('collection', { wait: true, points: [{ id, vector, payload }] });
await client.search('collection', { vector, limit, filter, with_payload: true });
await client.delete('collection', { wait: true, filter: { must: [{ key, match: { value } }] } });
await client.scroll('collection', { limit, filter, with_payload: true });

// Payload indexes
await client.createPayloadIndex('collection', { field_name: 'file_path', field_schema: 'keyword' });
```

Point schema is defined in Step 1's types.ts:
```typescript
type PointPayload = {
  file_path: string;
  chunk_type: "code" | "summary";
  content: string;
  start_line: number;
  end_line: number;
  language: string;
  content_hash: string;
  indexed_at: number;
};
```

### Tasks
- [ ] Implement `QdrantWrapper` class in `src/qdrant.ts`
- [ ] Constructor: takes `qdrantUrl`, `collectionName`, `vectorSize`, `distance`
- [ ] `healthCheck()`: GET to Qdrant root endpoint, return boolean
- [ ] `ensureCollection()`: Check if collection exists, create if not (with correct vector config). Also create payload indexes for `file_path`, `language`, `chunk_type`, `content_hash`. **Dimension migration**: if collection exists but has different vector dimensions than expected, log a warning and drop+recreate (user explicitly chose a different model — old embeddings are incompatible). Collection name includes dimension suffix (`opencode_{hash}_{dim}`) so dimension changes create a new collection rather than corrupting the old one.
- [ ] `getCollectionInfo()`: Return point count, status, etc.
- [ ] `isHealthy()`: Cached health state — true if last Qdrant operation succeeded, false otherwise. Used for degraded mode.
- [ ] `upsertPoints(points: { id, vector, payload }[])`: Batch upsert with chunked batches (max 100 per request)
- [ ] `search(vector, options: { limit, filter?, scoreThreshold? })`: Return scored results with payloads
- [ ] `deleteByFilePath(filePath: string)`: Delete all points with matching file_path
- [ ] `deleteByFilePaths(filePaths: string[])`: Batch delete for multiple files
- [ ] `getFileHashes()`: Scroll all points with chunk_type="summary", return Map<file_path, content_hash> for change detection
- [ ] `deleteCollection()`: Full collection delete for clean re-index
- [ ] Error handling: all methods throw on error with descriptive messages including operation name and collection. Callers use try/catch. Update `isHealthy()` state on each operation.

### Verification
```typescript
// Unit test: create wrapper, ensure collection, upsert a test point, search, delete
const wrapper = new QdrantWrapper({ url: 'http://localhost:6333', collectionName: 'test', vectorSize: 4 });
await wrapper.ensureCollection();
await wrapper.upsertPoints([{ id: 'test-1', vector: [0.1, 0.2, 0.3, 0.4], payload: { ... } }]);
const results = await wrapper.search([0.1, 0.2, 0.3, 0.4], { limit: 1 });
assert(results.length === 1);
```

### Exit Criteria
- All CRUD operations work against a running Qdrant instance
- Collection is created idempotently (calling ensureCollection twice doesn't error)
- Payload indexes are created
- Batch upsert handles >100 points correctly (splits into chunks)
- Error handling doesn't crash the plugin

### Rollback
Delete `src/qdrant.ts`. No external state to clean up (test collections can be dropped).

---

## Step 3: Embedding Provider (Configurable)

### Context Brief
Build the embedding abstraction with two implementations: local (Xenova/transformers.js) and API-based (OpenAI-compatible). The provider must support batch embedding for efficiency.

Interface:
```typescript
interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;  // Batch embed
  dimensions: number;                            // Vector size
  name: string;                                  // For logging
}
```

Local embedding: Uses `@xenova/transformers` (also published as `@huggingface/transformers`) which runs ONNX models in JS. Default model: `Xenova/all-MiniLM-L6-v2` (384 dimensions, ~23MB download on first use, ~50ms per text). The model is downloaded and cached automatically.

API embedding: POST to `{apiUrl}/embeddings` with `{ model, input: string[] }`. Response: `{ data: [{ embedding: number[] }] }`. Supports OpenAI, Azure, and any compatible API.

### Tasks
- [ ] Define `EmbeddingProvider` interface in `src/types.ts`
- [ ] Implement `LocalEmbeddingProvider` in `src/embedding/local.ts`:
  - Uses `@xenova/transformers` pipeline('feature-extraction', modelName)
  - Handles model download/caching transparently
  - Batch embedding with configurable batch size
  - Mean pooling of token embeddings to get sentence embedding
  - Normalize vectors to unit length
- [ ] Implement `ApiEmbeddingProvider` in `src/embedding/api.ts`:
  - HTTP POST to `{apiUrl}/embeddings` endpoint
  - Handles batching (OpenAI supports up to 2048 inputs per request, but we cap at 100)
  - Retry logic with exponential backoff (3 retries)
  - API key validation
  - Support for configurable dimensions (text-embedding-3-small supports dimension reduction)
- [ ] Implement `createEmbeddingProvider(config)` factory in `src/embedding/index.ts`:
  - Returns `LocalEmbeddingProvider` when config.embeddingProvider === "local" (default)
  - Returns `ApiEmbeddingProvider` when config.embeddingProvider === "api"
  - Validates required fields (apiKey for API provider)

### Verification
```typescript
// Local
const local = await createEmbeddingProvider({ embeddingProvider: 'local' });
const vectors = await local.embed(['hello world', 'foo bar']);
assert(vectors.length === 2);
assert(vectors[0].length === 384);

// API (requires OPENAI_API_KEY)
const api = await createEmbeddingProvider({ embeddingProvider: 'api', embeddingApiKey: '...' });
const apiVectors = await api.embed(['hello world']);
assert(apiVectors[0].length === 1536);
```

### Exit Criteria
- Local provider generates consistent 384d vectors
- API provider correctly calls OpenAI-compatible endpoint
- Both providers handle batch inputs
- Factory correctly selects provider based on config
- Error messages are clear when config is invalid (e.g., missing API key)

### Rollback
Delete `src/embedding/` directory.

---

## Step 4: File Discovery & Heuristic Chunker

### Context Brief
Two independent modules: file discovery (which files to index) and code chunking (how to split files into embeddable chunks).

**File Discovery**: Uses `git ls-files` to get tracked files. This respects .gitignore automatically. Additional exclude/include patterns can be configured. Files are hashed with SHA-256 for change detection.

**Heuristic Chunker**: Splits source files at natural boundaries without requiring language-specific parsers. The strategy:
1. Read file content as lines
2. Identify "boundary lines" using regex patterns:
   - 2+ consecutive blank lines
   - Lines matching: `^(export |async |public |private |protected )?(function|class|interface|type|enum|const|let|var|def |module |namespace )`
   - Lines matching: `^(describe|it|test|beforeEach|afterEach)\(`
   - Lines matching: `^## ` (markdown headers)
   - Lines matching: `^---$` (markdown separators)
3. Split at boundaries, keeping each chunk between 5-80 lines (configurable)
4. Merge tiny chunks (<5 lines) with their predecessor
5. If a chunk exceeds max lines, split at the nearest blank line; if none, split at max
6. Add configurable overlap between consecutive chunks

Also extract "file summary" from the first ~20 lines of each file.

### Tasks
- [ ] Implement `discoverFiles(directory, options)` in `src/discovery.ts`:
  - Run `git ls-files` in the project directory (if not a git repo, fall back to recursive directory listing with sensible defaults: skip node_modules, .git, dist, build, vendor)
  - Apply **security denylist** (always active, not configurable out): `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*secret*`, `*credential*`, `*.keystore`
  - Filter by `includePatterns` and `excludePatterns` from config
  - Filter by `maxFileSize`
  - Skip binary files (check extension against known binary extensions + null-byte content sniffing for the first 512 bytes)
  - Skip generated/minified files: files with average line length >200 chars, `*.min.js`, `*.min.css`, `*-lock.*`, `package-lock.json`, `bun.lock`, `yarn.lock`
  - Return array of `{ relativePath, absolutePath }`
- [ ] Implement `hashFileContent(content: string): string` utility — SHA-256 hex
- [ ] Implement `detectLanguage(filePath: string): string` — map file extension to language name
- [ ] Implement `Chunk` type: `{ content, startLine, endLine, type: "code" | "summary" }`
- [ ] Implement `chunkFile(content, options)` in `src/chunker.ts`:
  - Parse content into lines
  - Identify boundary lines via regex patterns
  - Split into chunks at boundaries
  - Enforce min/max chunk size constraints
  - Apply overlap between consecutive chunks
  - Return array of `Chunk`
- [ ] Implement `extractFileSummary(content, maxLines)` in `src/chunker.ts`:
  - Take first N lines (default 20)
  - Return as a single "summary" chunk

### Verification
```typescript
// Discovery
const files = await discoverFiles('/path/to/project', { excludePatterns: ['*.test.*'] });
assert(files.length > 0);
assert(files.every(f => !f.relativePath.includes('.test.')));

// Chunker
const content = `import { foo } from 'bar';\n\nexport function hello() {\n  return 'world';\n}\n\nexport class Greeter {\n  greet() {\n    return 'hi';\n  }\n}`;
const chunks = chunkFile(content, { maxLines: 80, minLines: 3, overlapLines: 2 });
assert(chunks.length >= 1);
assert(chunks[0].startLine === 1);
```

### Exit Criteria
- File discovery correctly lists git-tracked files
- Binary files are skipped
- Exclude/include patterns work
- Chunker splits at function/class boundaries
- Tiny chunks are merged
- Large chunks are split at blank lines
- File summaries are extracted
- Language detection covers common extensions (ts, js, py, go, rs, java, etc.)

### Rollback
Delete `src/discovery.ts` and `src/chunker.ts`.

---

## Step 5: Indexer Engine

### Context Brief
The indexer orchestrates the full pipeline: discover files -> detect changes -> chunk changed files -> embed chunks -> upsert to Qdrant -> cleanup deleted files. It tracks progress and supports both full and incremental indexing.

Dependencies from previous steps:
- `QdrantWrapper` from Step 2 — collection and point operations
- `EmbeddingProvider` from Step 3 — vector generation
- `discoverFiles`, `hashFileContent` from Step 4 — file listing and hashing
- `chunkFile`, `extractFileSummary`, `detectLanguage` from Step 4 — chunking

The indexer maintains an `IndexingState` that the TUI can observe:
```typescript
type IndexingState = {
  status: "idle" | "discovering" | "indexing" | "complete" | "error";
  totalFiles: number;
  processedFiles: number;
  skippedFiles: number;    // unchanged files
  totalChunks: number;
  errorCount: number;
  errors: Array<{ file: string; error: string }>;
  startedAt: number;
  completedAt?: number;
  collectionName: string;
  collectionPointCount?: number;
};
```

### Tasks
- [ ] Implement `Indexer` class in `src/indexer.ts`
- [ ] Constructor: takes `QdrantWrapper`, `EmbeddingProvider`, config options
- [ ] **Concurrency control**: Use a mutex/lock flag. Only one indexing operation runs at a time. If `indexAll()` or `indexIncremental()` is called while one is already running: cancel the in-progress job (via AbortController) and start the new one. Expose `isRunning(): boolean`.
- [ ] `indexAll()` — Full index: delete entire collection, recreate, discover all files, chunk all, embed all, upsert all
- [ ] `indexIncremental()` — Incremental index with **atomic file replacement**:
  1. Discover current files and hash them
  2. Fetch existing file hashes from Qdrant via `getFileHashes()`
  3. Identify changed files (hash mismatch), new files (not in Qdrant), deleted files (not on disk)
  4. For changed files: chunk and embed **first**, then upsert new points, **then** delete old points (never delete before new data is confirmed stored)
  5. For new files: chunk, embed, upsert
  6. For deleted files: delete their points
  7. If embedding or upsert fails mid-batch, stop processing but keep already-indexed data intact
- [ ] File processing pipeline for a single file:
  1. Read file content
  2. Hash content
  3. Detect language
  4. Extract file summary (chunk_type: "summary")
  5. Generate code chunks (chunk_type: "code")
  6. Return all chunks with metadata
- [ ] Batch embedding: collect chunks from multiple files, embed in batches of configurable size (default 50)
- [ ] Progress tracking: update `IndexingState` as files are processed
- [ ] State getter: `getState(): IndexingState`
- [ ] Cancellation support: check AbortSignal between file batches
- [ ] Error isolation: if one file fails to process, log the error and continue with remaining files

### Verification
```typescript
// Integration test with a small test project
const indexer = new Indexer(qdrantWrapper, embeddingProvider, config);
await indexer.indexAll();
const state = indexer.getState();
assert(state.status === 'complete');
assert(state.totalFiles > 0);
assert(state.totalChunks > 0);
assert(state.errorCount === 0);

// Re-run incremental — should skip all files
await indexer.indexIncremental();
const state2 = indexer.getState();
assert(state2.skippedFiles === state.totalFiles);
```

### Exit Criteria
- Full indexing processes all git-tracked files
- Incremental indexing correctly detects and skips unchanged files
- Changed files are re-indexed (old points deleted, new points created)
- Deleted files have their points cleaned up
- Progress state updates in real-time
- Embedding batching works correctly
- Large codebases (1000+ files) don't OOM (process files in batches, not all at once)
- Individual file errors don't crash the entire indexing process

### Rollback
Delete `src/indexer.ts`. Drop test collections from Qdrant.

---

## Step 6: Agent Tools

### Context Brief
Define three tools that OpenCode agents can use to interact with the indexed codebase. Tools are defined using the `tool()` helper from `@opencode-ai/plugin` with Zod schemas for arguments.

Tool function signature:
```typescript
import { tool } from "@opencode-ai/plugin";

tool({
  description: string,
  args: { [key]: tool.schema.string()/number()/boolean().describe(desc) },
  execute: async (args, context: ToolContext) => string,
});
```

`ToolContext` provides: `sessionID`, `messageID`, `agent`, `directory`, `worktree`, `abort: AbortSignal`, `metadata()`, `ask()`.

The tools need access to `QdrantWrapper` and `EmbeddingProvider` instances from the indexer. Use closure to capture them.

### Tasks
- [ ] Implement `createTools(qdrant, embeddingProvider, indexer)` in `src/tools.ts`
- [ ] `codebase_search` tool:
  - Args: `query` (string, required), `limit` (number, optional, default 10), `file_pattern` (string, optional — filter by file path glob pattern), `chunk_type` (string, optional — "code" or "summary")
  - Description: "Search the project codebase semantically. Use this to find relevant code, functions, classes, or files based on natural language descriptions. Returns matching code snippets with file paths and line numbers."
  - Execute: embed the query -> search Qdrant with optional filters -> format results
  - Output format: Numbered results with file path, line range, score, and content preview
  - Use `context.metadata()` to set title like "Searched: {query} (N results)"
  - Example output:
    ```
    Found 5 results for "authentication middleware":

    1. [0.92] src/middleware/auth.ts:15-45 (typescript)
    export async function authMiddleware(req, res, next) {
      const token = req.headers.authorization?.split(' ')[1];
      ...
    }

    2. [0.87] src/routes/login.ts:1-20 (typescript) [summary]
    import { Router } from 'express';
    import { authService } from '../services/auth';
    ...
    ```
- [ ] `index_status` tool:
  - Args: none
  - Description: "Check the current status of the codebase semantic index. Shows indexing progress, file counts, and collection statistics."
  - Execute: get indexer state + collection info from Qdrant -> format
  - Output: status, file counts, chunk counts, last indexed time, collection name
- [ ] `reindex` tool:
  - Args: `full` (boolean, optional, default false — if true, drops collection and re-indexes everything; if false, incremental)
  - Description: "Trigger re-indexing of the codebase. By default, only indexes changed files (incremental). Set full=true to rebuild the entire index."
  - Execute: trigger indexer.indexAll() or indexer.indexIncremental() in background -> return immediate status
  - Must not block the agent — start indexing and return "Reindexing started..."

### Verification
```
# In an OpenCode session, the agent should be able to:
> Use codebase_search to find "database connection pooling"
> Use index_status to check the index
> Use reindex to trigger re-indexing
```

### Exit Criteria
- `codebase_search` returns relevant results with file paths and line numbers
- Results are formatted clearly for the agent to reference in its responses
- `file_pattern` filter works (e.g., only search in `*.ts` files)
- `index_status` shows accurate statistics
- `reindex` starts indexing without blocking
- Tool descriptions are clear enough for agents to use correctly without guidance

### Rollback
Delete `src/tools.ts`.

---

## Step 7: Server Plugin Integration

### Context Brief
Wire all components together into the OpenCode server plugin entry point. The server plugin is the `server` export that receives `PluginInput` and `PluginOptions`, initializes all components, starts background indexing, and returns `Hooks`.

Server plugin signature:
```typescript
import type { Plugin } from "@opencode-ai/plugin";

export const server: Plugin = async (input, options) => {
  const { client, project, directory, worktree, serverUrl, $ } = input;
  // input.$ is BunShell for running shell commands
  // input.client is the OpenCode SDK client for logging, etc.
  // input.directory is the project root
  
  // ... initialize components ...
  
  return {
    tool: { ... },           // Agent tools from Step 6
    event: async ({ event }) => { ... },  // Event handling
    // ... other hooks
  };
};
```

Plugin logging: `await client.app.log({ body: { service: "opencode-qdrant", level: "info", message: "..." } })`

### Tasks
- [ ] Implement `server` export in `src/server.ts`:
  1. Validate plugin options (qdrantUrl is required)
  2. Merge options with defaults from `src/config.ts`
  3. Generate collection name: `opencode_${sha256(directory).slice(0, 12)}_${dimensions}`
  4. Create `QdrantWrapper` instance (does NOT connect yet — lazy)
  5. Create `EmbeddingProvider` instance via factory
  6. **Degraded mode startup**: Try health check + ensureCollection. If Qdrant is unreachable:
     - Log warning: "Qdrant at {url} is unreachable. Plugin loaded in degraded mode. Tools will return errors until Qdrant is available."
     - Set `qdrantAvailable = false` flag
     - Do NOT throw — plugin still loads, tools still register
     - On each tool call or reindex, re-attempt health check first (lazy reconnect)
  7. Create `Indexer` instance
  8. If `indexOnStart` is true (default) AND Qdrant is available, start `indexer.indexIncremental()` in background (don't await — let it run)
  9. Create tools via `createTools()` — tools check `qdrantAvailable` and return clear error messages when disconnected
  10. Return hooks object
- [ ] Wire up `event` hook:
  - On `session.created`: optionally trigger incremental re-index (if stale)
  - Log events at debug level
- [ ] Wire up `tool.definition` hook (optional):
  - Enhance codebase_search description with project-specific info (e.g., "This project has N indexed files")
- [ ] Export from `src/index.ts`:
  ```typescript
  export { server } from './server';
  // tui export added in Step 8
  ```
- [ ] Handle graceful shutdown: if indexing is in progress when plugin unloads, cancel via AbortController

### Verification
1. Add plugin to `.opencode/opencode.json`:
   ```json
   { "plugin": [[".opencode/plugins/opencode-qdrant", { "qdrantUrl": "http://localhost:6333" }]] }
   ```
2. Start OpenCode — plugin should initialize, connect to Qdrant, and start indexing
3. Check logs for "opencode-qdrant" entries
4. Use `codebase_search` tool in a session

### Exit Criteria
- Plugin loads without errors
- Qdrant connection is established (or graceful failure if Qdrant is down)
- Background indexing starts automatically
- All three tools are available to agents
- Logging works via `client.app.log`
- Plugin handles Qdrant being unavailable gracefully (tools return useful error messages)

### Rollback
Revert `src/server.ts` and `src/index.ts` changes.

---

## Step 8: TUI Plugin (Status Display)

### Context Brief
Add a TUI plugin component that shows indexing status in the OpenCode terminal UI. TUI plugins use Solid.js for rendering and can register slots, commands, and routes.

TUI plugin signature:
```typescript
import type { TuiPlugin } from "@opencode-ai/plugin/tui";

export const tui: TuiPlugin = async (api, options, meta) => {
  // api.ui — Dialog, toast, etc.
  // api.slots — register UI slot content
  // api.state — read-only app state
  // api.client — OpenCode client for API calls
  // api.lifecycle — signal, onDispose
  // api.event — event bus
  // api.command — register/trigger commands
  // api.kv — key-value storage
};
```

**Server-TUI Communication Contract**:
The TUI and server plugins run in separate processes (server in OpenCode backend, TUI in the frontend terminal). They communicate via the OpenCode SDK client API — specifically, the TUI plugin uses `api.client` to call the server-side tool endpoint. The contract:

1. TUI calls `api.client.tool.call({ tool: "index_status", args: {} })` to get current state
2. Polling intervals: every 3 seconds while status is "indexing" or "discovering", every 30 seconds when "idle" or "complete"
3. TUI uses `api.kv` (key-value storage) to cache the last-known state for instant display on load
4. If the tool call fails (server not ready, Qdrant down), TUI shows "Index: unavailable" and retries at 10-second intervals

No custom event transport needed — the existing tool system is the communication layer.

Available slots from `TuiHostSlotMap`:
- `home_bottom` — bottom of home screen
- `home_footer` — footer area
- `sidebar_content` — session sidebar
- `sidebar_footer` — session sidebar footer

### Tasks
- [ ] Implement `tui` export in `src/tui.ts`
- [ ] Register a toast notification on plugin init: "Qdrant Semantic Index: connecting..."
- [ ] Use `api.lifecycle.signal` to handle cleanup
- [ ] Implement status polling mechanism:
  - Periodically (every 5 seconds during indexing, every 30 seconds when idle) call the OpenCode client to check index status
  - Alternatively, listen for custom events from the server plugin
- [ ] Register `sidebar_footer` slot to show compact index status:
  - During indexing: "Indexing: 42/100 files..."
  - When complete: "Index: 500 files, 3.2k chunks"
  - On error: "Index: Qdrant unreachable"
- [ ] Show toast notifications for key events:
  - Indexing started
  - Indexing complete (with file/chunk count)
  - Indexing error
- [ ] Register a command "qdrant:reindex" that triggers re-indexing
- [ ] Register a command "qdrant:status" that shows detailed status in a dialog
- [ ] Export from `src/index.ts`:
  ```typescript
  export { server } from './server';
  export { tui } from './tui';
  ```

### Verification
1. Start OpenCode with the plugin configured
2. Observe toast notification on startup
3. Check sidebar footer for status text
4. Run `qdrant:status` command to see detailed status
5. Run `qdrant:reindex` command to trigger re-indexing

### Exit Criteria
- TUI loads without errors
- Status is visible in sidebar footer
- Toast notifications appear for key indexing events
- Commands are registered and functional
- Status updates reflect actual indexing progress
- Clean display when Qdrant is unavailable

### Rollback
Revert TUI code in `src/tui.ts` and remove tui export from `src/index.ts`.

---

## Step 9: Testing, Error Handling & Polish

### Context Brief
Final integration testing, error handling hardening, and polish. This step ensures the plugin works end-to-end in a real OpenCode session with various edge cases handled.

### Tasks
- [ ] **End-to-end test**: Configure plugin in a real project, start OpenCode, verify:
  - Plugin loads and connects to Qdrant
  - Indexing starts and completes
  - `codebase_search` returns relevant results
  - `index_status` shows correct stats
  - `reindex` works for both full and incremental
  - TUI shows status correctly
- [ ] **Error handling audit**:
  - Qdrant is unreachable at startup -> plugin loads, tools return clear error messages
  - Qdrant becomes unreachable mid-indexing -> indexing pauses, resumes when connection is restored (or reports error)
  - Embedding model download fails (local) -> clear error message with instructions
  - API key is invalid (API embedding) -> clear error message
  - Empty project (no git-tracked files) -> graceful handling, no crash
  - Very large files -> skipped with warning
  - Binary files in git -> skipped (extension check)
  - Files with encoding issues -> skip and log warning
- [ ] **Performance validation**:
  - Test with a medium project (~500 files) — indexing should complete in <5 minutes with local embeddings
  - Test with a large project (~2000 files) — should handle without OOM
  - Search latency should be <500ms for a single query
  - Incremental re-index of unchanged project should complete in <5 seconds
- [ ] **Edge cases**:
  - Project with no git repo -> fall back to listing all files, or show clear error
  - Files outside the worktree -> handle correctly
  - Symlinks -> skip or follow based on config
  - Very long file paths -> ensure they fit in Qdrant payload
- [ ] **Code cleanup**:
  - Remove any TODO comments
  - Ensure consistent error handling patterns
  - Add JSDoc comments to public APIs
  - Verify no console.log calls (use client.app.log instead)
- [ ] **Configuration documentation**: Add comments in types.ts explaining each option

### Verification
Full manual test matrix:
1. Fresh index on a TypeScript project -> all files indexed
2. Modify one file -> incremental index only processes that file
3. Delete a file -> orphaned points cleaned up
4. Search for specific functionality -> relevant results returned
5. Restart OpenCode -> incremental index is fast (skip unchanged)
6. Kill Qdrant -> plugin reports error gracefully
7. Restart Qdrant -> next search/reindex works

### Exit Criteria
- Plugin works end-to-end without errors
- All error scenarios produce helpful messages (not stack traces)
- Performance is acceptable for medium-sized projects
- Code is clean and well-documented
- TUI shows accurate, real-time status

### Rollback
Fix bugs in-place. This step doesn't introduce new architecture.

---

## File Structure

```
.opencode/plugins/opencode-qdrant/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts              # Main entry: exports { server, tui }
    ├── types.ts              # All shared types: PluginOptions, PointPayload, IndexingState, EmbeddingProvider
    ├── config.ts             # Config validation & defaults
    ├── qdrant.ts             # QdrantWrapper class
    ├── embedding/
    │   ├── index.ts          # Factory: createEmbeddingProvider()
    │   ├── local.ts          # LocalEmbeddingProvider (Xenova/transformers.js)
    │   └── api.ts            # ApiEmbeddingProvider (OpenAI-compatible)
    ├── discovery.ts          # discoverFiles(), hashFileContent(), detectLanguage()
    ├── chunker.ts            # chunkFile(), extractFileSummary()
    ├── indexer.ts            # Indexer class (orchestrates the pipeline)
    ├── tools.ts              # createTools() — codebase_search, index_status, reindex
    ├── server.ts             # Server plugin: initialization, hooks, lifecycle
    └── tui.ts                # TUI plugin: status display, commands, toasts
```

## Anti-Pattern Checks

- [x] No monolith steps — largest step (Step 5) has clear boundaries
- [x] Every step has verification commands
- [x] Dependencies are explicit in the graph
- [x] Each step's context brief is self-contained
- [x] Destructive operations (deleteCollection) have rollback plans
- [x] No premature optimization — functional correctness first, perf validation in Step 9
- [x] No implicit state sharing — server/TUI communicate via tool polling, not shared memory

## Adversarial Review Fixes (2026-04-10)

Findings addressed from adversarial review:

| # | Finding (Critical) | Fix |
|---|---|---|
| 1 | Bun + @xenova/transformers not validated | Added Step 1a: Bun compatibility spike as gate step |
| 2 | Server-TUI communication underspecified | Defined explicit polling contract via SDK client tool calls in Step 8 |
| 3 | Collection dimension migration missing | Collection name includes dimension suffix; ensureCollection detects mismatch |
| 4 | Reindex concurrency/race control missing | Added mutex/single-flight to Indexer in Step 5 |
| 5 | Non-atomic file replacement can lose data | Upsert new points before deleting old ones in Step 5 |
| 6 | Qdrant-unreachable startup inconsistent | Defined explicit degraded mode in Step 7 |

| # | Finding (Important) | Fix |
|---|---|---|
| 1 | Dependency graph incorrect for TUI | Fixed: TUI depends on tool API contract, not just Step 7 skeleton |
| 2 | Result<T> vs throw inconsistency | Unified: all methods throw, callers use try/catch |
| 3 | Weak chunker for edge cases | Added skip rules for minified/generated/vendor files |
| 4 | Security: sensitive files indexed | Added security denylist in discovery, always active |
| 5 | Model download/cache behavior unplanned | Addressed in Step 1a spike and Step 3 local provider |
| 6 | No git repo fallback decided late | Moved to Step 4: fall back to recursive listing |
