import { describe, expect, test } from "bun:test"
import {
  activeAliasForProject,
  createGeneration,
  generationCollectionName,
  profileFingerprint,
} from "./profiles.js"
import type { EmbeddingProfile } from "./types.js"

const local: EmbeddingProfile = {
  version: 1,
  provider: "local",
  tier: "local",
  model: "Xenova/all-MiniLM-L6-v2",
  dimensions: 384,
  dtype: "q8",
}

describe("embedding profiles", () => {
  test("same profile has a stable fingerprint", () => {
    expect(profileFingerprint(local)).toBe(profileFingerprint({ ...local }))
  })

  test("same-dimension model changes have different fingerprints", () => {
    expect(profileFingerprint(local)).not.toBe(
      profileFingerprint({ ...local, model: "other/model" }),
    )
  })

  test("dtype and provider changes have different fingerprints", () => {
    expect(profileFingerprint(local)).not.toBe(profileFingerprint({ ...local, dtype: "fp32" }))
    expect(profileFingerprint(local)).not.toBe(
      profileFingerprint({ ...local, provider: "api", tier: "custom" }),
    )
  })

  test("active alias is stable while generations are unique", () => {
    const directory = "D:/projects/example"
    expect(activeAliasForProject(directory)).toMatch(/^opencode_[a-f0-9]{12}_active$/)
    expect(generationCollectionName(directory, local, "one")).not.toBe(
      generationCollectionName(directory, local, "two"),
    )
  })

  test("generation records its profile fingerprint", () => {
    const generation = createGeneration("D:/projects/example", local, 123456)
    expect(generation.profileFingerprint).toBe(profileFingerprint(local))
    expect(generation.collectionName).toContain(generation.profileFingerprint)
  })
})
