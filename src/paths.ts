/**
 * Cross-environment path normalization and per-OS data directory helpers.
 *
 * Goals:
 *  1. The same physical project accessed from Windows native, Git Bash / MSYS,
 *     Cygwin, or WSL should resolve to a single stable key — so state files
 *     and Qdrant collection names are shared across those environments.
 *  2. Plugin state (status + reindex trigger) lives in the OS user data dir
 *     instead of the project's `.opencode/` directory, keyed per project.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

export interface NormalizeOptions {
  /** Override `process.platform` — used by tests. */
  platform?: NodeJS.Platform
  /** Override `fs.existsSync` — used by tests. */
  fsExists?: (p: string) => boolean
}

const WINDOWS_DRIVE_RE = /^([a-z]):\//i
const MNT_RE = /^\/mnt\/([a-z])\//i
const CYGDRIVE_RE = /^\/cygdrive\/([a-z])\//i
const MSYS_RE = /^\/([a-z])\//i

/**
 * Normalize a project path so the same physical project is identified
 * identically regardless of which shell/OS environment opened it.
 *
 * The resulting string is suitable for hashing into a stable key but is NOT
 * guaranteed to be a valid path on the current OS — e.g. on Linux a Windows
 * path like `d:/foo` is returned as-is for key stability.
 */
export function normalizeProjectPath(input: string, opts: NormalizeOptions = {}): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("normalizeProjectPath: input must be a non-empty string")
  }

  const platform = opts.platform ?? process.platform
  const fsExists = opts.fsExists ?? fs.existsSync

  // 1. Backslashes → forward slashes
  let p = input.replace(/\\/g, "/")

  // 2. Preserve leading `//` (UNC) while collapsing all other duplicate
  //    slashes — including any extras immediately following the UNC prefix.
  const isUnc = p.startsWith("//")
  if (isUnc) {
    const tail = p.slice(2).replace(/^\/+/, "").replace(/\/{2,}/g, "/")
    p = "//" + tail
  } else {
    p = p.replace(/\/{2,}/g, "/")
  }

  // 3. Reject relative inputs — caller always has an absolute project dir
  const looksAbsolute =
    p.startsWith("/") || WINDOWS_DRIVE_RE.test(p) || isUnc
  if (!looksAbsolute) {
    throw new Error(`normalizeProjectPath: expected absolute path, got "${input}"`)
  }

  // 4. Apply FIRST matching rewrite
  let rewriteApplied = false
  let rewritten = p

  const mntMatch = p.match(MNT_RE)
  if (mntMatch) {
    rewritten = `${mntMatch[1].toLowerCase()}:/` + p.slice(mntMatch[0].length)
    rewriteApplied = true
  }
  if (!rewriteApplied) {
    const cygMatch = p.match(CYGDRIVE_RE)
    if (cygMatch) {
      rewritten = `${cygMatch[1].toLowerCase()}:/` + p.slice(cygMatch[0].length)
      rewriteApplied = true
    }
  }
  if (!rewriteApplied) {
    const msysMatch = p.match(MSYS_RE)
    if (msysMatch && platform === "win32") {
      const candidate = `${msysMatch[1].toLowerCase()}:/` + p.slice(msysMatch[0].length)
      // Only rewrite if the Windows path actually resolves on disk. This
      // protects against misinterpreting a legitimate POSIX `/d/foo` path
      // that happened to be opened from a win32 shell pointing elsewhere.
      if (fsExists(candidate)) {
        rewritten = candidate
        rewriteApplied = true
      }
    }
  }

  p = rewritten

  // 5. Casing:
  //    - Windows-origin (drive letter or UNC): lowercase everything (NTFS is
  //      case-insensitive so two paths differing only in case are the same).
  //    - POSIX-origin: preserve case (ext4, APFS default, etc are case-sensitive).
  const isWindowsOrigin = WINDOWS_DRIVE_RE.test(p) || p.startsWith("//")
  if (isWindowsOrigin) p = p.toLowerCase()

  // 6. Trim a trailing slash, but never from root forms like `c:/` or `/`
  if (p.length > 1 && p.endsWith("/")) {
    const isDriveRoot = /^[a-z]:\/$/.test(p)
    if (!isDriveRoot) p = p.replace(/\/+$/, "")
  }

  return p
}

/**
 * Stable 12-char hex key for a project directory, derived from the normalized
 * path. Used as both the state-directory name and the Qdrant collection suffix.
 */
export function projectKey(dir: string, opts?: NormalizeOptions): string {
  const normalized = normalizeProjectPath(dir, opts)
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12)
}

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const APP_DIR_NAME = "opencode-qdrant"

/**
 * Return the OS-appropriate user data directory for this plugin.
 * - Windows: `%LOCALAPPDATA%\opencode-qdrant\`
 * - macOS:   `~/Library/Application Support/opencode-qdrant/`
 * - Linux:   `$XDG_DATA_HOME/opencode-qdrant/` (falls back to `~/.local/share/...`)
 */
export function getDataDir(): string {
  const platform = process.platform
  if (platform === "win32") {
    const base =
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
    return path.join(base, APP_DIR_NAME)
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP_DIR_NAME)
  }
  const base =
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(base, APP_DIR_NAME)
}

/**
 * Per-project state directory: `<dataDir>/projects/<projectKey>`.
 * The directory is NOT created here — callers mkdir on first write.
 */
export function getProjectDataDir(dir: string): string {
  return path.join(getDataDir(), "projects", projectKey(dir))
}
