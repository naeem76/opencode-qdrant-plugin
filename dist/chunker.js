const BOUNDARY_PATTERNS = [
    /^(export\s+)?(async\s+)?(function|class|interface|type|enum)\b/,
    /^(public|private|protected)\s+/,
    /^(const|let|var)\s+[A-Za-z0-9_$]+\s*=\s*(async\s*)?(\(|function)/,
    /^(describe|it|test|beforeEach|afterEach)\s*\(/,
    /^#{2,6}\s/,
];
export function extractFileSummary(content, maxLines = 20) {
    const lines = content.split(/\r?\n/).slice(0, maxLines);
    return {
        type: "summary",
        startLine: 1,
        endLine: Math.max(lines.length, 1),
        content: lines.join("\n").trim(),
    };
}
export function chunkFile(content, maxLines, overlapLines) {
    const lines = content.split(/\r?\n/);
    const starts = new Set([0]);
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (!line) {
            if (!lines[index + 1]?.trim()) {
                starts.add(index + 1);
            }
            continue;
        }
        if (BOUNDARY_PATTERNS.some((pattern) => pattern.test(line))) {
            starts.add(index);
        }
    }
    const sortedStarts = [...starts].filter((value) => value < lines.length).sort((a, b) => a - b);
    const ranges = [];
    for (let index = 0; index < sortedStarts.length; index += 1) {
        const start = sortedStarts[index];
        const next = sortedStarts[index + 1] ?? lines.length;
        splitLargeRange(lines, start, next, maxLines, ranges);
    }
    const merged = mergeTinyRanges(ranges, maxLines);
    const chunks = [];
    for (const [index, [start, end]] of merged.entries()) {
        const expandedStart = Math.max(0, index === 0 ? start : start - overlapLines);
        const slice = lines.slice(expandedStart, end);
        const chunkContent = slice.join("\n").trim();
        if (!chunkContent) {
            continue;
        }
        chunks.push({
            type: "code",
            startLine: expandedStart + 1,
            endLine: end,
            content: chunkContent,
        });
    }
    return chunks;
}
function splitLargeRange(lines, start, end, maxLines, output) {
    let cursor = start;
    while (cursor < end) {
        let next = Math.min(cursor + maxLines, end);
        if (next < end) {
            for (let probe = next; probe > cursor + Math.floor(maxLines / 2); probe -= 1) {
                if (!lines[probe - 1]?.trim()) {
                    next = probe;
                    break;
                }
            }
        }
        output.push([cursor, next]);
        cursor = next;
    }
}
function mergeTinyRanges(ranges, maxLines) {
    const merged = [];
    for (const range of ranges) {
        const size = range[1] - range[0];
        const previous = merged[merged.length - 1];
        if (previous && size < 5 && range[1] - previous[0] <= maxLines) {
            previous[1] = range[1];
            continue;
        }
        merged.push([...range]);
    }
    return merged;
}
