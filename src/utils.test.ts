/**
 * Tests for utility helpers: language detection, path sensitivity, generated-path detection.
 *
 * Run with: `bun test src/utils.test.ts`
 */

import { describe, expect, test } from "bun:test"
import {
  collectionNameForProject,
  detectLanguage,
  isGeneratedLikePath,
  isSensitivePath,
  normalizeSlashes,
  sha256,
  truncate,
} from "./utils.js"

describe("sha256", () => {
  test("produces a 64-char hex string", () => {
    const hash = sha256("hello")
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  test("is deterministic for the same input", () => {
    expect(sha256("test")).toBe(sha256("test"))
  })

  test("differs for different inputs", () => {
    expect(sha256("a")).not.toBe(sha256("b"))
  })
})

describe("detectLanguage", () => {
  test("maps common extensions", () => {
    expect(detectLanguage("foo.ts")).toBe("typescript")
    expect(detectLanguage("foo.tsx")).toBe("typescript")
    expect(detectLanguage("foo.js")).toBe("javascript")
    expect(detectLanguage("foo.jsx")).toBe("javascript")
    expect(detectLanguage("foo.mjs")).toBe("javascript")
    expect(detectLanguage("foo.cjs")).toBe("javascript")
    expect(detectLanguage("foo.json")).toBe("json")
    expect(detectLanguage("foo.md")).toBe("markdown")
    expect(detectLanguage("foo.py")).toBe("python")
    expect(detectLanguage("foo.go")).toBe("go")
    expect(detectLanguage("foo.rs")).toBe("rust")
    expect(detectLanguage("foo.java")).toBe("java")
    expect(detectLanguage("foo.cs")).toBe("csharp")
    expect(detectLanguage("foo.cpp")).toBe("cpp")
    expect(detectLanguage("foo.h")).toBe("c")
    expect(detectLanguage("foo.swift")).toBe("swift")
    expect(detectLanguage("foo.sql")).toBe("sql")
    expect(detectLanguage("foo.yaml")).toBe("yaml")
    expect(detectLanguage("foo.yml")).toBe("yaml")
    expect(detectLanguage("foo.sh")).toBe("shell")
  })

  test("returns 'text' for unknown extensions", () => {
    expect(detectLanguage("foo.xyz")).toBe("text")
    expect(detectLanguage("README")).toBe("text")
  })

  test("is case-insensitive on extensions", () => {
    expect(detectLanguage("FOO.TS")).toBe("typescript")
    expect(detectLanguage("Foo.PY")).toBe("python")
  })
})

describe("normalizeSlashes", () => {
  test("converts backslashes to forward slashes", () => {
    expect(normalizeSlashes("a\\b\\c")).toBe("a/b/c")
  })

  test("leaves forward slashes untouched", () => {
    expect(normalizeSlashes("a/b/c")).toBe("a/b/c")
  })

  test("handles mixed slashes", () => {
    expect(normalizeSlashes("a\\b/c\\d")).toBe("a/b/c/d")
  })

  test("handles Windows drive paths", () => {
    expect(normalizeSlashes("C:\\Users\\foo")).toBe("C:/Users/foo")
  })
})

describe("truncate", () => {
  test("returns the input when shorter than maxLength", () => {
    expect(truncate("hello", 10)).toBe("hello")
  })

  test("returns the input when exactly maxLength", () => {
    expect(truncate("hello", 5)).toBe("hello")
  })

  test("adds ellipsis when longer than maxLength", () => {
    expect(truncate("hello world", 8)).toBe("hello...")
  })

  test("uses default maxLength of 800", () => {
    const long = "a".repeat(900)
    const result = truncate(long)
    expect(result).toHaveLength(800)
    expect(result.endsWith("...")).toBe(true)
  })
})

describe("isSensitivePath", () => {
  test("flags .env files", () => {
    expect(isSensitivePath(".env")).toBe(true)
    expect(isSensitivePath(".env.local")).toBe(true)
    expect(isSensitivePath("config/.env")).toBe(true)
  })

  test("flags .env. prefixed files", () => {
    expect(isSensitivePath(".env.production")).toBe(true)
  })

  test("flags key/cert files", () => {
    expect(isSensitivePath("server.pem")).toBe(true)
    expect(isSensitivePath("private.key")).toBe(true)
    expect(isSensitivePath("cert.p12")).toBe(true)
    expect(isSensitivePath("cert.pfx")).toBe(true)
    expect(isSensitivePath("store.keystore")).toBe(true)
  })

  test("flags paths containing 'secret' or 'credential'", () => {
    expect(isSensitivePath("api/secrets.json")).toBe(true)
    expect(isSensitivePath("config/credentials.yaml")).toBe(true)
  })

  test("passes normal code paths", () => {
    expect(isSensitivePath("src/index.ts")).toBe(false)
    expect(isSensitivePath("README.md")).toBe(false)
    expect(isSensitivePath("package.json")).toBe(false)
  })

  test("is case-insensitive", () => {
    expect(isSensitivePath("SECRETS.YAML")).toBe(true)
    expect(isSensitivePath("CREDENTIALS")).toBe(true)
  })
})

describe("isGeneratedLikePath", () => {
  test("flags minified files", () => {
    expect(isGeneratedLikePath("bundle.min.js")).toBe(true)
    expect(isGeneratedLikePath("style.min.css")).toBe(true)
  })

  test("flags lockfiles", () => {
    expect(isGeneratedLikePath("package-lock.json")).toBe(true)
    expect(isGeneratedLikePath("bun.lock")).toBe(true)
    expect(isGeneratedLikePath("yarn.lock")).toBe(true)
    expect(isGeneratedLikePath("pnpm-lock.yaml")).toBe(true)
  })

  test("flags nested lockfiles", () => {
    expect(isGeneratedLikePath("packages/foo/package-lock.json")).toBe(true)
  })

  test("passes normal files", () => {
    expect(isGeneratedLikePath("src/index.ts")).toBe(false)
    expect(isGeneratedLikePath("bundle.js")).toBe(false)
    expect(isGeneratedLikePath("package.json")).toBe(false)
  })
})

describe("collectionNameForProject", () => {
  test("includes the plugin prefix and dimensions", () => {
    const name = collectionNameForProject("D:/projects/foo", 384)
    expect(name.startsWith("opencode_")).toBe(true)
    expect(name.endsWith("_384")).toBe(true)
  })

  test("same project path produces same collection name", () => {
    const a = collectionNameForProject("D:/projects/foo", 384)
    const b = collectionNameForProject("D:/projects/foo", 384)
    expect(a).toBe(b)
  })

  test("different dimensions produce different names", () => {
    const a = collectionNameForProject("D:/projects/foo", 384)
    const b = collectionNameForProject("D:/projects/foo", 1536)
    expect(a).not.toBe(b)
  })

  test("different projects produce different names", () => {
    const a = collectionNameForProject("D:/projects/foo", 384)
    const b = collectionNameForProject("D:/projects/bar", 384)
    expect(a).not.toBe(b)
  })
})