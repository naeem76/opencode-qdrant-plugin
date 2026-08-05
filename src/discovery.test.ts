/**
 * Tests for file discovery: gitignore handling, binary skipping, size limits, include/exclude.
 *
 * Run with: `bun test src/discovery.test.ts`
 */

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { discoverFiles } from "./discovery.js"
import type { ResolvedConfig } from "./types.js"

let tmpRoot: string

const baseConfig = (overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
  qdrantUrl: "http://localhost:6333",
  embeddingProvider: "local",
  embeddingModel: "Xenova/all-MiniLM-L6-v2",
  embeddingApiKey: undefined,
  embeddingApiUrl: "https://api.openai.com/v1",
  embeddingDimensions: 384,
  maxFileSize: 100_000,
  chunkMaxLines: 80,
  chunkOverlapLines: 10,
  excludePatterns: [],
  includePatterns: undefined,
  searchLimit: 10,
  scoreThreshold: 0.3,
  collectionName: undefined,
  concurrency: 8,
  indexOnStart: true,
  watchFiles: true,
  watchDebounceMs: 2000,
  localEmbeddingBatchSize: 16,
  localEmbeddingDtype: "q8",
  localWorkerCommand: "node",
  ...overrides,
})

async function write(rel: string, content: string) {
  const abs = path.join(tmpRoot, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, "utf8")
  return abs
}

