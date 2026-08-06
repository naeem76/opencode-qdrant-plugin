import { createSignal, onCleanup, createComponent } from "solid-js";
import { createElement, insert, setProp } from "@opentui/solid";
import * as fs from "node:fs";
import * as path from "node:path";
import { retryReadSync, atomicWriteFileSync } from "./fs-helpers.js";
import { writeEmbeddingSettingsSync } from "./embedding-settings.js";
import { getOpenRouterApiKey, listOpenRouterEmbeddingModels, probeOpenRouterDimensions, selectRecommendedFreeModel, } from "./openrouter.js";
import { QDRANT_OPENROUTER_AUTH_ID, readStoredOpenRouterApiKeySync, } from "./opencode-auth.js";
import { getProjectDataDir } from "./paths.js";
import { OPENROUTER_API_KEY_ENV, OPENROUTER_API_URL, } from "./profiles.js";
function statusFilePath(rootDir) {
    return path.join(getProjectDataDir(rootDir), "status.json");
}
function triggerFilePath(rootDir) {
    return path.join(getProjectDataDir(rootDir), "trigger.json");
}
function legacyStatusPath(rootDir) {
    return path.join(rootDir, ".opencode", "qdrant-status.json");
}
function legacyTriggerPath(rootDir) {
    return path.join(rootDir, ".opencode", "qdrant-reindex-trigger.json");
}
const LEGACY_CLEANED = new Set();
function cleanupLegacyFilesSync(rootDir) {
    if (LEGACY_CLEANED.has(rootDir))
        return;
    LEGACY_CLEANED.add(rootDir);
    for (const legacy of [legacyStatusPath(rootDir), legacyTriggerPath(rootDir)]) {
        try {
            fs.unlinkSync(legacy);
        }
        catch {
            // ENOENT or locked — ignore
        }
    }
}
function readStatus(rootDir) {
    try {
        return JSON.parse(retryReadSync(statusFilePath(rootDir)));
    }
    catch {
        return null;
    }
}
function writeTriggerFile(rootDir, full, action = "reindex") {
    const fp = triggerFilePath(rootDir);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    atomicWriteFileSync(fp, JSON.stringify({ action, full, timestamp: Date.now() }));
    cleanupLegacyFilesSync(rootDir);
}
function localProfile() {
    return {
        version: 1,
        provider: "local",
        tier: "local",
        model: "Xenova/all-MiniLM-L6-v2",
        dimensions: 384,
        dtype: "q8",
    };
}
function openAlert(api, title, message) {
    api.ui.dialog.replace(() => createComponent(api.ui.DialogAlert, {
        title,
        message,
        onConfirm: () => api.ui.dialog.clear(),
    }));
}
function profileLabel(profile) {
    return `${profile.provider}/${profile.model} (${profile.dimensions}d)`;
}
function confirmProfile(api, profile) {
    const rootDir = api.state.path.directory;
    const status = readStatus(rootDir);
    const deployment = status?.deployment;
    const current = deployment?.active?.profile;
    const from = current ? profileLabel(current) : "none";
    const to = profileLabel(profile);
    const sameActive = current?.provider === profile.provider &&
        current.model === profile.model &&
        current.dimensions === profile.dimensions &&
        (current.dtype ?? null) === (profile.dtype ?? null) &&
        (current.apiUrl ?? null) === (profile.apiUrl ?? null) &&
        (current.sendDimensions ?? null) === (profile.sendDimensions ?? null);
    const reusable = [deployment?.previous, ...(deployment?.retained ?? [])].some((item) => item &&
        item.profile.provider === profile.provider &&
        item.profile.model === profile.model &&
        item.profile.dimensions === profile.dimensions &&
        (item.profile.dtype ?? null) === (profile.dtype ?? null) &&
        (item.profile.apiUrl ?? null) === (profile.apiUrl ?? null) &&
        (item.profile.sendDimensions ?? null) === (profile.sendDimensions ?? null));
    const stagingProfile = deployment?.staging?.profile;
    const cancelInFlight = sameActive &&
        stagingProfile != null &&
        deployment?.phase !== "failed" &&
        deployment?.phase !== "ready" &&
        (stagingProfile.provider !== profile.provider ||
            stagingProfile.model !== profile.model ||
            stagingProfile.dimensions !== profile.dimensions);
    const modeMessage = cancelInFlight
        ? [
            `This cancels the in-progress build of ${profileLabel(stagingProfile)}.`,
            `Search stays on ${to}.`,
        ]
        : sameActive
            ? [
                "This model is already active.",
                "Confirming only updates the saved preference (no rebuild).",
            ]
            : reusable
                ? [
                    "An existing index for this exact model will be reused.",
                    "Search switches immediately via alias cutover (no full rebuild).",
                    "A quick incremental catch-up runs for files changed while inactive.",
                ]
                : [
                    "A temporary staging collection will be built in the background.",
                    "Search stays pinned to the active index until an atomic cutover.",
                    "The previous model index is retained for instant switch-back.",
                ];
    api.ui.dialog.replace(() => createComponent(api.ui.DialogConfirm, {
        title: "Switch Qdrant embeddings?",
        message: [
            `From: ${from}`,
            `To: ${to}`,
            "",
            ...modeMessage,
            ...(profile.tier === "free" && !sameActive && !reusable && !cancelInFlight
                ? [
                    "OpenRouter free quotas are limited; exhausted 429s trigger a full local fallback rebuild.",
                ]
                : []),
        ].join("\n"),
        onConfirm: () => {
            writeEmbeddingSettingsSync(rootDir, {
                version: 1,
                desiredProfile: profile,
                fallbackToLocalOnRateLimit: profile.provider === "openrouter",
                updatedAt: Date.now(),
            });
            writeTriggerFile(rootDir, true, "settings");
            api.ui.dialog.clear();
            api.ui.toast({
                title: "Qdrant",
                message: cancelInFlight
                    ? `Keeping ${profile.model}; canceling in-progress build`
                    : sameActive
                        ? `${profile.model} is already active`
                        : reusable
                            ? `Switching back to ${profile.model}`
                            : `Building ${profile.model} in the background`,
                variant: "info",
            });
        },
        onCancel: () => api.ui.dialog.clear(),
    }));
}
async function buildOpenRouterProfile(api, model, tier, apiKey) {
    try {
        api.ui.toast({ title: "Qdrant", message: `Probing ${model.name}...`, variant: "info" });
        const dimensions = await probeOpenRouterDimensions(apiKey, model.id);
        confirmProfile(api, {
            version: 1,
            provider: "openrouter",
            tier,
            model: model.id,
            dimensions,
            apiUrl: OPENROUTER_API_URL,
            apiKeyEnv: OPENROUTER_API_KEY_ENV,
            sendDimensions: false,
        });
    }
    catch (error) {
        openAlert(api, "OpenRouter model unavailable", error instanceof Error ? error.message : String(error));
    }
}
function promptForOpenRouterApiKey(api, tier) {
    api.ui.dialog.replace(() => createComponent(api.ui.DialogPrompt, {
        title: "OpenRouter API key",
        placeholder: "Paste your OpenRouter API key",
        onConfirm: (value) => {
            const apiKey = value.trim();
            if (!apiKey) {
                openAlert(api, "OpenRouter API key required", "Enter a non-empty OpenRouter API key.");
                return;
            }
            void (async () => {
                try {
                    await api.client.auth.set({
                        providerID: QDRANT_OPENROUTER_AUTH_ID,
                        auth: { type: "api", key: apiKey },
                    }, { throwOnError: true });
                    api.ui.dialog.clear();
                    api.ui.toast({
                        title: "Qdrant",
                        message: "OpenRouter key saved in OpenCode credentials",
                        variant: "success",
                    });
                    await chooseOpenRouter(api, tier, apiKey);
                }
                catch (error) {
                    openAlert(api, "Could not save OpenRouter key", error instanceof Error ? error.message : String(error));
                }
            })();
        },
        onCancel: () => api.ui.dialog.clear(),
    }));
}
async function chooseOpenRouter(api, tier, providedApiKey) {
    const apiKey = providedApiKey ?? getOpenRouterApiKey() ?? readStoredOpenRouterApiKeySync();
    if (!apiKey) {
        promptForOpenRouterApiKey(api, tier);
        return;
    }
    try {
        api.ui.toast({ title: "Qdrant", message: "Loading OpenRouter embedding models...", variant: "info" });
        const models = await listOpenRouterEmbeddingModels(apiKey);
        if (tier === "free") {
            const recommended = selectRecommendedFreeModel(models);
            if (!recommended) {
                openAlert(api, "No free embedding model available", "OpenRouter returned no free embedding models.");
                return;
            }
            await buildOpenRouterProfile(api, recommended, "free", apiKey);
            return;
        }
        const paid = models.filter((model) => !model.free);
        api.ui.dialog.replace(() => createComponent((api.ui.DialogSelect), {
            title: "Choose a paid OpenRouter embedding model",
            placeholder: "Search embedding models",
            options: paid.map((model) => ({
                title: model.name,
                value: model,
                description: `${model.id}${model.contextLength ? ` · ${model.contextLength.toLocaleString()} context` : ""}`,
            })),
            onSelect: (option) => void buildOpenRouterProfile(api, option.value, "paid", apiKey),
        }));
    }
    catch (error) {
        openAlert(api, "OpenRouter discovery failed", error instanceof Error ? error.message : String(error));
    }
}
function openEmbeddingSetup(api) {
    api.ui.dialog.setSize("large");
    api.ui.dialog.replace(() => createComponent((api.ui.DialogSelect), {
        title: "Configure Qdrant embeddings",
        options: [
            {
                title: "Local (recommended for privacy)",
                value: "local",
                description: "MiniLM q8 on this machine; no API key or source upload",
            },
            {
                title: "OpenRouter free",
                value: "free",
                description: "Automatically select and probe the best supported free embedding model",
            },
            {
                title: "OpenRouter paid",
                value: "paid",
                description: "Choose from OpenRouter's current embedding-model catalog",
            },
        ],
        onSelect: (option) => {
            if (option.value === "local") {
                confirmProfile(api, localProfile());
            }
            else {
                void chooseOpenRouter(api, option.value);
            }
        },
    }));
}
// ---------------------------------------------------------------------------
// Sidebar component (no JSX — .ts files don't support it in Bun)
// ---------------------------------------------------------------------------
function StatusView(props) {
    const theme = () => props.api.theme.current;
    const rootDir = props.api.state.path.directory;
    const [status, setStatus] = createSignal(readStatus(rootDir));
    const timer = setInterval(() => setStatus(readStatus(rootDir)), 2000);
    onCleanup(() => clearInterval(timer));
    const dot = () => {
        const s = status();
        if (!s)
            return theme().textMuted;
        switch (s.status) {
            case "complete":
                return theme().success;
            case "error":
                return theme().warning;
            case "unavailable":
                return theme().error;
            case "rate_limited":
                return theme().warning;
            case "switching":
            case "indexing":
            case "discovering":
                return theme().info;
            case "idle":
                return theme().textMuted;
        }
    };
    const activeTier = () => {
        const profile = status()?.deployment?.active?.profile;
        if (!profile)
            return null;
        if (profile.tier === "local" || profile.provider === "local")
            return "Local";
        if (profile.tier === "free")
            return "OpenRouter free";
        if (profile.tier === "paid")
            return "OpenRouter paid";
        if (profile.provider === "openrouter")
            return "OpenRouter";
        if (profile.provider === "api")
            return "API";
        return profile.provider;
    };
    const activeModel = () => {
        const profile = status()?.deployment?.active?.profile;
        if (!profile)
            return status()?.provider ?? null;
        return `${profile.model} (${profile.dimensions}d)`;
    };
    const label = () => {
        const s = status();
        if (!s)
            return "Not connected";
        const tier = activeTier();
        if (s.deployment?.phase === "failed") {
            return tier ? `${tier} · Switch failed` : "Switch failed";
        }
        if (s.deployment?.staging) {
            return `Building ${s.processedFiles}/${s.totalFiles}...`;
        }
        switch (s.status) {
            case "idle":
                return tier ? `${tier} · Idle` : "Idle";
            case "discovering":
                return tier ? `${tier} · Discovering...` : "Discovering files...";
            case "indexing":
                return tier
                    ? `${tier} · Indexing ${s.processedFiles}/${s.totalFiles}`
                    : `Indexing ${s.processedFiles}/${s.totalFiles}...`;
            case "complete":
                return tier
                    ? `${tier} · ${s.collectionPointCount ?? 0} chunks`
                    : `${s.collectionPointCount ?? 0} chunks indexed`;
            case "error":
                return tier ? `${tier} · ${s.errorCount} error(s)` : `${s.errorCount} error(s)`;
            case "unavailable":
                return "Qdrant unavailable";
            case "switching":
                return tier ? `${tier} · Switching...` : "Switching active index...";
            case "rate_limited":
                return "Cloud rate limited";
        }
    };
    const detail = () => {
        const s = status();
        if (!s || s.status === "unavailable")
            return null;
        const model = activeModel();
        if (s.deployment?.phase === "failed") {
            return [
                model,
                "Active index still searchable",
                `Switch failed: ${s.deployment.lastError ?? "unknown error"}`,
            ]
                .filter(Boolean)
                .join("\n");
        }
        if (s.deployment?.staging) {
            const staging = s.deployment.staging.profile;
            return [
                model ? `Search: ${model}` : "Search unavailable",
                `Building: ${staging.provider}/${staging.model} (${staging.dimensions}d)`,
                `Phase: ${s.deployment.phase}${s.deployment.switchReason ? ` · ${s.deployment.switchReason}` : ""}`,
            ].join("\n");
        }
        if (s.status === "idle") {
            return model;
        }
        if (s.status === "complete" || s.status === "error") {
            return [model, `${s.processedFiles} files (${s.skippedFiles} unchanged)`]
                .filter(Boolean)
                .join("\n");
        }
        return model;
    };
    // Build UI tree imperatively
    const root = createElement("box");
    const title = createElement("text");
    setProp(title, "fg", theme().text);
    setProp(title, "bold", true);
    insert(title, "Qdrant");
    insert(root, title);
    const row = createElement("box");
    setProp(row, "flexDirection", "row");
    setProp(row, "gap", 1);
    const dotEl = createElement("text");
    setProp(dotEl, "flexShrink", 0);
    insert(dotEl, () => {
        setProp(dotEl, "fg", dot());
        return "\u25CF";
    });
    insert(row, dotEl);
    const labelEl = createElement("text");
    insert(labelEl, () => {
        setProp(labelEl, "fg", theme().text);
        return label();
    });
    insert(row, labelEl);
    insert(root, row);
    const detailEl = createElement("text");
    insert(detailEl, () => {
        const d = detail();
        setProp(detailEl, "fg", theme().textMuted);
        return d ?? "";
    });
    insert(root, detailEl);
    return root;
}
// ---------------------------------------------------------------------------
// TUI plugin entry
// ---------------------------------------------------------------------------
const tui = async (api) => {
    const initialStatus = readStatus(api.state.path.directory);
    if (initialStatus?.status === "unavailable") {
        api.ui.toast({
            title: "Qdrant",
            message: "Qdrant is unavailable. Semantic indexing and search are disabled.",
            variant: "error",
        });
    }
    api.slots.register({
        order: 150,
        slots: {
            sidebar_content() {
                // OpenTUI components return renderables rather than Solid's DOM Element type.
                // biome-ignore lint/suspicious/noExplicitAny: required by the OpenTUI/Solid type boundary
                return createComponent(StatusView, { api });
            },
        },
    });
    const unregisterSetup = api.keymap.registerLayer({
        commands: [
            {
                name: "qdrant.setup",
                namespace: "palette",
                title: "Qdrant: Configure embeddings",
                category: "Qdrant",
                slashName: "qdrant-setup",
                run() {
                    openEmbeddingSetup(api);
                },
            },
        ],
    });
    api.lifecycle.onDispose(unregisterSetup);
    api.command?.register(() => [
        {
            title: "Qdrant: Show indexing status",
            value: "qdrant.status",
            category: "Qdrant",
            slash: { name: "qdrant-index-status" },
            onSelect: () => {
                const s = readStatus(api.state.path.directory);
                if (s) {
                    api.ui.toast({
                        title: "Qdrant",
                        message: `${s.status} \u2014 ${s.collectionPointCount ?? 0} chunks, ${s.processedFiles} files`,
                        variant: s.status === "error" ? "warning" : "info",
                    });
                }
                else {
                    api.ui.toast({ message: "Qdrant status unavailable", variant: "error" });
                }
                api.ui.dialog.clear();
            },
        },
        {
            title: "Qdrant: Reindex project (incremental)",
            value: "qdrant.reindex",
            category: "Qdrant",
            slash: { name: "qdrant-reindex" },
            onSelect: () => {
                writeTriggerFile(api.state.path.directory, false);
                api.ui.toast({ title: "Qdrant", message: "Reindex triggered", variant: "info" });
                api.ui.dialog.clear();
            },
        },
        {
            title: "Qdrant: Reindex project (full)",
            value: "qdrant.reindex-full",
            category: "Qdrant",
            slash: { name: "qdrant-reindex-full" },
            onSelect: () => {
                writeTriggerFile(api.state.path.directory, true);
                api.ui.toast({ title: "Qdrant", message: "Full reindex triggered", variant: "info" });
                api.ui.dialog.clear();
            },
        },
    ]);
};
// ---------------------------------------------------------------------------
// Default export — required by OpenCode v1 plugin format
// ---------------------------------------------------------------------------
const plugin = {
    id: "opencode-qdrant",
    tui,
};
export default plugin;
