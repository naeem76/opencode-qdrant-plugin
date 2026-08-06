import fs from "node:fs/promises"
import path from "node:path"
import { createEmbeddingProvider } from "./embedding/index.js"
import { Indexer } from "./indexer.js"
import {
  activeAliasForProject,
  configForEmbeddingProfile,
  createGeneration,
  defaultLocalProfile,
  embeddingProfileFromConfig,
  profileFingerprint,
} from "./profiles.js"
import { QdrantWrapper } from "./qdrant.js"
import { HttpRetryableError } from "./retry.js"
import type {
  DeploymentState,
  EmbeddingProfile,
  EmbeddingProvider,
  IndexGeneration,
  IndexingState,
  ResolvedConfig,
  SearchHit,
} from "./types.js"
import { getProjectDataDir } from "./paths.js"
import { collectionNameForProject } from "./utils.js"

type StateListener = (state: IndexingState) => Promise<void> | void
type ManagerLogger = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
) => Promise<void>

type Runtime = {
  generation: IndexGeneration
  config: ResolvedConfig
  qdrant: QdrantWrapper
  embeddings: EmbeddingProvider
  indexer: Indexer
  searches: number
  searchWaiters: Array<() => void>
}

type IndexManagerDependencies = {
  createQdrant: (url: string, collectionName: string, dimensions: number) => QdrantWrapper
  createEmbeddings: (config: ResolvedConfig) => EmbeddingProvider
}

const defaultDependencies: IndexManagerDependencies = {
  createQdrant: (url, collectionName, dimensions) =>
    new QdrantWrapper(url, collectionName, dimensions),
  createEmbeddings: createEmbeddingProvider,
}

export class IndexManager {
  readonly aliasName: string

  private active: Runtime | null = null
  private staging: Runtime | null = null
  private initializeRun: Promise<boolean> | null = null
  private switchRun: Promise<void> | null = null
  private switchGeneration = 0
  private cancelSwitch = false
  private queuedSwitch: {
    profile: EmbeddingProfile
    reason: NonNullable<DeploymentState["switchReason"]>
    forceRebuild: boolean
  } | null = null
  private fullQueued = false
  private incrementalQueued = false
  private state: IndexingState
  private deployment: DeploymentState
  private readonly admin: QdrantWrapper

  constructor(
    private readonly rootDirectory: string,
    private readonly baseConfig: ResolvedConfig,
    private readonly desiredProfile: EmbeddingProfile,
    persistedState: IndexingState | null,
    private readonly onStateChange: StateListener,
    private readonly log: ManagerLogger,
    private readonly fallbackToLocalOnRateLimit = false,
    private readonly dependencies: IndexManagerDependencies = defaultDependencies,
  ) {
    this.aliasName = activeAliasForProject(rootDirectory)
    const legacyCollection =
      baseConfig.collectionName ??
      collectionNameForProject(rootDirectory, baseConfig.embeddingDimensions)
    this.admin = this.dependencies.createQdrant(
      baseConfig.qdrantUrl,
      legacyCollection,
      baseConfig.embeddingDimensions,
    )
    this.deployment = persistedState?.deployment ?? {
      version: 1,
      aliasName: this.aliasName,
      phase: "ready",
    }
    this.state = persistedState ?? this.emptyState(legacyCollection, desiredProfile)
    this.state.deployment = this.deployment
  }

  async initialize(): Promise<boolean> {
    if (this.active) return this.active.qdrant.healthCheck()
    if (this.initializeRun) return this.initializeRun
    this.initializeRun = this.performInitialize().finally(() => {
      this.initializeRun = null
    })
    return this.initializeRun
  }

