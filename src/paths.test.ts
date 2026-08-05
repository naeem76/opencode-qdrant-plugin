/**
 * Cross-environment path normalization tests.
 *
 * Run with: `bun test src/paths.test.ts`
 */

import { describe, expect, test } from "bun:test"
import { normalizeProjectPath, projectKey } from "./paths.js"

const WIN_PROJECT = "D:\\Work-Personal-2025\\opencode-qdrant"
const WIN_PROJECT_FWD = "D:/Work-Personal-2025/opencode-qdrant"
const WSL_PROJECT = "/mnt/d/Work-Personal-2025/opencode-qdrant"
const MSYS_PROJECT = "/d/Work-Personal-2025/opencode-qdrant"
const CYG_PROJECT = "/cygdrive/d/Work-Personal-2025/opencode-qdrant"
const EXPECTED_NORM = "d:/work-personal-2025/opencode-qdrant"

const existsForProject = (normalized: string) => (p: string) =>
  p.toLowerCase() === normalized.toLowerCase()

const neverExists = () => false

describe("normalizeProjectPath — platform rewrites", () => {
  test("case 1: Windows native backslashes", () => {
    expect(normalizeProjectPath(WIN_PROJECT, { platform: "win32" })).toBe(EXPECTED_NORM)
  })

  test("case 2: Windows with forward slashes", () => {
    expect(normalizeProjectPath(WIN_PROJECT_FWD, { platform: "win32" })).toBe(EXPECTED_NORM)
  })

  test("case 3: WSL /mnt/<letter>/ form (from Linux)", () => {
    expect(normalizeProjectPath(WSL_PROJECT, { platform: "linux" })).toBe(EXPECTED_NORM)
  })

  test("case 4: MSYS /<letter>/ form on win32 WITH matching fs entry", () => {
    expect(
      normalizeProjectPath(MSYS_PROJECT, {
        platform: "win32",
        fsExists: existsForProject(EXPECTED_NORM),
      }),
    ).toBe(EXPECTED_NORM)
  })

  test("case 5: MSYS /<letter>/ form on win32 but fs entry missing — no rewrite", () => {
    expect(
      normalizeProjectPath(MSYS_PROJECT, {
        platform: "win32",
        fsExists: neverExists,
      }),
    ).toBe("/d/Work-Personal-2025/opencode-qdrant")
  })

  test("case 6: /<letter>/ form on Linux is a real POSIX path — no rewrite", () => {
    expect(
      normalizeProjectPath("/d/real-linux-folder", { platform: "linux" }),
    ).toBe("/d/real-linux-folder")
  })

  test("case 7: Cygwin /cygdrive/<letter>/ form", () => {
    expect(normalizeProjectPath(CYG_PROJECT, { platform: "win32" })).toBe(EXPECTED_NORM)
    // Also works regardless of platform
    expect(normalizeProjectPath(CYG_PROJECT, { platform: "linux" })).toBe(EXPECTED_NORM)
  })

  test("case 8: POSIX Linux path — untouched, case preserved", () => {
    expect(
      normalizeProjectPath("/home/naeem/project", { platform: "linux" }),
    ).toBe("/home/naeem/project")
  })

  test("case 9: macOS path preserves case", () => {
    expect(
      normalizeProjectPath("/Users/Naeem/Project", { platform: "darwin" }),
    ).toBe("/Users/Naeem/Project")
  })
})

describe("normalizeProjectPath — edge cases", () => {
  test("case 10: Windows drive root C:\\", () => {
    expect(normalizeProjectPath("C:\\", { platform: "win32" })).toBe("c:/")
  })

  test("case 11: duplicate slashes and trailing slash collapse", () => {
    expect(
      normalizeProjectPath("D:\\Foo\\\\Bar\\", { platform: "win32" }),
    ).toBe("d:/foo/bar")
  })

  test("case 12: \\\\wsl$\\ UNC path kept lowercased", () => {
    expect(
      normalizeProjectPath("\\\\wsl$\\Ubuntu\\home\\naeem\\proj", {
        platform: "win32",
      }),
    ).toBe("//wsl$/ubuntu/home/naeem/proj")
  })

  test("case 13: \\\\server\\share UNC kept lowercased", () => {
    expect(
      normalizeProjectPath("\\\\server\\share\\proj", { platform: "win32" }),
    ).toBe("//server/share/proj")
  })

  test("case 13b: UNC with extra leading backslashes collapses to exactly //", () => {
    expect(
      normalizeProjectPath("\\\\\\\\wsl$\\Ubuntu\\home\\n\\proj", {
        platform: "win32",
      }),
    ).toBe("//wsl$/ubuntu/home/n/proj")
    expect(
      normalizeProjectPath("\\\\\\server\\share\\proj", { platform: "win32" }),
    ).toBe("//server/share/proj")
  })

  test("case 14: absolute POSIX-looking path passes through untouched on linux", () => {
    // Plugin always receives absolute paths; just assert pass-through for
    // a path that starts with `~` would be rejected (not absolute), so we
    // use an absolute tilde-like path instead.
    expect(
      normalizeProjectPath("/home/naeem/~project", { platform: "linux" }),
    ).toBe("/home/naeem/~project")
  })

  test("case 15: empty / relative / non-string throws", () => {
    expect(() => normalizeProjectPath("")).toThrow()
    expect(() => normalizeProjectPath("./foo")).toThrow()
    expect(() => normalizeProjectPath("foo")).toThrow()
    // @ts-expect-error — deliberate bad input
    expect(() => normalizeProjectPath(undefined)).toThrow()
  })
})

describe("cross-environment equivalence", () => {
  const fsExists = existsForProject(EXPECTED_NORM)

  test("Windows, WSL, MSYS, Cygwin paths all normalize identically", () => {
    const win = normalizeProjectPath(WIN_PROJECT, { platform: "win32", fsExists })
    const wsl = normalizeProjectPath(WSL_PROJECT, { platform: "linux", fsExists })
    const msys = normalizeProjectPath(MSYS_PROJECT, { platform: "win32", fsExists })
    const cyg = normalizeProjectPath(CYG_PROJECT, { platform: "win32", fsExists })

    expect(win).toBe(EXPECTED_NORM)
    expect(wsl).toBe(win)
    expect(msys).toBe(win)
    expect(cyg).toBe(win)
  })

  test("projectKey is identical across environments for the same physical project", () => {
    const win = projectKey(WIN_PROJECT, { platform: "win32", fsExists })
    const wsl = projectKey(WSL_PROJECT, { platform: "linux", fsExists })
    const msys = projectKey(MSYS_PROJECT, { platform: "win32", fsExists })
    const cyg = projectKey(CYG_PROJECT, { platform: "win32", fsExists })

    expect(win).toHaveLength(12)
    expect(wsl).toBe(win)
    expect(msys).toBe(win)
    expect(cyg).toBe(win)
  })

  test("different projects get different keys", () => {
    const a = projectKey("/home/naeem/project-a", { platform: "linux" })
    const b = projectKey("/home/naeem/project-b", { platform: "linux" })
    expect(a).not.toBe(b)
  })
})
