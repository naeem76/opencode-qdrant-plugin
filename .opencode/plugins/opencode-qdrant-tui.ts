import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup, createComponent } from "solid-js"
import { createElement, insert, setProp } from "@opentui/solid"
import * as fs from "node:fs"
import * as path from "node:path"

// ---------------------------------------------------------------------------
// Status file reading
// ---------------------------------------------------------------------------

type QdrantStatus = {
  status: "idle" | "discovering" | "indexing" | "complete" | "error"
  totalFiles: number
  processedFiles: number
  skippedFiles: number
  totalChunks: number
  errorCount: number
  errors: { file: string; error: string }[]
  startedAt: number | null
  completedAt: number | null
  collectionName: string
  collectionPointCount: number | null
  provider: string
  updatedAt: number
}

function readStatus(rootDir: string): QdrantStatus | null {
  try {
    const raw = fs.readFileSync(path.join(rootDir, ".opencode", "qdrant-status.json"), "utf8")
    return JSON.parse(raw) as QdrantStatus
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Sidebar view (no JSX — .ts files don't support it in Bun)
// ---------------------------------------------------------------------------

function StatusView(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const rootDir = props.api.state.path.directory

  const [status, setStatus] = createSignal(readStatus(rootDir))

  const timer = setInterval(() => setStatus(readStatus(rootDir)), 2000)
  onCleanup(() => clearInterval(timer))

  const dot = () => {
    const s = status()
    if (!s) return theme().textMuted
    switch (s.status) {
      case "complete":
        return theme().success
      case "error":
        return theme().warning
      case "indexing":
      case "discovering":
        return theme().info
      case "idle":
        return theme().textMuted
    }
  }

  const label = () => {
    const s = status()
    if (!s) return "Not connected"
    switch (s.status) {
      case "idle":
        return "Idle"
      case "discovering":
        return "Discovering files..."
      case "indexing":
        return `Indexing ${s.processedFiles}/${s.totalFiles}...`
      case "complete":
        return `${s.collectionPointCount ?? 0} chunks indexed`
      case "error":
        return `${s.errorCount} error(s)`
    }
  }

  const detail = () => {
    const s = status()
    if (!s || s.status === "idle") return null
    if (s.status === "complete" || s.status === "error") {
      return `${s.processedFiles} files (${s.skippedFiles} unchanged)`
    }
    return null
  }

  // Build UI tree without JSX
  const root = createElement("box")

  // Title
  const title = createElement("text")
  setProp(title, "fg", theme().text)
  setProp(title, "bold", true)
  insert(title, "Qdrant")
  insert(root, title)

  // Status row
  const row = createElement("box")
  setProp(row, "flexDirection", "row")
  setProp(row, "gap", 1)

  const dotEl = createElement("text")
  setProp(dotEl, "flexShrink", 0)
  insert(dotEl, () => {
    setProp(dotEl, "fg", dot())
    return "●"
  })
  insert(row, dotEl)

  const labelEl = createElement("text")
  insert(labelEl, () => {
    setProp(labelEl, "fg", theme().text)
    return label()
  })
  insert(row, labelEl)
  insert(root, row)

  // Detail line (conditional)
  const detailEl = createElement("text")
  insert(detailEl, () => {
    const d = detail()
    setProp(detailEl, "fg", theme().textMuted)
    return d ?? ""
  })
  insert(root, detailEl)

  return root
}

// ---------------------------------------------------------------------------
// TUI plugin entry
// ---------------------------------------------------------------------------

const tui: TuiPlugin = async (api) => {
  // Sidebar slot — between Context (100) and MCP (200)
  api.slots.register({
    order: 150,
    slots: {
      sidebar_content() {
        return createComponent(StatusView, { api })
      },
    },
  })

  // Ctrl+P commands
  api.command.register(() => [
    {
      title: "Qdrant: Show indexing status",
      value: "qdrant.status",
      category: "Qdrant",
      slash: { name: "qdrant-index-status" },
      onSelect: () => {
        const s = readStatus(api.state.path.directory)
        if (s) {
          api.ui.toast({
            title: "Qdrant",
            message: `${s.status} — ${s.collectionPointCount ?? 0} chunks, ${s.processedFiles} files`,
            variant: s.status === "error" ? "warning" : "info",
          })
        } else {
          api.ui.toast({ message: "Qdrant status unavailable", variant: "error" })
        }
        api.ui.dialog.clear()
      },
    },
    {
      title: "Qdrant: Reindex project",
      value: "qdrant.reindex",
      category: "Qdrant",
      slash: { name: "qdrant-reindex" },
      onSelect: () => {
        api.ui.toast({ title: "Qdrant", message: "Triggering reindex via agent...", variant: "info" })
        api.ui.dialog.clear()
      },
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-qdrant-tui",
  tui,
}

export default plugin