  private async performInitialize(): Promise<boolean> {
    if (!(await this.admin.healthCheck())) {
      this.state.status = "unavailable"
      await this.emitState()
      return false
    }

    const aliasTarget = await this.admin.getAliasTarget(this.aliasName)
    let activeGeneration = this.reconcilePersistedActive(aliasTarget)

    // The alias is authoritative after a crash. If state metadata is missing,
    // preserve the aliased collection and conservatively associate it with
    // the desired profile rather than retargeting or deleting it.
    if (!activeGeneration && aliasTarget) {
      activeGeneration = this.legacyGeneration(aliasTarget)
    }

    if (!activeGeneration) {
      const legacyCollection = this.admin.collectionName
      if (await this.admin.collectionExists(legacyCollection)) {
        activeGeneration = this.legacyGeneration(legacyCollection)
        if (activeGeneration) {
          const release = await this.acquirePromotionLock()
          try {
            await this.activateAlias(legacyCollection, aliasTarget)
          } finally {
            await release()
          }
        }
      }
      if (!activeGeneration) {
        activeGeneration = await this.buildInitialGeneration(aliasTarget)
      }
    }

    this.active ??= this.createRuntime(activeGeneration)
    this.deployment = {
      version: 1,
      aliasName: this.aliasName,
      phase: "ready",
      active: activeGeneration,
      previous: this.deployment.previous,
      retained: this.deployment.retained,
    }
    this.state = this.decorate(this.active.indexer.getState())
    await this.emitState()

    if (this.queuedSwitch) {
      void this.switchTo(this.queuedSwitch.profile, this.queuedSwitch.reason)
    } else if (activeGeneration.profileFingerprint !== profileFingerprint(this.desiredProfile)) {
      void this.switchTo(this.desiredProfile, "user_requested")
    } else if (this.fullQueued) {
      this.fullQueued = false
      this.startFull()
    } else if (this.incrementalQueued) {
      this.incrementalQueued = false
      this.startIncremental()
    } else if (this.baseConfig.indexOnStart) {
      this.startIncremental()
    }
    return true
  }

  getState(): IndexingState {
    return structuredClone(this.state)
  }

  hasActiveIndex(): boolean {
    return this.active !== null
  }

  isRunning(): boolean {
    return this.switchRun !== null || Boolean(this.active?.indexer.isRunning())
  }

  isHealthy(): boolean {
    return this.active?.qdrant.isHealthy() ?? this.admin.isHealthy()
  }

  getActiveInfo() {
    const runtime = this.requireActive()
    return {
      generation: runtime.generation,
      provider: runtime.embeddings.name,
      collectionName: runtime.generation.collectionName,
    }
  }

  async healthCheck(): Promise<boolean> {
    return this.active ? this.active.qdrant.healthCheck() : this.admin.healthCheck()
  }

  async getCollectionInfo() {
    return (this.active?.qdrant ?? this.admin).getCollectionInfo()
  }

  async embedAndSearch(
    query: string,
    options: {
      limit: number
      scoreThreshold: number
      chunkType?: "code" | "summary"
    },
  ): Promise<SearchHit[]> {
    // Pin the matching provider + physical collection for the whole request.
    const runtime = this.requireActive()
    runtime.searches += 1
    try {
      const [vector] = await runtime.embeddings.embed([query])
      return runtime.qdrant.search(vector, options)
    } catch (error) {
      if (
        error instanceof HttpRetryableError &&
        error.status === 429 &&
        this.fallbackToLocalOnRateLimit &&
        runtime.generation.profile.provider !== "local" &&
        !this.switchRun
      ) {
        this.state.status = "rate_limited"
        await this.emitState()
        void this.switchTo(defaultLocalProfile(this.baseConfig), "rate_limit_fallback")
        throw new Error("Cloud embeddings are rate limited; a full local fallback index is building")
      }
      throw error
    } finally {
      runtime.searches -= 1
      if (runtime.searches === 0) {
        for (const resolve of runtime.searchWaiters.splice(0)) resolve()
      }
    }
  }

  startIncremental(): void {
    if (!this.active || this.switchRun || this.active.indexer.isRunning()) {
      this.incrementalQueued = true
      return
    }
    const runtime = this.active
    void runtime.indexer.runIncremental().finally(() => this.flushQueuedIncremental())
  }

  startFull(): void {
    if (!this.active || this.switchRun) {
      this.fullQueued = true
      return
    }
    void this.switchTo(this.requireActive().generation.profile, "user_requested", {
      forceRebuild: true,
    })
  }

