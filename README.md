# opencode-qdrant

Semantic codebase indexing plugin for [OpenCode](https://github.com/nichochar/opencode). Uses [Qdrant](https://qdrant.tech/) vector database to index your project files and expose semantic search to AI agents.

## Features

- Indexes git-tracked files on project open (incremental by default)
- Heuristic chunking at function/class boundaries with file summaries
- Local embeddings (Xenova/all-MiniLM-L6-v2, 384d) or API embeddings (OpenAI-compatible, 1536d)
- Per-project Qdrant collections (derived from project path + embedding dimensions)
- Agent tools: `codebase_search`, `index_status`, `reindex`, `qdrant_ping`
- TUI sidebar showing live indexing status
- Ctrl+P commands for status display and manual reindex
- Security denylist (skips `.env`, `.pem`, secrets, credentials, etc.)
- Skips binary, generated, and minified files

## Prerequisites

- [OpenCode](https://github.com/nichochar/opencode) >= 1.0.0
- [Qdrant](https://qdrant.tech/documentation/quick-start/) running and accessible (default: `http://localhost:6333`)
- Node.js (for local embedding worker)

### Quick Qdrant setup

```bash
docker run -p 6333:6333 -p 6334:6334 qdrant/qdrant
```

## Installation

Add to your project's `.opencode/opencode.json`:

```json
{
  "plugin": [
    ["github:naeem76/opencode-qdrant-plugin", { "qdrantUrl": "http://localhost:6333" }]
  ]
}
```

Add to your project's `.opencode/tui.json` for sidebar and Ctrl+P commands:

```json
{
  "plugin": [
    "github:naeem76/opencode-qdrant-plugin"
  ]
}
```

### Windows

On Windows, remote plugin specs (`github:` and tarball URLs) do not work reliably due to two issues in OpenCode's compiled Bun binary:

1. **`github:` spec fails** — `@npmcli/git` cannot find the git executable. The `which` package's binary lookup fails inside the compiled Bun runtime, even when git is in the system PATH.
2. **Tarball installs break native modules** — OpenCode's arborist runs with `ignoreScripts: true`, which skips postinstall scripts. `sharp` (a transitive dependency of `@xenova/transformers`, used for local embeddings) requires a native binary built via postinstall, so it crashes at runtime with `Cannot find module '../build/Release/sharp-win32-x64.node'`.

The recommended approach on Windows is to clone the repo locally and use a `file://` URL:

```bash
git clone https://github.com/naeem76/opencode-qdrant-plugin.git
cd opencode-qdrant-plugin
npm install
npm run build
```

Then reference the local clone in your config. Use the absolute path to wherever you cloned it.

`.opencode/opencode.json`:
```json
{
  "plugin": [
    ["file:///C:/path/to/opencode-qdrant-plugin", { "qdrantUrl": "http://localhost:6333" }]
  ]
}
```

`.opencode/tui.json`:
```json
{
  "plugin": [
    "file:///C:/path/to/opencode-qdrant-plugin"
  ]
}
```

To enable globally for all projects, add the same entries to `~/.config/opencode/opencode.json` and `~/.config/opencode/tui.json` instead.

### Global install

Add to `~/.config/opencode/opencode.json` to enable for all projects:

```json
{
  "plugin": [
    ["github:naeem76/opencode-qdrant-plugin", { "qdrantUrl": "http://localhost:6333" }]
  ]
}
```

## Configuration

Options are passed as the second element of the plugin tuple:

```json
["github:naeem76/opencode-qdrant-plugin", {
  "qdrantUrl": "http://localhost:6333",
  "embeddingProvider": "local",
  "indexOnStart": true
}]
```

### All options

| Option | Type | Default | Description |
|---|---|---|---|
| `qdrantUrl` | `string` | **required** | Qdrant server URL |
| `embeddingProvider` | `"local" \| "api"` | `"local"` | Embedding backend |
| `embeddingModel` | `string` | `Xenova/all-MiniLM-L6-v2` (local) / `text-embedding-3-small` (api) | Model name |
| `embeddingApiKey` | `string` | - | Required when provider is `"api"` |
| `embeddingApiUrl` | `string` | `https://api.openai.com/v1` | OpenAI-compatible endpoint |
| `embeddingDimensions` | `number` | `384` (local) / `1536` (api) | Vector dimensions |
| `indexOnStart` | `boolean` | `true` | Index when project opens |
| `maxFileSize` | `number` | `100000` | Skip files larger than this (bytes) |
| `chunkMaxLines` | `number` | `80` | Max lines per chunk |
| `chunkOverlapLines` | `number` | `10` | Overlap between adjacent chunks |
| `excludePatterns` | `string[]` | `[]` | Additional glob patterns to exclude |
| `includePatterns` | `string[]` | - | If set, only index matching files |
| `searchLimit` | `number` | `10` | Default results per search |
| `scoreThreshold` | `number` | `0.3` | Minimum similarity score |
| `collectionName` | `string` | auto-generated | Override Qdrant collection name |
| `batchSize` | `number` | `50` | Files per indexing batch |
| `localWorkerCommand` | `string` | `"node"` | Command to run the embedding worker |

## Agent tools

Once loaded, AI agents in OpenCode have access to these tools:

### `codebase_search`

Semantic search across the indexed codebase.

```
query: string       — Natural language search query
limit?: number      — Max results (default: 10, max: 20)
file_pattern?: string — Glob filter (e.g. "src/**/*.ts")
chunk_type?: "code" | "summary" — Filter by chunk type
```

### `index_status`

Returns current indexing state: status, file counts, chunk counts, collection health.

### `reindex`

Triggers re-indexing in the background.

```
full?: boolean — If true, drops and rebuilds the entire collection (default: false)
```

### `qdrant_ping`

Diagnostic tool to confirm the plugin is loaded and Qdrant is reachable.

## TUI features

### Sidebar

Shows a live status indicator:
- Dot color reflects state (green = complete, blue = indexing, yellow = errors, gray = idle)
- Chunk and file counts
- Updates every 2 seconds

### Ctrl+P commands

- **Qdrant: Show indexing status** — Toast with current state
- **Qdrant: Reindex project (incremental)** — Triggers incremental reindex
- **Qdrant: Reindex project (full)** — Drops collection and rebuilds

## Architecture

```
opencode.json ──> server plugin ──> Qdrant (vector DB)
                    ├── file discovery (git ls-files)
                    ├── chunker (heuristic boundary detection)
                    ├── embedding provider (local worker / API)
                    ├── indexer (incremental, concurrent)
                    ├── agent tools (search, reindex, status, ping)
                    └── writes <userDataDir>/projects/<key>/status.json

tui.json ──> TUI plugin
               ├── reads <userDataDir>/projects/<key>/status.json (polls 2s)
               ├── sidebar_content slot (status view)
               ├── Ctrl+P commands
               └── writes <userDataDir>/projects/<key>/trigger.json
                     ↑ server polls this to trigger reindex from TUI
```

Server and TUI plugins communicate via the filesystem — the server writes status, the TUI reads it. Reindex commands go the other direction via a trigger file.

### Storage location

Plugin state lives in the per-user OS data directory, keyed by a stable hash of the project path:

| Platform | Base directory |
|---|---|
| Windows | `%LOCALAPPDATA%\opencode-qdrant\projects\<key>\` |
| macOS   | `~/Library/Application Support/opencode-qdrant/projects/<key>/` |
| Linux   | `$XDG_DATA_HOME/opencode-qdrant/projects/<key>/` (or `~/.local/share/...`) |

`<key>` is a 12-char hash derived from a **normalized** project path, so the same repo opened from Windows native, Git Bash / MSYS, Cygwin, or WSL resolves to the same key. For example, all of these share one state directory and one Qdrant collection:

- `D:\Work-Personal-2025\opencode-qdrant` (Windows)
- `/mnt/d/Work-Personal-2025/opencode-qdrant` (WSL)
- `/d/Work-Personal-2025/opencode-qdrant` (Git Bash)
- `/cygdrive/d/Work-Personal-2025/opencode-qdrant` (Cygwin)

**Upgrading from pre-normalization versions**: the Qdrant collection name also now uses the normalized key, so existing installations will do one fresh reindex on first start after upgrade. Orphaned collections from before the upgrade can be dropped from Qdrant manually. The plugin automatically deletes legacy `.opencode/qdrant-status.json` and `.opencode/qdrant-reindex-trigger.json` files from each project on first write.

## Local development

```bash
git clone https://github.com/naeem76/opencode-qdrant-plugin
cd opencode-qdrant
npm install
npm run build
```

The `.opencode/plugins/` directory contains wrapper files that import from `dist/` for local testing. Open this repo in OpenCode and the plugin loads automatically.

## License

[MIT](LICENSE)
