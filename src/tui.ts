import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { readStatusFile, type PersistedStatus } from "./status-file.js"

function summarize(status: PersistedStatus | null) {
  if (!status) {
    return {
      lines: ["Qdrant Index", "No index state yet"],
      toast: null as null | { variant: "success" | "error"; message: string },
    }
  }

  const lines = [
    "Qdrant Index",
    `Status: ${status.status}`,
    `Files: ${status.processedFiles}/${status.totalFiles}`,
    `Skipped: ${status.skippedFiles}`,
    `Chunks: ${status.totalChunks}`,
    `Points: ${status.collectionPointCount ?? "unknown"}`,
  ]

  if (status.errorCount > 0) {
    lines.push(`Errors: ${status.errorCount}`)
  }

  return {
    lines,
    toast:
      status.status === "complete"
        ? { variant: "success" as const, message: `Indexed ${status.processedFiles} files.` }
        : status.status === "error"
          ? { variant: "error" as const, message: `Indexing has ${status.errorCount} error(s).` }
          : null,
  }
}

export const tui: TuiPlugin = async (api) => {
  const rootDirectory = api.state?.path?.directory ?? process.cwd()
  let status = await readStatusFile(rootDirectory)
  let lastToastKey = ""

  const refresh = async () => {
    status = await readStatusFile(rootDirectory)
    if (!status) {
      return
    }
    const key = `${status.status}:${status.processedFiles}:${status.totalFiles}:${status.errorCount}`
    if (key === lastToastKey) {
      return
    }
    const view = summarize(status)
    if (view.toast) {
      api.ui.toast({ title: "Qdrant Index", message: view.toast.message, variant: view.toast.variant })
      lastToastKey = key
    }
  }

  const interval = setInterval(() => {
    void refresh()
  }, 2000)

  api.lifecycle?.onDispose(() => clearInterval(interval))

  api.command?.register(() => [
    {
      title: "Qdrant Status",
      value: "qdrant:status",
      description: "Show current semantic index status",
      onSelect: () => {
        const view = summarize(status)
        api.ui.toast({
          title: "Qdrant Index",
          message: view.lines.join(" | "),
          variant: status?.status === "error" ? "error" : "info",
        })
      },
    },
  ])

  api.slots?.register({
    slots: {
      sidebar_content: () => summarize(status).lines.join("\n"),
    },
  })
}