  async switchTo(
    profile: EmbeddingProfile,
    reason: NonNullable<DeploymentState["switchReason"]>,
    options: { forceRebuild?: boolean } = {},
  ): Promise<void> {
    this.queuedSwitch = {
      profile,
      reason,
      forceRebuild: options.forceRebuild === true,
    }
    this.switchGeneration += 1
    if (!this.active) return
    if (this.switchRun) {
      // Abort the in-flight staging build so the newer request can run.
      this.cancelSwitch = true
      void this.staging?.indexer.stop()
      return this.switchRun
    }
    this.switchRun = this.runSwitchQueue().finally(() => {
      this.switchRun = null
      this.cancelSwitch = false
      if (this.fullQueued) {
        this.fullQueued = false
        this.startFull()
      } else {
        this.flushQueuedIncremental()
      }
    })
    return this.switchRun
  }

  private async runSwitchQueue(): Promise<void> {
    while (this.queuedSwitch) {
      const request = this.queuedSwitch
      this.queuedSwitch = null
      this.cancelSwitch = false
      const token = this.switchGeneration
      await this.performSwitch(request.profile, request.reason, request.forceRebuild, token)
    }
  }

  private async performSwitch(
    profile: EmbeddingProfile,
    reason: NonNullable<DeploymentState["switchReason"]>,
    forceRebuild = false,
    token = this.switchGeneration,
  ): Promise<void> {
    const previous = this.requireActive()
    await previous.indexer.waitForIdle()
    if (this.isSwitchSuperseded(token)) return
    const fingerprint = profileFingerprint(profile)

    if (!forceRebuild && previous.generation.profileFingerprint === fingerprint) {
      // Selecting the already-active model cancels any in-flight build of another model.
      await this.abortStaging(previous, reason, "Kept the active embedding index")
      return
    }

    if (!forceRebuild) {
      const reusable = await this.findRetainedGeneration(fingerprint)
      if (reusable) {
        await this.activateExistingGeneration(reusable, previous, reason)
        return
      }
    }

    const generation = createGeneration(this.rootDirectory, profile)
    let releasePromotionLock: (() => Promise<void>) | null = null
    this.deployment = {
      version: 1,
      aliasName: this.aliasName,
      phase: "building",
      active: previous.generation,
      staging: generation,
      retained: this.deployment.retained,
      switchReason: reason,
    }
    await this.emitState()

    try {
      this.staging = this.createRuntime(generation)
      await this.staging.indexer.runFull()
      if (this.isSwitchSuperseded(token)) {
        await this.abortStaging(previous, reason, "Canceled superseded embedding switch")
        return
      }
      if (this.staging.indexer.getState().status !== "complete") {
        throw new Error(this.formatStagingFailure("Staging index completed with errors"))
      }

      this.deployment.phase = "verifying"
      await this.emitState()
      await this.staging.indexer.runIncremental()
      if (this.isSwitchSuperseded(token)) {
        await this.abortStaging(previous, reason, "Canceled superseded embedding switch")
        return
      }
      if (this.staging.indexer.getState().status !== "complete") {
        throw new Error(
          this.formatStagingFailure("Final staging reconciliation completed with errors"),
        )
      }

      const info = await this.staging.qdrant.getCollectionInfo()
      if (!info.healthy || info.pointsCount === null) {
        throw new Error("Staging collection failed verification")
      }

      if (this.isSwitchSuperseded(token)) {
        await this.abortStaging(previous, reason, "Canceled superseded embedding switch")
        return
      }

      this.deployment.phase = "switching"
      await this.emitState()
      releasePromotionLock = await this.acquirePromotionLock()
      await this.activateAlias(
        generation.collectionName,
        previous.generation.collectionName,
      )

      generation.activatedAt = Date.now()
      this.active = this.staging
      this.staging = null
      const replacedSameModel =
        previous.generation.profileFingerprint === generation.profileFingerprint
      const retained = replacedSameModel
        ? this.dropRetained(generation.profileFingerprint, previous.generation.collectionName)
        : this.rememberGeneration(previous.generation, generation.profileFingerprint)
      this.deployment = {
        version: 1,
        aliasName: this.aliasName,
        phase: "cleanup",
        active: generation,
        previous: replacedSameModel ? undefined : previous.generation,
        retained,
        switchReason: reason,
      }
      this.state = this.decorate(this.active.indexer.getState())
      await this.emitState()

      let cleanupError: string | undefined
      try {
        await this.waitForSearches(previous)
        if (replacedSameModel) {
          await this.admin.deleteCollectionByName(previous.generation.collectionName)
        }
      } catch (error) {
        cleanupError = error instanceof Error ? error.message : String(error)
      }
      await releasePromotionLock()
      releasePromotionLock = null
      try {
        await previous.embeddings.dispose?.()
      } catch (error) {
        cleanupError ??= error instanceof Error ? error.message : String(error)
      }
      this.deployment = {
        version: 1,
        aliasName: this.aliasName,
        phase: "ready",
        active: generation,
        previous: replacedSameModel ? this.deployment.previous : previous.generation,
        retained,
        switchReason: reason,
        ...(cleanupError ? { lastError: `Previous generation cleanup deferred: ${cleanupError}` } : {}),
      }
      this.state = this.decorate(this.active.indexer.getState())
      await this.emitState()
      try {
        await this.log("info", `Activated embedding model ${profile.model}`, {
          collection: generation.collectionName,
          provider: profile.provider,
        })
      } catch {
      }
    } catch (error) {
      await releasePromotionLock?.().catch(() => {})
      if (this.isSwitchSuperseded(token)) {
        await this.abortStaging(previous, reason, "Canceled superseded embedding switch")
        return
      }
      const failedRuntime = this.staging
      const rateLimited =
        failedRuntime?.indexer
          .getState()
          .errors.some((item) => item.error.includes("HTTP 429")) ?? false
      let safeToDelete = false
      if (failedRuntime) {
        const aliasTarget = await this.readAliasTarget()
        safeToDelete = aliasTarget !== undefined && aliasTarget !== generation.collectionName
      }
      this.deployment = {
        version: 1,
        aliasName: this.aliasName,
        phase: "failed",
        active: previous.generation,
        retained: this.deployment.retained,
        ...(failedRuntime && !safeToDelete ? { staging: generation } : {}),
        switchReason: reason,
        lastError: error instanceof Error ? error.message : String(error),
      }
      this.state = this.decorate(previous.indexer.getState())
      this.state.status = rateLimited ? "rate_limited" : "error"
      await this.emitState()
      const stagingState = failedRuntime?.indexer.getState()
      await this.log("error", "Embedding provider switch failed", {
        error: this.deployment.lastError,
        targetModel: generation.profile.model,
        targetProvider: generation.profile.provider,
        errorCount: stagingState?.errorCount ?? 0,
        errors: stagingState?.errors ?? [],
      })
      this.staging = null
      try {
        await failedRuntime?.embeddings.dispose?.()
      } catch {
      }
      if (failedRuntime && safeToDelete) {
        await this.admin.deleteCollectionByName(failedRuntime.generation.collectionName)
      }

      if (
        rateLimited &&
        this.fallbackToLocalOnRateLimit &&
        previous.generation.profile.provider !== "local"
      ) {
        this.queuedSwitch = {
          profile: defaultLocalProfile(this.baseConfig),
          reason: "rate_limit_fallback",
          forceRebuild: false,
        }
      }
    }
  }

