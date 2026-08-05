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

describe("extractFileSummary — structured summaries", () => {
  test("extracts exported TS/JS symbols", () => {
    const content = [
      "import { x } from './x'",
      "export function foo() { return 1 }",
      "export class Bar { x = 1 }",
      "export interface IBaz { a: number }",
      "export type ID = string",
      "export enum Color { Red, Blue }",
      "export const PI = 3.14",
    ].join("\n")
    const summary = extractFileSummary(content)
    expect(summary.content).toContain("function: foo")
    expect(summary.content).toContain("class: Bar")
    expect(summary.content).toContain("interface: IBaz")
    expect(summary.content).toContain("type: ID")
    expect(summary.content).toContain("enum: Color")
    expect(summary.content).toContain("const: PI")
  })

  test("extracts Python def/class declarations", () => {
    const content = [
      '"""Module docstring."""',
      "import os",
      "def helper():",
      "    pass",
      "class App:",
      "    def run(self):",
      "        pass",
      "async def fetch():",
      "    pass",
    ].join("\n")
    const summary = extractFileSummary(content)
    expect(summary.content).toContain("def: helper")
    expect(summary.content).toContain("class: App")
    expect(summary.content).toContain("def: fetch")
  })

  test("extracts Go func declarations", () => {
    const content = [
      "package main",
      "func main() {}",
      "func (s *Server) Start() {}",
      "func helper() {}",
    ].join("\n")
    const summary = extractFileSummary(content)
    expect(summary.content).toContain("func: main")
    expect(summary.content).toContain("func: Start")
    expect(summary.content).toContain("func: helper")
  })

  test("extracts Rust fn/struct/enum declarations", () => {
    const content = [
      "//! Module doc",
      "pub fn run() {}",
      "pub async fn fetch() {}",
      "pub struct Config { x: u32 }",
      "pub enum Mode { A, B }",
    ].join("\n")
    const summary = extractFileSummary(content)
    expect(summary.content).toContain("fn: run")
    expect(summary.content).toContain("fn: fetch")
    expect(summary.content).toContain("struct: Config")
    expect(summary.content).toContain("enum: Mode")
  })

  test("extracts JSDoc leading comment as part of summary", () => {
    const content = [
      "/**",
      " * Greets a user by name.",
      " * @param name - the user name",
      " */",
      "export function greet(name: string) {",
      "  return `hi ${name}`",
      "}",
    ].join("\n")
    const summary = extractFileSummary(content)
    expect(summary.content).toContain("Greets a user by name")
    expect(summary.content).toContain("function: greet")
  })

  test("extracts Python module docstring", () => {
    const content = [
      '"""Application entry point.',
      "",
      "Handles bootstrapping and CLI parsing.",
      '"""',
      "def main():",
      "    pass",
    ].join("\n")
    const summary = extractFileSummary(content)
    expect(summary.content).toContain("Application entry point")
    expect(summary.content).toContain("def: main")
  })

  test("extracts markdown h1/h2 headers as sections", () => {
    const content = [
      "# README",
      "intro",
      "## Installation",
      "steps",
      "## Usage",
      "more",
    ].join("\n")
    const summary = extractFileSummary(content)
    expect(summary.content).toContain("h1: README")
    expect(summary.content).toContain("h2: Installation")
    expect(summary.content).toContain("h2: Usage")
  })

  test("skips shebang lines before docstring", () => {
    const content = [
      "#!/usr/bin/env node",
      "/**",
      " * CLI tool.",
      " */",
      "export function main() {}",
    ].join("\n")
    const summary = extractFileSummary(content)
    expect(summary.content).toContain("CLI tool")
    expect(summary.content).toContain("function: main")
    expect(summary.content).not.toContain("usr/bin/env")
  })

  test("truncates signature list at MAX_SIGNATURES", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `export function f${i}() {}`)
    const summary = extractFileSummary(lines.join("\n"))
    expect(summary.content).toMatch(/more$/)
  })

  test("falls back to head-of-file when no signatures and no doc", () => {
    const content = "just\nsome\nplain\ntext\nfile"
    const summary = extractFileSummary(content, 3)
    expect(summary.content).toBe("just\nsome\nplain")
  })

  test("summary endLine covers the whole file when structured", () => {
    const content = [
      "export function top() {}",
      "// middle comment",
      "export function bottom() {}",
    ].join("\n")
    const summary = extractFileSummary(content)
    expect(summary.endLine).toBe(3)
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

describe("chunkFile — language-aware boundaries", () => {
  // Bodies must exceed 5 lines to avoid being merged into the previous chunk.
  const body = (n: number) => Array.from({ length: n }, (_, i) => `  x = ${i}`).join("\n")

  test("Python: splits at def / class / async def / decorated functions", () => {
    const content = [
      "import os",
      body(8),
      "def helper():",
      body(8),
      "@decorator",
      "def decorated():",
      body(8),
      "class App:",
      body(8),
      "async def fetch():",
      body(8),
    ].join("\n")
    const chunks = chunkFile(content, 80, 0, "python")
    expect(chunks.length).toBeGreaterThanOrEqual(4)
    expect(chunks.some((c) => c.content.includes("def helper"))).toBe(true)
    expect(chunks.some((c) => c.content.includes("def decorated"))).toBe(true)
    expect(chunks.some((c) => c.content.includes("class App"))).toBe(true)
    expect(chunks.some((c) => c.content.includes("async def fetch"))).toBe(true)
  })

  test("Go: splits at func / type declarations", () => {
    const content = [
      "package main",
      body(8),
      "func main() {",
      body(8),
      "}",
      "func (s *Server) Start() {",
      body(8),
      "}",
      "type Handler struct {",
      body(8),
      "}",
      "type Reader interface {",
      body(8),
      "}",
    ].join("\n")
    const chunks = chunkFile(content, 80, 0, "go")
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    expect(chunks.some((c) => c.content.includes("func main"))).toBe(true)
    expect(chunks.some((c) => c.content.includes("Start()"))).toBe(true)
    expect(chunks.some((c) => c.content.includes("type Handler struct"))).toBe(true)
  })

  test("Rust: splits at fn / struct / enum / impl / trait / mod", () => {
    const content = [
      "use std::io;",
      body(8),
      "pub fn run() {",
      body(8),
      "}",
      "pub async fn fetch() {",
      body(8),
      "}",
      "pub struct Config {",
      body(8),
      "}",
      "pub enum Mode {",
      body(8),
      "}",
      "pub trait Storage {",
      body(8),
      "}",
      "impl Storage for File {",
      body(8),
      "}",
    ].join("\n")
    const chunks = chunkFile(content, 80, 0, "rust")
    expect(chunks.length).toBeGreaterThanOrEqual(5)
    expect(chunks.some((c) => c.content.includes("fn run"))).toBe(true)
    expect(chunks.some((c) => c.content.includes("struct Config"))).toBe(true)
    expect(chunks.some((c) => c.content.includes("enum Mode"))).toBe(true)
    expect(chunks.some((c) => c.content.includes("trait Storage"))).toBe(true)
    expect(chunks.some((c) => c.content.includes("impl Storage"))).toBe(true)
  })

  test("Java: splits at class / method declarations", () => {
    const content = [
      "package com.example;",
      "public class App {",
      body(8),
      "public void run() {",
      body(8),
      "}",
      "private static int compute() {",
      body(8),
      "}",
      "}",
    ].join("\n")
    const chunks = chunkFile(content, 80, 0, "java")
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks.some((c) => c.content.includes("public void run"))).toBe(true)
    expect(chunks.some((c) => c.content.includes("compute()"))).toBe(true)
  })

  test("Ruby: splits at def / class / module / visibility", () => {
    const content = [
      body(8),
      "def helper",
      body(8),
      "end",
      "class App",
      body(8),
      "end",
      "module Mod",
      body(8),
      "end",
      "private",
      "def secret",
      body(8),
      "end",
    ].join("\n")
    const chunks = chunkFile(content, 80, 0, "ruby")
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    expect(chunks.some((c) => c.content.includes("def helper"))).toBe(true)
    expect(chunks.some((c) => c.content.includes("class App"))).toBe(true)
    expect(chunks.some((c) => c.content.includes("module Mod"))).toBe(true)
  })

  test("PHP: splits at function / class / interface / trait", () => {
    const content = [
      "<?php",
      body(8),
      "function helper() {",
      body(8),
      "}",
      "class App {",
      body(8),
      "public function run() {",
      body(8),
      "}",
      "}",
      "interface IApp {",
      body(8),
      "}",
      "trait TApp {",
      body(8),
      "}",
    ].join("\n")
    const chunks = chunkFile(content, 80, 0, "php")
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    expect(chunks.some((c) => c.content.includes("function helper"))).toBe(true)
    expect(chunks.some((c) => c.content.includes("class App"))).toBe(true)
    expect(chunks.some((c) => c.content.includes("interface IApp"))).toBe(true)
  })

  test("C#: splits at class / interface / struct / method", () => {
    const content = [
      "namespace App;",
      "public class Program {",
      body(8),
      "public void Run() {",
      body(8),
      "}",
      "}",
      "public interface IApp {",
      body(8),
      "}",
      "public struct Point {",
      body(8),
      "}",
    ].join("\n")
    const chunks = chunkFile(content, 80, 0, "csharp")
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    expect(chunks.some((c) => c.content.includes("class Program"))).toBe(true)
    expect(chunks.some((c) => c.content.includes("interface IApp"))).toBe(true)
    expect(chunks.some((c) => c.content.includes("struct Point"))).toBe(true)
  })

  test("C: splits at functions / structs / #define", () => {
    const content = [
      "#include <stdio.h>",
      body(8),
      "#define MAX 100",
      body(8),
      "int main() {",
      body(8),
      "}",
      "struct Point {",
      body(8),
      "};",
    ].join("\n")
    const chunks = chunkFile(content, 80, 0, "c")
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks.some((c) => c.content.includes("int main"))).toBe(true)
    expect(chunks.some((c) => c.content.includes("struct Point"))).toBe(true)
  })

  test("SQL: splits at major statements", () => {
    const content = [
      body(8),
      "CREATE TABLE users (id INT);",
      body(8),
      "CREATE INDEX idx ON users(id);",
      body(8),
      "SELECT * FROM users;",
      body(8),
    ].join("\n")
    const chunks = chunkFile(content, 80, 0, "sql")
    expect(chunks.length).toBeGreaterThanOrEqual(2)
  })

  test("Markdown: splits at any header level (h1..h6)", () => {
    const body = Array.from({ length: 8 }, (_, i) => `line${i}`).join("\n")
    const content = ["# Title", body, "## Section", body, "### Sub", body, "#### Deep", body].join("\n")
    const chunks = chunkFile(content, 80, 0, "markdown")
    expect(chunks.length).toBeGreaterThanOrEqual(3)
  })

  test("unknown language falls back to generic patterns", () => {
    const body = Array.from({ length: 8 }, () => "  x = 1").join("\n")
    const content = ["function a() {", body, "}", "function b() {", body, "}"].join("\n")
    const chunks = chunkFile(content, 80, 0, "text")
    expect(chunks.length).toBeGreaterThanOrEqual(2)
  })

  test("no language hint uses only generic patterns (backwards compatible)", () => {
    const body = Array.from({ length: 8 }, () => "  return 1").join("\n")
    const content = ["def helper():", body, "def other():", body].join("\n")
    // Without a python hint, 'def' is not recognized as a boundary.
    const chunksNoHint = chunkFile(content, 80, 0)
    const chunksPython = chunkFile(content, 80, 0, "python")
    expect(chunksPython.length).toBeGreaterThan(chunksNoHint.length)
  })
})