import crypto from "node:crypto"
import path from "node:path"
import { projectKey } from "./paths.js"

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".md": "markdown",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".rb": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".c": "c",
  ".h": "c",
  ".hpp": "cpp",
  ".swift": "swift",
  ".scala": "scala",
  ".sql": "sql",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
}

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex")
}

export function detectLanguage(filePath: string): string {
  return LANGUAGE_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? "text"
}

export function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/")
}

export function truncate(text: string, maxLength = 800): string {
  if (text.length <= maxLength) {
    return text
  }
  return `${text.slice(0, maxLength - 3)}...`
}

export function isSensitivePath(filePath: string): boolean {
  const normalized = normalizeSlashes(filePath).toLowerCase()
  if (normalized === ".env") {
    return true
  }
  return [
    "/.env",
    ".env.",
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".keystore",
    "secret",
    "credential",
  ].some((needle) => normalized.includes(needle))
}

export function isGeneratedLikePath(filePath: string): boolean {
  const normalized = normalizeSlashes(filePath).toLowerCase()
  return [
    ".min.js",
    ".min.css",
    "package-lock.json",
    "bun.lock",
    "yarn.lock",
    "pnpm-lock.yaml",
  ].some((needle) => normalized.endsWith(needle) || normalized.includes(`/${needle}`))
}

export function collectionNameForProject(basePath: string, dimensions: number): string {
  return `opencode_${projectKey(basePath)}_${dimensions}`
}