  private isSwitchSuperseded(token: number): boolean {
    return this.cancelSwitch || token !== this.switchGeneration || this.queuedSwitch !== null
  }

  private formatStagingFailure(prefix: string): string {
    const state = this.staging?.indexer.getState()
    const samples = (state?.errors ?? [])
      .slice(0, 3)
      .map((item) => `${item.file}: ${item.error}`)
    if (!samples.length) {
      return `${prefix} (${state?.errorCount ?? 0} file error(s); no details retained)`
    }
    return `${prefix} (${state?.errorCount ?? samples.length}): ${samples.join(" | ")}`
  }

  private async abortStaging(
    active: Runtime,
    reason: NonNullable<DeploymentState["switchReason"]>,
    message: string,
  ): Promise<void> {
    const failedRuntime = this.staging
    this.staging = null
    this.cancelSwitch = false
    try {
      await failedRuntime?.indexer.stop()
    } catch {
    }
    try {
      await failedRuntime?.embeddings.dispose?.()
    } catch {
    }
    if (failedRuntime) {
      const aliasTarget = await this.readAliasTarget()
      if (aliasTarget !== undefined && aliasTarget !== failedRuntime.generation.collectionName) {
        await this.admin.deleteCollectionByName(failedRuntime.generation.collectionName)
      }
    }
    this.deployment = {
      version: 1,
      aliasName: this.aliasName,
      phase: "ready",
      active: active.generation,
      previous: this.deployment.previous,
      retained: this.deployment.retained,
      switchReason: reason,
      lastError: undefined,
    }
    this.state = this.decorate(active.indexer.getState())
    await this.emitState()
    try {
      await this.log("info", message, {
        active: active.generation.collectionName,
        canceled: failedRuntime?.generation.collectionName,
      })
    } catch {
    }
  }

