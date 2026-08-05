import { createSignal, onCleanup, createComponent } from "solid-js";
import { createElement, insert, setProp } from "@opentui/solid";
import * as fs from "node:fs";
import * as path from "node:path";
import { retryReadSync, atomicWriteFileSync } from "./fs-helpers.js";
import { getProjectDataDir } from "./paths.js";
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
function writeTriggerFile(rootDir, full) {
    const fp = triggerFilePath(rootDir);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    atomicWriteFileSync(fp, JSON.stringify({ full, timestamp: Date.now() }));
    cleanupLegacyFilesSync(rootDir);
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
            case "indexing":
            case "discovering":
                return theme().info;
            case "idle":
                return theme().textMuted;
        }
    };
    const label = () => {
        const s = status();
        if (!s)
            return "Not connected";
        switch (s.status) {
            case "idle":
                return "Idle";
            case "discovering":
                return "Discovering files...";
            case "indexing":
                return `Indexing ${s.processedFiles}/${s.totalFiles}...`;
            case "complete":
                return `${s.collectionPointCount ?? 0} chunks indexed`;
            case "error":
                return `${s.errorCount} error(s)`;
            case "unavailable":
                return "Qdrant unavailable";
        }
    };
    const detail = () => {
        const s = status();
        if (!s || s.status === "idle" || s.status === "unavailable")
            return null;
        if (s.status === "complete" || s.status === "error") {
            return `${s.processedFiles} files (${s.skippedFiles} unchanged)`;
        }
        return null;
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
                return createComponent(StatusView, { api });
            },
        },
    });
    api.command.register(() => [
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
