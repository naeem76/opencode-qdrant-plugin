import type { Chunk } from "./types.js"

const BOUNDARY_PATTERNS = [
  /^(export\s+)?(async\s+)?(function|class|interface|type|enum)\b/,
  /^(public|private|protected)\s+/,
  /^(const|let|var)\s+[A-Za-z0-9_$]+\s*=\s*(async\s*)?(\(|function)/,
  /^(describe|it|test|beforeEach|afterEach)\s*\(/,
  /^#{2,6}\s/,
]

/**
 * Per-language boundary regexes. Applied in addition to the generic
 * BOUNDARY_PATTERNS when a language hint is supplied to chunkFile.
 *
 * Each pattern marks the start of a new logical chunk — typically the
 * first line of a function/class/method/section declaration.
 */
const LANGUAGE_BOUNDARIES: Record<string, RegExp[]> = {
  python: [
    /^\s*(?:async\s+)?def\s+[A-Za-z_][A-Za-z0-9_]*/,
    /^\s*class\s+[A-Za-z_][A-Za-z0-9_]*/,
    /^\s*@\w+/,
  ],
  go: [
    /^\s*func\s+(?:\([^)]*\)\s+)?[A-Za-z0-9_]+\s*\(/,
    /^\s*type\s+[A-Za-z0-9_]+\s+(?:struct|interface|func)/,
  ],
  rust: [
    /^\s*(?:pub\s+)?(?:async\s+)?fn\s+[A-Za-z0-9_]+/,
    /^\s*(?:pub\s+)?struct\s+[A-Za-z0-9_]+/,
    /^\s*(?:pub\s+)?enum\s+[A-Za-z0-9_]+/,
    /^\s*(?:pub\s+)?(?:trait|impl|mod)\s+/,
    /^\s*macro_rules!\s+/,
  ],
  java: [
    /^\s*(?:public|private|protected|static|final|\s)*\s*(?:class|interface|enum|record)\s+/,
    /^\s*(?:public|private|protected|static|final|synchronized|\s)*\s*(?:[A-Za-z_][\w.<>\[\],?\s]*)\s+[A-Za-z_]\w*\s*\(/,
  ],
  kotlin: [
    /^\s*(?:public|private|protected|internal|open|sealed|data|\s)*\s*fun\s+/,
    /^\s*(?:public|private|protected|internal|\s)*\s*(?:class|object|interface|enum class)\s+/,
  ],
  ruby: [
    /^\s*(?:def|class|module)\s+/,
    /^\s*(?:public|private|protected)\s+$/,
  ],
  php: [
    /^\s*(?:public|private|protected|static|\s)*\s*function\s+/,
    /^\s*(?:abstract\s+|final\s+)?class\s+/,
    /^\s*interface\s+/,
    /^\s*trait\s+/,
  ],
  csharp: [
    /^\s*(?:public|private|protected|internal|static|sealed|abstract|\s)*\s*(?:class|interface|struct|enum|record)\s+/,
    /^\s*(?:public|private|protected|internal|static|virtual|override|async|\s)*\s+[A-Za-z_]\w*\s*\(/,
  ],
  cpp: [
    /^\s*(?:template\s*<[^>]*>\s*)?(?:inline\s+|constexpr\s+|static\s+)?[A-Za-z_][\w:&*<>\[\]\s]*\s+[A-Za-z_]\w*\s*\(/,
    /^\s*(?:class|struct|enum class|enum)\s+/,
    /^\s*namespace\s+/,
  ],
  c: [
    /^\s*(?:static\s+|inline\s+)?[A-Za-z_][\w:*&<>\[\]\s]*\s+[A-Za-z_]\w*\s*\(/,
    /^\s*(?:struct|enum|union)\s+/,
    /^\s*#\s*define\s+/,
  ],
  sql: [/^\s*(?:CREATE|ALTER|DROP|SELECT|INSERT|UPDATE|DELETE|WITH)\b/i],
  shell: [/^\s*(?:function\s+)?[A-Za-z_]\w*\s*\(\s*\)\s*\{/],
  markdown: [/^#{1,6}\s/],
}

/**
 * Signature patterns used to build a structured file summary.
 *
 * Each entry: [regex, kind]. Captured group 1 is the symbol name.
 */
const SIGNATURE_PATTERNS: Array<[RegExp, string]> = [
  [/^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/, "function"],
  [/^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\(/, "function"],
  [/^\s*export\s+(?:default\s+)?class\s+([A-Za-z0-9_$]+)/, "class"],
  [/^\s*export\s+(?:default\s+)?interface\s+([A-Za-z0-9_$]+)/, "interface"],
  [/^\s*export\s+(?:default\s+)?type\s+([A-Za-z0-9_$]+)/, "type"],
  [/^\s*export\s+(?:default\s+)?enum\s+([A-Za-z0-9_$]+)/, "enum"],
  [/^\s*export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/, "const"],
  // Python
  [/^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/, "def"],
  [/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/, "class"],
  // Go
  [/^\s*func\s+(?:\([^)]+\)\s+)?([A-Za-z0-9_]+)/, "func"],
  // Rust
  [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/, "fn"],
  [/^\s*(?:pub\s+)?struct\s+([A-Za-z0-9_]+)/, "struct"],
  [/^\s*(?:pub\s+)?enum\s+([A-Za-z0-9_]+)/, "enum"],
  // Java/Kotlin
  [/^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?class\s+([A-Za-z0-9_]+)/, "class"],
  // Ruby
  [/^\s*(?:def|class|module)\s+([A-Za-z0-9_]+)/, "def"],
  // Markdown: top-level headers as section names
  [/^\s*#\s+(.+?)\s*$/, "h1"],
  [/^\s*##\s+(.+?)\s*$/, "h2"],
]

/** Max number of signatures retained in a summary (keeps payload small). */
const MAX_SIGNATURES = 40

/**
 * Build a structured file summary.
 *
 * Walks the whole file extracting exported/declared symbols, leading
 * docstring/comment block, and a trailing snippet of the first non-trivial
 * lines. Falls back to the first `maxLines` lines when no signatures are
 * found and no docstring is present, so behavior is unchanged for files
 * that don't match any known declaration pattern (e.g. config files,
 * prose-heavy markdown, raw text).
 *
 * The summary chunk's `startLine` is always 1 so callers reading the
 * payload continue to treat it as a file-level overview; `endLine` is
 * the last line referenced (docstring + last signature) but the
 * `content` field is a structured, human-readable digest, not raw text.
 */
export function extractFileSummary(content: string, maxLines = 20): Chunk {
  const lines = content.split(/\r?\n/)

  const leadingDoc = extractLeadingDoc(lines)
  const signatures = extractSignatures(lines)

  // No structured content — fall back to the original head-of-file behavior.
  if (signatures.length === 0 && !leadingDoc) {
    const head = lines.slice(0, maxLines)
    return {
      type: "summary",
      startLine: 1,
      endLine: Math.max(head.length, 1),
      content: head.join("\n").trim(),
    }
  }

  const parts: string[] = []
  if (leadingDoc) {
    parts.push(leadingDoc)
  }
  if (signatures.length > 0) {
    parts.push("Exports / declarations:")
    for (const sig of signatures.slice(0, MAX_SIGNATURES)) {
      parts.push(`  ${sig.kind}: ${sig.name}`)
    }
    if (signatures.length > MAX_SIGNATURES) {
      parts.push(`  ... and ${signatures.length - MAX_SIGNATURES} more`)
    }
  }

  return {
    type: "summary",
    startLine: 1,
    endLine: lines.length,
    content: parts.join("\n").trim(),
  }
}

/**
 * Extract a leading docstring / comment block, if any.
 *
 * Recognizes:
 *   - /** ... *\/  (JSDoc)
 *   - /// or //!  (Rust inner doc)
 *   - """ ... """  (Python module docstring, first one only)
 *   - #!shebang lines are skipped (they're not documentation)
 *
 * Stops at the first non-comment, non-blank line. Returns the joined
 * comment text without markers, or null when no leading doc is found.
 */
function extractLeadingDoc(lines: string[]): string | null {
  let index = 0
  // Skip shebang and blank lines before the doc starts.
  while (index < lines.length) {
    const line = lines[index].trim()
    if (line === "" || line.startsWith("#!")) {
      index += 1
      continue
    }
    break
  }

  if (index >= lines.length) return null

  const start = index
  const first = lines[index].trim()

  // JSDoc /** ... */
  if (first.startsWith("/**") || first.startsWith("/*")) {
    const end: number[] = []
    for (let i = index; i < lines.length; i += 1) {
      end.push(i)
      if (lines[i].includes("*/")) {
        index = i + 1
        break
      }
    }
    return lines
      .slice(start, index)
      .map((l) => l.replace(/^\s*\/\*\*?/, "").replace(/^\s*\*/, "").replace(/\*\/\s*$/, "").trim())
      .filter((l) => l.length > 0)
      .join("\n") || null
  }

  // Python module docstring: """ ... """
  if (first.startsWith('"""') || first.startsWith("'''")) {
    const quote = first.slice(0, 3)
    const end: number[] = []
    for (let i = index; i < lines.length; i += 1) {
      end.push(i)
      if (i > start && lines[i].includes(quote)) {
        index = i + 1
        break
      }
      // Single-line docstring: """ ... """
      if (i === start && first.endsWith(quote) && first.length > 3) {
        index = i + 1
        break
      }
    }
    return lines
      .slice(start, index)
      .map((l) => l.replace(new RegExp(quote, "g"), "").trim())
      .filter((l) => l.length > 0)
      .join("\n") || null
  }

  // Line-comment blocks: /// or //! (Rust), or # (shell/python/bash)
  if (first.startsWith("//") || first.startsWith("#")) {
    const isDocLine = (l: string) => {
      const t = l.trim()
      return (
        t.startsWith("///") ||
        t.startsWith("//!") ||
        // Shell-style: only when the whole block is comments (we verify below)
        t.startsWith("#")
      )
    }
    const end: number[] = []
    for (let i = index; i < lines.length; i += 1) {
      const t = lines[i].trim()
      if (t === "") {
        // Allow a single blank line inside a comment block.
        if (i + 1 < lines.length && isDocLine(lines[i + 1].trim())) {
          end.push(i)
          continue
        }
        break
      }
      if (!isDocLine(t)) break
      end.push(i)
    }
    if (end.length === 0) return null
    index = end[end.length - 1] + 1
    return lines
      .slice(start, index)
      .map((l) => l.replace(/^\s*\/\/\/?/, "").replace(/^\s*#/, "").trim())
      .filter((l) => l.length > 0)
      .join("\n") || null
  }

  return null
}

interface Signature {
  kind: string
  name: string
}

function extractSignatures(lines: string[]): Signature[] {
  const sigs: Signature[] = []
  for (const line of lines) {
    for (const [pattern, kind] of SIGNATURE_PATTERNS) {
      const match = line.match(pattern)
      if (match) {
        sigs.push({ kind, name: match[1] ?? "(anonymous)" })
        break
      }
    }
    if (sigs.length >= MAX_SIGNATURES * 2) break
  }
  return sigs
}

export function chunkFile(
  content: string,
  maxLines: number,
  overlapLines: number,
  language?: string,
): Chunk[] {
  const lines = content.split(/\r?\n/)
  const starts = new Set<number>([0])
  const langBoundaries = language ? LANGUAGE_BOUNDARIES[language] : undefined
  const allPatterns = langBoundaries ? [...BOUNDARY_PATTERNS, ...langBoundaries] : BOUNDARY_PATTERNS

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) {
      if (!lines[index + 1]?.trim()) {
        starts.add(index + 1)
      }
      continue
    }

    if (allPatterns.some((pattern) => pattern.test(line))) {
      starts.add(index)
    }
  }

  const sortedStarts = [...starts].filter((value) => value < lines.length).sort((a, b) => a - b)
  const ranges: Array<[number, number]> = []

  for (let index = 0; index < sortedStarts.length; index += 1) {
    const start = sortedStarts[index]
    const next = sortedStarts[index + 1] ?? lines.length
    splitLargeRange(lines, start, next, maxLines, ranges)
  }

  const merged = mergeTinyRanges(ranges, maxLines)
  const chunks: Chunk[] = []
  for (const [index, [start, end]] of merged.entries()) {
      const expandedStart = Math.max(0, index === 0 ? start : start - overlapLines)
      const slice = lines.slice(expandedStart, end)
      const chunkContent = slice.join("\n").trim()
      if (!chunkContent) {
        continue
      }
      chunks.push({
        type: "code" as const,
        startLine: expandedStart + 1,
        endLine: end,
        content: chunkContent,
      })
  }
  return chunks
}

function splitLargeRange(
  lines: string[],
  start: number,
  end: number,
  maxLines: number,
  output: Array<[number, number]>,
) {
  let cursor = start
  while (cursor < end) {
    let next = Math.min(cursor + maxLines, end)
    if (next < end) {
      for (let probe = next; probe > cursor + Math.floor(maxLines / 2); probe -= 1) {
        if (!lines[probe - 1]?.trim()) {
          next = probe
          break
        }
      }
    }
    output.push([cursor, next])
    cursor = next
  }
}

function mergeTinyRanges(ranges: Array<[number, number]>, maxLines: number) {
  const merged: Array<[number, number]> = []
  for (const range of ranges) {
    const size = range[1] - range[0]
    const previous = merged[merged.length - 1]
    if (previous && size < 5 && range[1] - previous[0] <= maxLines) {
      previous[1] = range[1]
      continue
    }
    merged.push([...range])
  }
  return merged
}