  private async findRetainedGeneration(fingerprint: string): Promise<IndexGeneration | null> {
    const candidates = [
      this.deployment.previous,
      ...(this.deployment.retained ?? []),
    ].filter((item): item is IndexGeneration => Boolean(item))

    for (const candidate of candidates) {
      if (candidate.profileFingerprint !== fingerprint) continue
      if (!(await this.admin.collectionExists(candidate.collectionName))) continue
      return candidate
    }
    return null
  }

  private rememberGeneration(
    generation: IndexGeneration,
    activeFingerprint: string,
  ): IndexGeneration[] {
    if (generation.profileFingerprint === activeFingerprint) {
      return this.dropRetained(activeFingerprint, generation.collectionName)
    }
    const retained = this.dropRetained(generation.profileFingerprint, generation.collectionName)
      .filter((item) => item.profileFingerprint !== activeFingerprint)
    retained.push(generation)
    return retained
  }

  private dropRetained(fingerprint: string, collectionName?: string): IndexGeneration[] {
    return [...(this.deployment.retained ?? [])].filter(
      (item) =>
        item.profileFingerprint !== fingerprint &&
        item.collectionName !== collectionName,
    )
  }

  private async activateExistingGeneration(
    generation: IndexGeneration,
    previous: Runtime,
    reason: NonNullable<DeploymentState["switchReason"]>,
  ): Promise<void> {
    let releasePromotionLock: (() => Promise<void>) | null = null
    this.deployment = {
      version: 1,
      aliasName: this.aliasName,
      phase: "switching",
      active: previous.generation,
      staging: generation,
      retained: this.deployment.retained,
      switchReason: reason,
    }
    await this.emitState()

    try {
      const runtime = this.createRuntime(generation)
      this.staging = runtime
      releasePromotionLock = await this.acquirePromotionLock()
      await this.activateAlias(generation.collectionName, previous.generation.collectionName)
      generation.activatedAt = Date.now()
      this.active = runtime
      this.staging = null

      const retained = this.rememberGeneration(previous.generation, generation.profileFingerprint)
      this.deployment = {
        version: 1,
        aliasName: this.aliasName,
        phase: "ready",
        active: generation,
        previous: previous.generation,
        retained,
        switchReason: reason,
      }
      this.state = this.decorate(this.active.indexer.getState())
      await this.emitState()
      await releasePromotionLock()
      releasePromotionLock = null
      await this.waitForSearches(previous)
      await previous.embeddings.dispose?.()
      // Catch up files changed while this generation was inactive.
      this.startIncremental()
      await this.log("info", `Reused existing embedding index for ${generation.profile.model}`, {
        collection: generation.collectionName,
        provider: generation.profile.provider,
      })
    } catch (error) {
      await releasePromotionLock?.().catch(() => {})
      this.staging = null
      this.deployment = {
        version: 1,
        aliasName: this.aliasName,
        phase: "failed",
        active: previous.generation,
        retained: this.deployment.retained,
        switchReason: reason,
        lastError: error instanceof Error ? error.message : String(error),
      }
      this.state = this.decorate(previous.indexer.getState())
      this.state.status = "error"
      await this.emitState()
      await this.log("error", "Failed to reuse existing embedding index", {
        error: this.deployment.lastError,
      })
    }
  }

