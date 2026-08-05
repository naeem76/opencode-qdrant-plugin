import { QdrantClient } from "@qdrant/js-client-rest"
import type { CollectionInfo, IndexedPoint, PointPayload, SearchHit } from "./types.js"
import { isTransientNetworkError, retryAsync } from "./retry.js"

type SearchOptions = {
  limit: number
  scoreThreshold: number
  chunkType?: PointPayload["chunk_type"]
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && (error as Error & { status?: number }).status === 404
}

export class QdrantWrapper {
  private readonly client: QdrantClient
  private healthy = false
  private ensured = false
  private ensurePromise: Promise<void> | null = null

  constructor(
    readonly qdrantUrl: string,
    readonly collectionName: string,
    readonly vectorSize: number,
  ) {
    this.client = new QdrantClient({ url: qdrantUrl, checkCompatibility: false })
  }

  isHealthy() {
    return this.healthy
  }

  async healthCheck() {
    try {
      const response = await fetch(new URL("/collections", this.qdrantUrl))
      this.healthy = response.ok
      return this.healthy
    } catch {
      this.healthy = false
      return false
    }
  }

  async ensureCollection() {
    if (this.ensured) {
      return
    }
    if (this.ensurePromise) {
      return this.ensurePromise
    }
    this.ensurePromise = this.doEnsureCollection()
    try {
      await this.ensurePromise
    } finally {
      this.ensurePromise = null
    }
  }

  private async doEnsureCollection() {
    try {
      await this.client.getCollection(this.collectionName)
    } catch (error) {
      if (!isNotFoundError(error)) throw error
      await this.client.createCollection(this.collectionName, {
        vectors: { size: this.vectorSize, distance: "Cosine" },
      })
    }

    for (const fieldName of ["file_path", "language", "chunk_type", "content_hash"]) {
      try {
        await this.client.createPayloadIndex(this.collectionName, {
          field_name: fieldName,
          field_schema: "keyword",
        })
      } catch {
      }
    }

    this.healthy = true
    this.ensured = true
  }

  async getCollectionInfo(): Promise<CollectionInfo> {
    try {
      const info = await this.client.getCollection(this.collectionName)
      this.healthy = true
      return {
        name: this.collectionName,
        pointsCount: (info as { points_count?: number }).points_count ?? null,
        healthy: true,
      }
    } catch {
      this.healthy = false
      return { name: this.collectionName, pointsCount: null, healthy: false }
    }
  }

async upsertPoints(points: IndexedPoint[]) {
  if (points.length === 0) {
    return
  }

  await this.ensureCollection()
  for (let index = 0; index < points.length; index += 100) {
    const chunk = points.slice(index, index + 100)
    await retryAsync(
      () => this.client.upsert(this.collectionName, { wait: true, points: chunk }),
      (err) => isTransientNetworkError(err),
    )
  }
  this.healthy = true
}

async search(vector: number[], options: SearchOptions): Promise<SearchHit[]> {
  await this.ensureCollection()
  const result = await retryAsync(
    () =>
      this.client.search(this.collectionName, {
        vector,
        limit: Math.max(options.limit, 1),
        score_threshold: options.scoreThreshold,
        with_payload: true,
        filter: options.chunkType
          ? {
              must: [{ key: "chunk_type", match: { value: options.chunkType } }],
            }
          : undefined,
      }),
    (err) => isTransientNetworkError(err),
  )

  this.healthy = true
  return result.flatMap((item) => {
    const payload = item.payload as PointPayload | null
    if (!payload) {
      return []
    }
    return [{ id: item.id, score: item.score, payload }]
  })
}

/**
 * Build a `file_path → content_hash` map of currently indexed files.
 *
 * Scrolls the whole collection (no chunk_type filter) so the result is
 * robust to files that lack a `summary` chunk — every file with at
 * least one chunk is included. When a file has multiple chunks, all
 * chunks of a given file share the same `content_hash` (it's the hash
 * of the whole file, set in indexSnapshot), so any chunk's hash is
 * authoritative.
 */
async getFileHashes() {
  await this.ensureCollection()
  const hashes = new Map<string, string>()
  let offset: string | number | undefined

  do {
    const page = await this.client.scroll(this.collectionName, {
      limit: 256,
      offset,
      with_payload: true,
      with_vector: false,
    })

    for (const point of page.points) {
      const payload = point.payload as PointPayload | null
      if (payload?.file_path && !hashes.has(payload.file_path)) {
        hashes.set(payload.file_path, payload.content_hash)
      }
    }
    const nextOffset = page.next_page_offset
    offset = typeof nextOffset === "string" || typeof nextOffset === "number" ? nextOffset : undefined
  } while (offset !== undefined)

  this.healthy = true
  return hashes
}

  async deleteByFilePaths(filePaths: string[]) {
    if (filePaths.length === 0) {
      return
    }
    await this.ensureCollection()
    await this.client.delete(this.collectionName, {
      wait: true,
      filter: { should: filePaths.map((filePath) => ({ key: "file_path", match: { value: filePath } })) },
    })
    this.healthy = true
  }

  async deleteStaleFileVersion(filePath: string, currentHash: string) {
    await this.ensureCollection()
    await this.client.delete(this.collectionName, {
      wait: true,
      filter: {
        must: [{ key: "file_path", match: { value: filePath } }],
        must_not: [{ key: "content_hash", match: { value: currentHash } }],
      },
    })
    this.healthy = true
  }

  async deleteCollection() {
    try {
      await this.client.deleteCollection(this.collectionName)
    } catch (error) {
      if (!isNotFoundError(error)) throw error
    }
    this.ensured = false
    this.ensurePromise = null
  }

  async collectionExists(collectionName = this.collectionName): Promise<boolean> {
    try {
      await this.client.getCollection(collectionName)
      return true
    } catch (error) {
      if (isNotFoundError(error)) return false
      throw error
    }
  }

  async getAliasTarget(aliasName: string): Promise<string | null> {
    const response = await this.client.getAliases()
    return response.aliases.find((alias) => alias.alias_name === aliasName)?.collection_name ?? null
  }

  /**
   * Atomically point an alias at a physical collection. When expectedCurrent
   * is supplied, refuse the switch if another process changed the alias.
   */
  async switchAlias(
    aliasName: string,
    targetCollection: string,
    expectedCurrent?: string | null,
  ): Promise<void> {
    if (!(await this.collectionExists(targetCollection))) {
      throw new Error(`Cannot activate missing collection '${targetCollection}'`)
    }

    const current = await this.getAliasTarget(aliasName)
    if (expectedCurrent !== undefined && current !== expectedCurrent) {
      throw new Error(
        `Alias '${aliasName}' changed concurrently (expected '${expectedCurrent}', found '${current}')`,
      )
    }
    if (current === targetCollection) return

    await this.client.updateCollectionAliases({
      actions: [
        ...(current ? [{ delete_alias: { alias_name: aliasName } }] : []),
        {
          create_alias: {
            alias_name: aliasName,
            collection_name: targetCollection,
          },
        },
      ],
    })

    const activated = await this.getAliasTarget(aliasName)
    if (activated !== targetCollection) {
      throw new Error(`Alias '${aliasName}' did not activate '${targetCollection}'`)
    }
  }

  async deleteCollectionByName(collectionName: string): Promise<void> {
    try {
      await this.client.deleteCollection(collectionName)
    } catch (error) {
      if (!isNotFoundError(error)) throw error
    }
  }
}
