/**
 * Tests for the debounced file watcher.
 *
 * Uses a real temp directory and (on supported platforms) fs.watch recursive.
 * Run with: `bun test src/watcher.test.ts`
 */

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { startFileWatcher } from "./watcher.js"

let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "qdrant-watcher-"))
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe("startFileWatcher", () => {
  test("fires onChange after debounce when a tracked file is written", async () => {
    const changed: string[][] = []
    const watcher = startFileWatcher({
      rootDirectory: tmp,
      debounceMs: 50,
      onChange: (paths) => changed.push(paths),
    })
    try {
      await fs.writeFile(path.join(tmp, "src.ts"), "x\n")
      // Wait past the debounce window.
      await sleep(150)
      expect(changed.length).toBeGreaterThanOrEqual(1)
      const all = changed.flat()
      expect(all.some((p) => p.includes("src.ts"))).toBe(true)
    } finally {
      watcher.close()
    }
  })

  test("does not fire for ignored paths (sensitive / generated / binary)", async () => {
    const changed: string[] = []
    const watcher = startFileWatcher({
      rootDirectory: tmp,
      debounceMs: 50,
      onChange: (paths) => changed.push(...paths),
    })
    try {
      await fs.writeFile(path.join(tmp, ".env"), "SECRET=1\n")
      await fs.writeFile(path.join(tmp, "bundle.min.js"), "x\n")
      await fs.writeFile(path.join(tmp, "icon.png"), Buffer.from([0x89, 0x50]))
      await sleep(150)
      expect(changed.filter((p) => p.endsWith(".env"))).toEqual([])
      expect(changed.filter((p) => p.includes("bundle.min.js"))).toEqual([])
      expect(changed.filter((p) => p.endsWith("icon.png"))).toEqual([])
    } finally {
      watcher.close()
    }
  })

  test("debounces bursts into a single callback", async () => {
    const calls: number[] = []
    const watcher = startFileWatcher({
      rootDirectory: tmp,
      debounceMs: 80,
      onChange: () => calls.push(Date.now()),
    })
    try {
      // Burst of writes within the debounce window.
      for (let i = 0; i < 5; i += 1) {
        await fs.writeFile(path.join(tmp, `f${i}.ts`), "x\n")
        await sleep(5)
      }
      await sleep(200)
      expect(calls.length).toBe(1)
    } finally {
      watcher.close()
    }
  })

  test("close() stops further callbacks", async () => {
    const changed: string[] = []
    const watcher = startFileWatcher({
      rootDirectory: tmp,
      debounceMs: 50,
      onChange: (paths) => changed.push(...paths),
    })
    watcher.close()
    await fs.writeFile(path.join(tmp, "after.ts"), "x\n")
    await sleep(150)
    expect(changed).toEqual([])
  })

  test("ignores SKIP_DIRS (node_modules, dist, .git)", async () => {
    const changed: string[] = []
    const watcher = startFileWatcher({
      rootDirectory: tmp,
      debounceMs: 50,
      onChange: (paths) => changed.push(...paths),
    })
    try {
      await fs.mkdir(path.join(tmp, "node_modules"), { recursive: true })
      await fs.writeFile(path.join(tmp, "node_modules", "lib.js"), "x\n")
      await fs.mkdir(path.join(tmp, "dist"), { recursive: true })
      await fs.writeFile(path.join(tmp, "dist", "out.js"), "x\n")
      await sleep(150)
      expect(changed.filter((p) => p.includes("node_modules"))).toEqual([])
      expect(changed.filter((p) => p.includes("dist/"))).toEqual([])
    } finally {
      watcher.close()
    }
  })
})