  private async activateAlias(
    collectionName: string,
    expectedCurrent: string | null,
  ): Promise<void> {
    try {
      await this.admin.switchAlias(
        this.aliasName,
        collectionName,
        expectedCurrent,
      )
    } catch (error) {
      if ((await this.readAliasTarget()) === collectionName) return
      throw error
    }
  }

  private async buildInitialGeneration(expectedCurrent: string | null): Promise<IndexGeneration> {
    const generation = createGeneration(this.rootDirectory, this.desiredProfile)
    const runtime = this.createRuntime(generation)
    this.staging = runtime
    this.deployment = {
      version: 1,
      aliasName: this.aliasName,
      phase: "building",
      staging: generation,
    }
    let releasePromotionLock: (() => Promise<void>) | null = null
    try {
      await runtime.qdrant.ensureCollection()
      releasePromotionLock = await this.acquirePromotionLock()
      await this.activateAlias(generation.collectionName, expectedCurrent)
      await releasePromotionLock()
      releasePromotionLock = null
      generation.activatedAt = Date.now()
      this.active = runtime
      this.staging = null
      return generation
    } catch (error) {
      await releasePromotionLock?.().catch(() => {})
      const aliasTarget = await this.readAliasTarget()
      this.staging = null
      await runtime.embeddings.dispose?.()
      if (aliasTarget !== undefined && aliasTarget !== generation.collectionName) {
        await this.admin.deleteCollectionByName(generation.collectionName)
      }
      throw error
    }
  }

  private createRuntime(generation: IndexGeneration): Runtime {
    const config = configForEmbeddingProfile(this.baseConfig, generation.profile)
    const qdrant = this.dependencies.createQdrant(
      config.qdrantUrl,
      generation.collectionName,
      generation.profile.dimensions,
    )
    const embeddings = this.dependencies.createEmbeddings(config)
    const indexer = new Indexer(
      this.rootDirectory,
      qdrant,
      embeddings,
      config,
      async (state) => {
        const isActive = this.active?.generation.id === generation.id
        const isStaging = this.staging?.generation.id === generation.id
        if (!isActive && !isStaging) return
        this.state = this.decorate(state)
        await this.emitState()

        const rateLimited = state.errors.some((item) => item.error.includes("HTTP 429"))
        if (
          rateLimited &&
          isActive &&
          this.fallbackToLocalOnRateLimit &&
          generation.profile.provider !== "local" &&
          !this.switchRun
        ) {
          this.state.status = "rate_limited"
          await this.emitState()
          setTimeout(() => {
            void this.switchTo(defaultLocalProfile(this.baseConfig), "rate_limit_fallback")
          }, 0)
        }
      },
    )
    return { generation, config, qdrant, embeddings, indexer, searches: 0, searchWaiters: [] }
  }

  private reconcilePersistedActive(aliasTarget: string | null): IndexGeneration | null {
    const persisted = this.deployment.active
    if (!aliasTarget) return null
    if (persisted?.collectionName === aliasTarget) return persisted
    if (this.deployment.staging?.collectionName === aliasTarget) return this.deployment.staging
    return null
  }

  private legacyGeneration(collectionName: string): IndexGeneration | null {
    const profile = this.recoverLegacyProfile(collectionName)
    if (!profile) return null
    return {
      id: "legacy",
      collectionName,
      profile,
      profileFingerprint: profileFingerprint(profile),
      createdAt: Date.now(),
      activatedAt: Date.now(),
    }
  }

  private decorate(state: IndexingState): IndexingState {
    // A failed background switch must not paint the still-healthy active index
    // as errored (that produced confusing "0 error(s)" while search still worked).
    const status = this.deployment.phase === "switching" ? "switching" : state.status
    return { ...state, status, deployment: structuredClone(this.deployment) }
  }

