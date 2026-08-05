/**
 * Tests for the chunker: boundary detection, splitting, merging, overlap.
 *
 * Run with: `bun test src/chunker.test.ts`
 */

import { describe, expect, test } from "bun:test"
import { chunkFile, extractFileSummary } from "./chunker.js"

describe("extractFileSummary", () => {
  test("returns first N lines as a summary chunk", () => {
    const content = "line1\nline2\nline3\nline4\nline5"
    const summary = extractFileSummary(content, 3)
    expect(summary.type).toBe("summary")
    expect(summary.startLine).toBe(1)
    expect(summary.endLine).toBe(3)
    expect(summary.content).toBe("line1\nline2\nline3")
  })

  test("uses default 20 lines when maxLines omitted", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n")
    const summary = extractFileSummary(lines)
    expect(summary.endLine).toBe(20)
  })

  test("handles files shorter than maxLines", () => {
    const summary = extractFileSummary("a\nb", 20)
    expect(summary.endLine).toBe(2)
    expect(summary.content).toBe("a\nb")
  })

  test("handles empty content", () => {
    const summary = extractFileSummary("", 20)
    expect(summary.content).toBe("")
    expect(summary.endLine).toBe(1)
  })

  test("handles CRLF line endings", () => {
    const summary = extractFileSummary("a\r\nb\r\nc", 2)
    expect(summary.content).toBe("a\nb")
  })
})

describe("chunkFile — boundary detection", () => {
  test("starts a new chunk at exported function declarations", () => {
    const fooBody = Array.from({ length: 8 }, () => "  return 1").join("\n")
    const barBody = Array.from({ length: 8 }, () => "  return 2").join("\n")
    const content = [
      "import { x } from './x'",
      "export function foo() {",
      fooBody,
      "}",
      "export async function bar() {",
      barBody,
      "}",
    ].join("\n")
    const chunks = chunkFile(content, 80, 0)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    const barChunk = chunks.find((c) => c.content.includes("async function bar"))
    expect(barChunk).toBeDefined()
  })

  test("starts a new chunk at class/interface/type declarations", () => {
    const body = Array.from({ length: 8 }, (_, i) => `  field${i}: number`).join("\n")
    const content = ["interface Foo {", body, "}", "type Bar = string", "class Baz {", body, "}"].join("\n")
    const chunks = chunkFile(content, 80, 0)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
  })

test("starts a new chunk at describe blocks", () => {
    // Body lines must NOT match the boundary pattern (avoid describe/it/test)
    const body = Array.from({ length: 8 }, (_, i) => `  expect(x).toBe(${i})`).join("\n")
    const content = ["describe('module', () => {", body, "})", "describe('other', () => {", body, "}"].join("\n")
    const chunks = chunkFile(content, 80, 0)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
  })

  test("starts a new chunk at markdown headers", () => {
    const body = Array.from({ length: 8 }, (_, i) => `line${i}`).join("\n")
    const content = ["# Title", body, "## Section A", body, "## Section B", body].join("\n")
    const chunks = chunkFile(content, 80, 0)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
  })

  test("starts a new chunk at double-blank-line separators", () => {
    // Chunker treats a blank line followed by another blank line as a boundary;
    // single blanks do not split. Bodies >5 lines so they don't merge away.
    const a = Array.from({ length: 8 }, (_, i) => `a${i}`).join("\n")
    const b = Array.from({ length: 8 }, (_, i) => `b${i}`).join("\n")
    const content = `${a}\n\n\n${b}`
    const chunks = chunkFile(content, 80, 0)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
  })

  test("starts a new chunk at arrow-function const assignments", () => {
    const body = Array.from({ length: 8 }, () => "  return 1").join("\n")
    const content = [`const f = () => {`, body, `}`, `const g = async () => {`, body, `}`].join("\n")
    const chunks = chunkFile(content, 80, 0)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
  })
})

describe("chunkFile — splitting large ranges", () => {
  test("splits a range longer than maxLines", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line${i}`)
    const content = lines.join("\n")
    const chunks = chunkFile(content, 50, 0)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.endLine - chunk.startLine + 1).toBeLessThanOrEqual(50)
    }
  })

  test("prefers blank lines as split points", () => {
    const lines = Array.from({ length: 100 }, (_, i) => {
      if (i === 55 || i === 56) return ""
      return `line${i}`
    })
    const content = lines.join("\n")
    const chunks = chunkFile(content, 50, 0)
    // At least one chunk boundary should fall on a blank line
    const boundaries = chunks.map((c) => c.endLine)
    expect(boundaries.some((b) => lines[b - 1] === "")).toBe(true)
  })
})

describe("chunkFile — merging tiny ranges", () => {
  test("merges ranges smaller than 5 lines into the previous chunk", () => {
    const content = "function big() {\n" + "  a\n".repeat(30) + "}\n" + "x\n"
    const chunks = chunkFile(content, 80, 0)
    // The tiny trailing "x" range should be merged into the previous chunk
    expect(chunks.length).toBe(1)
  })
})

describe("chunkFile — overlap", () => {
  test("overlaps adjacent chunks by overlapLines", () => {
    const content = [
      "function a() {",
      "  return 1",
      "}",
      "",
      "function b() {",
      "  return 2",
      "}",
    ].join("\n")
    const chunks = chunkFile(content, 80, 2)
    if (chunks.length >= 2) {
      // Second chunk should start 2 lines earlier than its natural boundary
      const firstChunkEnd = chunks[0].endLine
      const secondChunkStart = chunks[1].startLine
      expect(secondChunkStart).toBeLessThanOrEqual(firstChunkEnd)
    }
  })

  test("does not produce negative start lines for first chunk", () => {
    const content = "function a() { return 1 }"
    const chunks = chunkFile(content, 80, 10)
    expect(chunks[0].startLine).toBe(1)
  })
})

describe("chunkFile — edge cases", () => {
  test("empty content produces no chunks", () => {
    expect(chunkFile("", 80, 0)).toEqual([])
  })

  test("single line produces one chunk", () => {
    const chunks = chunkFile("hello", 80, 0)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].content).toBe("hello")
  })

  test("whitespace-only lines are trimmed from chunk content", () => {
    const content = "foo\n\n\nbar"
    const chunks = chunkFile(content, 80, 0)
    for (const chunk of chunks) {
      expect(chunk.content.trim()).toBe(chunk.content)
    }
  })

  test("all chunks are type 'code'", () => {
    const content = "function a() {}\nfunction b() {}"
    const chunks = chunkFile(content, 80, 0)
    for (const chunk of chunks) {
      expect(chunk.type).toBe("code")
    }
  })
})