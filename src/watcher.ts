/**
 * Debounced recursive file watcher.
 *
 * Uses Node's built-in fs.watch with recursive=true (supported on Win32,
 * macOS 13+, and Bun). On platforms without recursive support, falls back
 * to per-directory watches at the cost of more handles.
 *
 * Calls `onChange()` after activity settles for `debounceMs` ms. Skips
 * paths that don't look like source files (uses the same detection as
 * discovery.ts: sensitive / generated / binary / oversized are ignored)
 * so editor temp files, .git churn, and node_modules noise don't fire
 * constant reindexes.
 */

import fs from "node:fs"
import path from "node:path"
import { isGeneratedLikePath, isSensitivePath, normalizeSlashes } from "./utils.js"

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf",
  ".zip", ".tar", ".gz", ".mp4", ".mp3", ".woff", ".woff2", ".ttf",
  ".exe", ".dll", ".so",
])

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".next", ".cache", "vendor",
])

export interface WatcherOptions {
  rootDirectory: string
  debounceMs: number
  onChange: (changedPaths: string[]) => void
}

export interface FileWatcher {
  close(): void
}

export function startFileWatcher(opts: WatcherOptions): FileWatcher {
  let timer: ReturnType<typeof setTimeout> | null = null
  const pending = new Set<string>()

  const schedule = (relPath: string) => {
    pending.add(relPath)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const paths = [...pending]
      pending.clear()
      if (paths.length > 0) {
        opts.onChange(paths)
      }
    }, opts.debounceMs)
  }

  const shouldIgnore = (relPath: string): boolean => {
    if (!relPath || relPath === ".") return true
    if (isSensitivePath(relPath) || isGeneratedLikePath(relPath)) return true
    const parts = relPath.split("/")
    for (const part of parts) {
      if (SKIP_DIRS.has(part)) return true
    }
    const ext = path.extname(relPath).toLowerCase()
    if (BINARY_EXTENSIONS.has(ext)) return true
    return false
  }

  // Recursive watch if supported; else per-directory fallback.
  let watchers: fs.FSWatcher[] = []
  let closed = false

  try {
    const w = fs.watch(opts.rootDirectory, { recursive: true }, (event, filename) => {
      if (closed || !filename) return
      const rel = normalizeSlashes(filename.toString())
      if (shouldIgnore(rel)) return
      schedule(rel)
    })
    watchers.push(w)
  } catch {
    // Recursive not supported — fall back to a directory walk.
    const dirs: string[] = [opts.rootDirectory]
    while (dirs.length > 0) {
      const dir = dirs.pop()!
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (SKIP_DIRS.has(entry.name)) continue
        const full = path.join(dir, entry.name)
        const rel = normalizeSlashes(path.relative(opts.rootDirectory, full))
        if (shouldIgnore(rel + "/")) continue
        dirs.push(full)
        try {
          const w = fs.watch(full, (event, filename) => {
            if (closed || !filename) return
            const abs = path.join(full, filename.toString())
            const rel = normalizeSlashes(path.relative(opts.rootDirectory, abs))
            if (shouldIgnore(rel)) return
            schedule(rel)
          })
          watchers.push(w)
        } catch {
          // ignore
        }
      }
    }
  }

  return {
    close() {
      closed = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      pending.clear()
      for (const w of watchers) {
        try {
          w.close()
        } catch {
          // ignore
        }
      }
      watchers = []
    },
  }
}