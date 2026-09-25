/**
 * MEMORY.md promotion — bridge nuggets to Claude Code's native memory.
 *
 * Facts recalled 3+ times across sessions are promoted to MEMORY.md
 * for permanent context inclusion.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
const PROMOTE_THRESHOLD = 3;
const MEMORY_MD_HEADER = `# Memory

Auto-promoted from nuggets (3+ recalls across sessions).
`;
function detectMemoryDir() {
    const cwd = process.cwd();
    // Claude Code convention: replace / with - and prepend -
    const safe = cwd.replace(/\//g, "-");
    const memoryDir = join(homedir(), ".claude", "projects", safe, "memory");
    const projectDir = dirname(memoryDir);
    if (!existsSync(projectDir))
        return null;
    return memoryDir;
}
function parseMemoryMd(content) {
    const sections = {};
    let currentSection = "";
    for (const line of content.split("\n")) {
        const stripped = line.trim();
        // Section header
        const sectionMatch = stripped.match(/^##\s+(.+)$/);
        if (sectionMatch) {
            currentSection = sectionMatch[1].trim();
            if (!(currentSection in sections)) {
                sections[currentSection] = {};
            }
            continue;
        }
        // Fact entry: - **key**: value
        const factMatch = stripped.match(/^-\s+\*\*(.+?)\*\*:\s*(.+)$/);
        if (factMatch && currentSection) {
            sections[currentSection][factMatch[1].trim()] = factMatch[2].trim();
        }
    }
    return sections;
}
function renderMemoryMd(sections) {
    const keys = Object.keys(sections);
    if (keys.length === 0)
        return MEMORY_MD_HEADER;
    // Ordering: learnings first, preferences second, then alphabetical
    const priority = ["learnings", "preferences"];
    const ordered = [];
    for (const p of priority) {
        if (p in sections)
            ordered.push(p);
    }
    const remaining = keys.filter((k) => !priority.includes(k)).sort();
    ordered.push(...remaining);
    const lines = [MEMORY_MD_HEADER];
    for (const sectionName of ordered) {
        const facts = sections[sectionName];
        const entries = Object.entries(facts);
        if (entries.length === 0)
            continue;
        lines.push(`## ${sectionName}\n`);
        for (const [key, value] of entries) {
            lines.push(`- **${key}**: ${value}`);
        }
        lines.push("");
    }
    return lines.join("\n");
}
/**
 * Promote facts with hits >= threshold to MEMORY.md.
 * Merges into existing MEMORY.md (idempotent). Returns count of
 * newly promoted facts.
 */
export function promoteFacts(shelf) {
    const memoryDir = detectMemoryDir();
    if (!memoryDir)
        return 0;
    // Collect promotable facts
    const candidates = [];
    for (const info of shelf.list()) {
        const name = info.name;
        try {
            const nugget = shelf.get(name);
            for (const fact of nugget.facts()) {
                if ((fact.hits || 0) >= PROMOTE_THRESHOLD) {
                    candidates.push({ nuggetName: name, key: fact.key, value: fact.value });
                }
            }
        }
        catch {
            continue;
        }
    }
    if (candidates.length === 0)
        return 0;
    // Load existing MEMORY.md
    const memoryPath = join(memoryDir, "MEMORY.md");
    let existingContent = "";
    if (existsSync(memoryPath)) {
        existingContent = readFileSync(memoryPath, "utf-8");
    }
    const sections = existingContent ? parseMemoryMd(existingContent) : {};
    // Merge candidates
    let newCount = 0;
    for (const { nuggetName, key, value } of candidates) {
        if (!(nuggetName in sections)) {
            sections[nuggetName] = {};
        }
        const existing = sections[nuggetName][key];
        if (existing !== value) {
            sections[nuggetName][key] = value;
            if (existing === undefined)
                newCount++;
        }
    }
    if (newCount === 0 && existingContent) {
        const newContent = renderMemoryMd(sections);
        if (newContent === existingContent)
            return 0;
    }
    // Atomic write
    mkdirSync(memoryDir, { recursive: true });
    const tmpPath = memoryPath + ".tmp";
    const newContent = renderMemoryMd(sections);
    writeFileSync(tmpPath, newContent);
    renameSync(tmpPath, memoryPath);
    return newCount;
}
//# sourceMappingURL=promote.js.map