  private async emitState(): Promise<void> {
    this.state.deployment = structuredClone(this.deployment)
    try {
      await this.onStateChange(this.getState())
    } catch (error) {
      await this.log("warn", "Failed to persist indexing state", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private recoverLegacyProfile(collectionName: string): EmbeddingProfile | null {
    const dimensions = Number(collectionName.match(/_(\d+)$/)?.[1])
    if (!Number.isInteger(dimensions) || dimensions <= 0) return null
    const provider = this.state.provider
    if (provider.startsWith("local-worker:")) {
      const value = provider.slice("local-worker:".length)
      const separator = value.lastIndexOf(":")
      const model = separator >= 0 ? value.slice(0, separator) : value
      const dtype = separator >= 0 ? value.slice(separator + 1) : this.baseConfig.localEmbeddingDtype
      if (!model || !["auto", "q4", "q8", "fp32"].includes(dtype)) return null
      return {
        version: 1,
        provider: "local",
        tier: "local",
        model,
        dimensions,
        dtype: dtype as EmbeddingProfile["dtype"],
      }
    }
    for (const kind of ["openrouter", "api"] as const) {
      const prefix = `${kind}:`
      if (!provider.startsWith(prefix)) continue
      const model = provider.slice(prefix.length)
      if (!model) return null
      return {
        version: 1,
        provider: kind,
        tier: kind === "openrouter" ? (model.endsWith(":free") ? "free" : "paid") : "custom",
        model,
        dimensions,
        apiUrl: this.baseConfig.embeddingApiUrl,
        apiKeyEnv: this.baseConfig.embeddingApiKeyEnv,
        sendDimensions: this.baseConfig.embeddingApiSendDimensions,
      }
    }
    if (!this.deployment.active && dimensions === 384) {
      return { ...defaultLocalProfile(this.baseConfig), dimensions }
    }
    return null
  }

  private async readAliasTarget(): Promise<string | null | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.admin.getAliasTarget(this.aliasName)
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
      }
    }
    return undefined
  }

  private async waitForSearches(runtime: Runtime): Promise<void> {
    if (runtime.searches === 0) return
    await new Promise<void>((resolve) => runtime.searchWaiters.push(resolve))
  }

  private async acquirePromotionLock(): Promise<() => Promise<void>> {
    const directory = getProjectDataDir(this.rootDirectory)
    const lockPath = path.join(directory, "promotion.lock")
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const deadline = Date.now() + 120_000
    await fs.mkdir(directory, { recursive: true })

    while (Date.now() < deadline) {
      try {
        const handle = await fs.open(lockPath, "wx")
        await handle.writeFile(JSON.stringify({ token, pid: process.pid }))
        await handle.close()
        return async () => {
          try {
            const current = JSON.parse(await fs.readFile(lockPath, "utf8")) as { token?: string }
            if (current.token === token) await fs.unlink(lockPath)
          } catch {
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }

      try {
        const raw = await fs.readFile(lockPath, "utf8")
        const owner = JSON.parse(raw) as { token?: string; pid?: number }
        if (typeof owner.pid === "number" && !this.isProcessAlive(owner.pid)) {
          const current = await fs.readFile(lockPath, "utf8")
          if (current === raw) await fs.unlink(lockPath)
          continue
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error("Timed out waiting for another Qdrant index promotion")
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM"
    }
  }

  private flushQueuedIncremental(): void {
    if (!this.incrementalQueued || this.switchRun || !this.active?.indexer) return
    this.incrementalQueued = false
    this.startIncremental()
  }

  private requireActive(): Runtime {
    if (!this.active) throw new Error("No active Qdrant index")
    return this.active
  }

  async dispose(): Promise<void> {
    this.queuedSwitch = null
    this.fullQueued = false
    this.incrementalQueued = false
    await this.active?.indexer.stop()
    await this.staging?.indexer.stop()
    await this.switchRun?.catch(() => {})
    if (this.active) await this.waitForSearches(this.active)
    await this.active?.embeddings.dispose?.()
    await this.staging?.embeddings.dispose?.()
    this.active = null
    this.staging = null
  }

  private emptyState(collectionName: string, profile: EmbeddingProfile): IndexingState {
    return {
      status: "idle",
      totalFiles: 0,
      processedFiles: 0,
      skippedFiles: 0,
      totalChunks: 0,
      errorCount: 0,
      errors: [],
      startedAt: null,
      completedAt: null,
      collectionName,
      collectionPointCount: null,
      provider: `${profile.provider}:${profile.model}`,
      deployment: this.deployment,
    }
  }
}

export function desiredProfileFromConfig(config: ResolvedConfig): EmbeddingProfile {
  return embeddingProfileFromConfig(config)
}
