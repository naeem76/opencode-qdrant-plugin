import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { minimatch } from "minimatch"
import type { FileEntry, ResolvedConfig } from "./types.js"
import { isGeneratedLikePath, isSensitivePath, normalizeSlashes } from "./utils.js"

const execFileAsync = promisify(execFile)

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "vendor"])
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".mp4",
  ".mp3",
  ".woff",
  ".woff2",
  ".ttf",
  ".exe",
  ".dll",
  ".so",
])

export async function discoverFiles(directory: string, config: ResolvedConfig): Promise<FileEntry[]> {
  const relativePaths = await listPaths(directory)
  const entries: FileEntry[] = []

  for (const relativePath of relativePaths) {
    const normalized = normalizeSlashes(relativePath)
    if (!shouldIncludePath(normalized, config)) {
      continue
    }

    const absolutePath = path.join(directory, relativePath)
    const stat = await fs.stat(absolutePath)
    if (!stat.isFile()) {
      continue
    }
    if (stat.size > config.maxFileSize) {
      continue
    }
    if (BINARY_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
      continue
    }
    if (await looksBinary(absolutePath)) {
      continue
    }

    entries.push({ absolutePath, relativePath: normalized, size: stat.size })
  }

  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  return entries
}

async function listPaths(directory: string) {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "-z"], { cwd: directory, encoding: "buffer" })
    return stdout
      .toString("utf8")
      .split("\0")
      .map((item) => item.trim())
      .filter(Boolean)
  } catch {
    const results: string[] = []
    await walk(directory, directory, results)
    return results
  }
}

async function walk(root: string, current: string, output: string[]) {
  const entries = await fs.readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue
      }
      await walk(root, path.join(current, entry.name), output)
      continue
    }
    if (!entry.isFile()) {
      continue
    }
    output.push(normalizeSlashes(path.relative(root, path.join(current, entry.name))))
  }
}

function shouldIncludePath(relativePath: string, config: ResolvedConfig) {
  if (isSensitivePath(relativePath) || isGeneratedLikePath(relativePath)) {
    return false
  }
  if (config.includePatterns?.length && !config.includePatterns.some((pattern) => minimatch(relativePath, pattern))) {
    return false
  }
  if (config.excludePatterns.some((pattern) => minimatch(relativePath, pattern))) {
    return false
  }
  return true
}

async function looksBinary(filePath: string) {
  const file = await fs.open(filePath, "r")
  try {
    const buffer = Buffer.alloc(512)
    const { bytesRead } = await file.read(buffer, 0, 512, 0)
    for (let index = 0; index < bytesRead; index += 1) {
      if (buffer[index] === 0) {
        return true
      }
    }
    return false
  } finally {
    await file.close()
  }
}
