import crypto from "node:crypto";
import path from "node:path";
const LANGUAGE_BY_EXTENSION = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".json": "json",
    ".md": "markdown",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".kt": "kotlin",
    ".rb": "ruby",
    ".php": "php",
    ".cs": "csharp",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".c": "c",
    ".h": "c",
    ".hpp": "cpp",
    ".swift": "swift",
    ".scala": "scala",
    ".sql": "sql",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".sh": "shell",
    ".bash": "shell",
    ".zsh": "shell",
};
export function sha256(input) {
    return crypto.createHash("sha256").update(input).digest("hex");
}
export function detectLanguage(filePath) {
    return LANGUAGE_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? "text";
}
export function normalizeSlashes(value) {
    return value.replace(/\\/g, "/");
}
export function truncate(text, maxLength = 800) {
    if (text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, maxLength - 3)}...`;
}
export function isSensitivePath(filePath) {
    const normalized = normalizeSlashes(filePath).toLowerCase();
    return [
        "/.env",
        ".env.",
        ".pem",
        ".key",
        ".p12",
        ".pfx",
        ".keystore",
        "secret",
        "credential",
    ].some((needle) => normalized.includes(needle));
}
export function isGeneratedLikePath(filePath) {
    const normalized = normalizeSlashes(filePath).toLowerCase();
    return [
        ".min.js",
        ".min.css",
        "package-lock.json",
        "bun.lock",
        "yarn.lock",
        "pnpm-lock.yaml",
    ].some((needle) => normalized.endsWith(needle) || normalized.includes(`/${needle}`));
}
export function collectionNameForProject(basePath, dimensions) {
    return `opencode_${sha256(basePath).slice(0, 12)}_${dimensions}`;
}