async function gitInit() {
  await fs.mkdir(path.join(tmpRoot, ".git"), { recursive: true })
  // git ls-files reads the index; without a real git we rely on the
  // fallback walk path, which honors .gitignore. Initialize gitignore.
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-qdrant-test-"))
  await gitInit()
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe("discoverFiles — basic inclusion", () => {
  test("finds plain text files", async () => {
    await write("src/foo.ts", "export const x = 1\n")
    await write("README.md", "# hi\n")
    const files = await discoverFiles(tmpRoot, baseConfig())
    const rels = files.map((f) => f.relativePath).sort()
    expect(rels).toContain("src/foo.ts")
    expect(rels).toContain("README.md")
  })

  test("returns sorted relative paths", async () => {
    await write("z.ts", "a\n")
    await write("a.ts", "b\n")
    const files = await discoverFiles(tmpRoot, baseConfig())
    const rels = files.map((f) => f.relativePath)
    expect(rels).toEqual([...rels].sort())
  })

  test("populates absolutePath and size", async () => {
    await write("foo.txt", "hello\n")
    const files = await discoverFiles(tmpRoot, baseConfig())
    const foo = files.find((f) => f.relativePath === "foo.txt")
    expect(foo).toBeDefined()
    expect(foo!.absolutePath).toBe(path.join(tmpRoot, "foo.txt"))
    expect(foo!.size).toBe(6)
  })
})

describe("discoverFiles — binary exclusion", () => {
  test("skips files with binary extensions", async () => {
    await write("image.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await write("code.ts", "x\n")
    const files = await discoverFiles(tmpRoot, baseConfig())
    expect(files.map((f) => f.relativePath)).not.toContain("image.png")
    expect(files.map((f) => f.relativePath)).toContain("code.ts")
  })

  test("skips files detected as binary by content", async () => {
    // .txt extension is not in the binary-extension list, but a NUL byte
    // in the first 512 bytes triggers content-based binary detection.
    await write("weird.txt", "a\x00b\n")
    await write("plain.txt", "just text\n")
    const files = await discoverFiles(tmpRoot, baseConfig())
    const rels = files.map((f) => f.relativePath)
    expect(rels).not.toContain("weird.txt")
    expect(rels).toContain("plain.txt")
  })
})

describe("discoverFiles — size limit", () => {
  test("skips files larger than maxFileSize", async () => {
    await write("big.txt", "x".repeat(200))
    await write("small.txt", "x".repeat(10))
    const files = await discoverFiles(tmpRoot, baseConfig({ maxFileSize: 100 }))
    const rels = files.map((f) => f.relativePath)
    expect(rels).not.toContain("big.txt")
    expect(rels).toContain("small.txt")
  })
})

describe("discoverFiles — gitignore", () => {
  test("honors .gitignore patterns", async () => {
    await write(".gitignore", "dist\n*.log\n")
    await write("keep.ts", "a\n")
    await write("dist/built.js", "b\n")
    await write("debug.log", "c\n")
    const files = await discoverFiles(tmpRoot, baseConfig())
    const rels = files.map((f) => f.relativePath)
    expect(rels).toContain("keep.ts")
    expect(rels).not.toContain("dist/built.js")
    expect(rels).not.toContain("debug.log")
  })

  test("honors nested .gitignore files", async () => {
    await write(".gitignore", "node_modules\n")
    await write("src/.gitignore", "secret.txt\n")
    await write("src/app.ts", "a\n")
    await write("src/secret.txt", "s\n")
    const files = await discoverFiles(tmpRoot, baseConfig())
    const rels = files.map((f) => f.relativePath)
    expect(rels).toContain("src/app.ts")
    expect(rels).not.toContain("src/secret.txt")
  })
})

describe("discoverFiles — sensitive / generated paths", () => {
  test("skips .env files", async () => {
    await write(".env", "SECRET=1\n")
    await write("src/.env.local", "X=2\n")
    await write("keep.ts", "a\n")
    const files = await discoverFiles(tmpRoot, baseConfig())
    const rels = files.map((f) => f.relativePath)
    expect(rels).not.toContain(".env")
    expect(rels).not.toContain("src/.env.local")
    expect(rels).toContain("keep.ts")
  })

  test("skips key/cert files", async () => {
    await write("server.pem", "-----BEGIN-----\n")
    await write("id_rsa.key", "ssh-key\n")
    await write("keep.ts", "a\n")
    const files = await discoverFiles(tmpRoot, baseConfig())
    const rels = files.map((f) => f.relativePath)
    expect(rels).not.toContain("server.pem")
    expect(rels).not.toContain("id_rsa.key")
    expect(rels).toContain("keep.ts")
  })

  test("skips minified and lock files", async () => {
    await write("bundle.min.js", "void 0\n")
    await write("package-lock.json", "{}\n")
    await write("keep.ts", "a\n")
    const files = await discoverFiles(tmpRoot, baseConfig())
    const rels = files.map((f) => f.relativePath)
    expect(rels).not.toContain("bundle.min.js")
    expect(rels).not.toContain("package-lock.json")
    expect(rels).toContain("keep.ts")
  })
})

describe("discoverFiles — include / exclude patterns", () => {
  test("excludePatterns removes matching files", async () => {
    await write("src/a.ts", "a\n")
    await write("test/b.ts", "b\n")
    const files = await discoverFiles(tmpRoot, baseConfig({ excludePatterns: ["test/**"] }))
    const rels = files.map((f) => f.relativePath)
    expect(rels).toContain("src/a.ts")
    expect(rels).not.toContain("test/b.ts")
  })

  test("includePatterns restricts to matching files", async () => {
    await write("src/a.ts", "a\n")
    await write("docs/b.md", "b\n")
    const files = await discoverFiles(tmpRoot, baseConfig({ includePatterns: ["src/**"] }))
    const rels = files.map((f) => f.relativePath)
    expect(rels).toContain("src/a.ts")
    expect(rels).not.toContain("docs/b.md")
  })
})

describe("discoverFiles — skip directories", () => {
  test("skips .git and node_modules even without gitignore", async () => {
    await write("keep.ts", "a\n")
    await write(".git/config", "[core]\n")
    await write("node_modules/lib/index.js", "module.exports\n")
    const files = await discoverFiles(tmpRoot, baseConfig())
    const rels = files.map((f) => f.relativePath)
    expect(rels).toContain("keep.ts")
    expect(rels).not.toContain("node_modules/lib/index.js")
    // .git is in SKIP_DIRS
    expect(rels).not.toContain(".git/config")
  })
})
