/**
 * Tests for the concurrency limiter.
 *
 * Run with: `bun test src/concurrency.test.ts`
 */

import { describe, expect, test } from "bun:test"
import { mapWithConcurrency, pLimit } from "./concurrency.js"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe("pLimit", () => {
  test("runs tasks with the given concurrency", async () => {
    const limit = pLimit(3)
    let active = 0
    let maxActive = 0
    const tasks = Array.from({ length: 10 }, () =>
      limit(async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await sleep(10)
        active -= 1
      }),
    )
    await Promise.all(tasks)
    expect(maxActive).toBeLessThanOrEqual(3)
    expect(maxActive).toBe(3)
  })

  test("concurrency=1 serializes tasks", async () => {
    const limit = pLimit(1)
    const order: number[] = []
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        limit(async () => {
          order.push(i)
          await sleep(5)
        }),
      ),
    )
    expect(order).toEqual([0, 1, 2, 3, 4])
  })

  test("throws on concurrency < 1", () => {
    expect(() => pLimit(0)).toThrow()
    expect(() => pLimit(-1)).toThrow()
  })

  test("propagates rejection", async () => {
    const limit = pLimit(2)
    await expect(limit(async () => { throw new Error("boom") })).rejects.toThrow("boom")
  })

  test("does not block later tasks after a rejection", async () => {
    const limit = pLimit(2)
    let ran = false
    await expect(
      Promise.all([
        limit(async () => { throw new Error("x") }),
        limit(async () => { ran = true; await sleep(5) }),
      ]),
    ).rejects.toThrow()
    // The second task may or may not have started depending on timing,
    // but the limiter should still be usable afterwards.
    await limit(async () => { ran = true; await sleep(1) })
    expect(ran).toBe(true)
  })
})

describe("mapWithConcurrency", () => {
  test("preserves result order", async () => {
    const items = [1, 2, 3, 4, 5]
    const results = await mapWithConcurrency(items, 2, async (n) => {
      await sleep((5 - n) * 5) // later items finish faster
      return n * 10
    })
    expect(results).toEqual([10, 20, 30, 40, 50])
  })

  test("respects concurrency limit", async () => {
    let active = 0
    let maxActive = 0
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await sleep(5)
      active -= 1
    })
    expect(maxActive).toBeLessThanOrEqual(4)
    expect(maxActive).toBe(4)
  })

  test("rejects fast on first failure", async () => {
    const items = [1, 2, 3]
    await expect(
      mapWithConcurrency(items, 2, async (n) => {
        if (n === 2) throw new Error("middle fails")
        await sleep(20)
        return n
      }),
    ).rejects.toThrow("middle fails")
  })

  test("handles empty input", async () => {
    const results = await mapWithConcurrency([], 4, async () => 1)
    expect(results).toEqual([])
  })

  test("passes index to the callback", async () => {
    const indices: number[] = []
    await mapWithConcurrency(["a", "b", "c"], 2, async (_item, index) => {
      indices.push(index)
      await sleep(1)
    })
    expect(indices.sort()).toEqual([0, 1, 2])
  })
})