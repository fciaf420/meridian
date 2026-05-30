/**
 * Knowledge Base — LLM-maintained markdown wiki.
 *
 * The agent writes and maintains interlinked markdown articles about tokens,
 * strategies, market regimes, and pool behaviors. Auto-maintained INDEX.md
 * and CONCEPTS.md replace the need for RAG at this scale.
 *
 * Existing JSON systems (lessons.json, pool-memory.json, nuggets) remain
 * the structured data sources. The KB is a synthesis layer on top.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getKbDir() {
  return path.resolve(__dirname, config.knowledgeBase?.dir || "./knowledge");
}

// ─── Caching Layer ────────────────────────────────────────────
// Avoids repeated full directory walks + file reads every cycle.

const _cache = {
  summary: { value: null, ts: 0 },          // getKbSummaryForPrompt
  stats: { value: null, ts: 0 },             // getKbStats
  articles: { value: null, ts: 0 },          // listArticles (all)
  searchIndex: { entries: null, ts: 0 },     // searchArticles index
};
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function invalidateCache() {
  _cache.summary.ts = 0;
  _cache.stats.ts = 0;
  _cache.articles.ts = 0;
  _cache.searchIndex.ts = 0;
}

// ─── File I/O ──────────────────────────────────────────────────

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * List all .md articles, optionally filtered by category (subdirectory).
 * Uses cache for unfiltered (all) listings to avoid repeated directory walks.
 */
export function listArticles(category = null) {
  const kbDir = getKbDir();
  if (!fs.existsSync(kbDir)) return [];

  // Cache hit for unfiltered listing
  if (!category && _cache.articles.value && Date.now() - _cache.articles.ts < CACHE_TTL_MS) {
    return _cache.articles.value;
  }

  const articles = [];
  const searchDir = category ? path.join(kbDir, category) : kbDir;
  if (!searchDir.startsWith(kbDir)) return []; // prevent path traversal
  if (!fs.existsSync(searchDir)) return [];

  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // Skip visuals directory in listings
        if (entry.name === "visuals") continue;
        walk(path.join(dir, entry.name), path.join(rel, entry.name));
      } else if (entry.name.endsWith(".md") && entry.name !== "INDEX.md" && entry.name !== "CONCEPTS.md") {
        const filePath = path.join(dir, entry.name);
        try {
          const stat = fs.statSync(filePath);
          const content = fs.readFileSync(filePath, "utf8");
          const title = extractTitle(content) || entry.name.replace(".md", "");
          const summary = extractSummary(content);
          articles.push({
            path: path.join(rel, entry.name),
            title,
            summary,
            updated: stat.mtime.toISOString(),
            words: content.trim().split(/\s+/).filter(Boolean).length,
          });
        } catch { /* skip unreadable files */ }
      }
    }
  };

  walk(searchDir, category || "");
  articles.sort((a, b) => new Date(b.updated) - new Date(a.updated));

  // Cache unfiltered results
  if (!category) {
    _cache.articles.value = articles;
    _cache.articles.ts = Date.now();
  }

  return articles;
}

/**
 * Read an article by its relative path within the KB directory.
 */
export function readArticle(articlePath) {
  const kbDir = getKbDir();
  const fullPath = path.join(kbDir, articlePath);

  // Security: prevent path traversal
  if (!fullPath.startsWith(kbDir)) {
    return { error: "Invalid path — must be within knowledge directory" };
  }

  if (!fs.existsSync(fullPath)) {
    return { error: `Article not found: ${articlePath}` };
  }

  return {
    path: articlePath,
    content: fs.readFileSync(fullPath, "utf8"),
    updated: fs.statSync(fullPath).mtime.toISOString(),
  };
}

/**
 * Write or update an article. Creates parent directories as needed.
 * Auto-updates the INDEX.md entry for this article.
 */
export function writeArticle(articlePath, content) {
  const kbDir = getKbDir();
  const fullPath = path.join(kbDir, articlePath);

  // Security: prevent path traversal
  if (!fullPath.startsWith(kbDir)) {
    return { error: "Invalid path — must be within knowledge directory" };
  }

  // Enforce max articles
  const maxArticles = config.knowledgeBase?.maxArticles || 500;
  const existing = listArticles();
  const isNew = !fs.existsSync(fullPath);
  if (isNew && existing.length >= maxArticles) {
    return { error: `KB at capacity (${maxArticles} articles). Delete old articles first.` };
  }

  ensureDir(path.dirname(fullPath));
  fs.writeFileSync(fullPath, content);
  log("kb", `${isNew ? "Created" : "Updated"} article: ${articlePath}`);

  // Update index entry for this article
  updateIndexEntry(articlePath, content);

  // Invalidate caches so next read picks up the change
  invalidateCache();

  return { success: true, path: articlePath, created: isNew };
}

/**
 * Delete an article and remove its INDEX.md entry.
 */
export function deleteArticle(articlePath) {
  const kbDir = getKbDir();
  const fullPath = path.join(kbDir, articlePath);

  if (!fullPath.startsWith(kbDir)) {
    return { error: "Invalid path — must be within knowledge directory" };
  }

  if (!fs.existsSync(fullPath)) {
    return { error: `Article not found: ${articlePath}` };
  }

  fs.unlinkSync(fullPath);
  removeIndexEntry(articlePath);
  invalidateCache();
  log("kb", `Deleted article: ${articlePath}`);
  return { success: true, path: articlePath };
}

/**
 * Build or refresh the in-memory search index (path → { title, lowerContent, lines }).
 * Avoids re-reading every file on each search call.
 */
function getSearchIndex() {
  if (_cache.searchIndex.entries && Date.now() - _cache.searchIndex.ts < CACHE_TTL_MS) {
    return _cache.searchIndex.entries;
  }

  const kbDir = getKbDir();
  if (!fs.existsSync(kbDir)) return [];

  const entries = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === "visuals") continue;
        walk(path.join(dir, entry.name), path.join(rel, entry.name));
      } else if (entry.name.endsWith(".md") && entry.name !== "INDEX.md" && entry.name !== "CONCEPTS.md") {
        const filePath = path.join(dir, entry.name);
        try {
          const content = fs.readFileSync(filePath, "utf8");
          entries.push({
            relPath: path.join(rel, entry.name),
            title: extractTitle(content) || entry.name.replace(".md", ""),
            lowerContent: content.toLowerCase(),
            lines: content.split("\n"),
          });
        } catch { /* skip */ }
      }
    }
  };
  walk(kbDir, "");

  _cache.searchIndex.entries = entries;
  _cache.searchIndex.ts = Date.now();
  return entries;
}

/**
 * Full-text search across all articles. Returns matching file paths + context lines.
 * Uses cached search index to avoid re-reading files on every query.
 */
export function searchArticles(query) {
  if (!query) return { error: "query required" };

  const index = getSearchIndex();
  if (index.length === 0) return { results: [], total: 0 };

  const queryLower = query.toLowerCase();
  const results = [];

  for (const entry of index) {
    if (!entry.lowerContent.includes(queryLower)) continue;

    const matchedLines = [];
    for (let i = 0; i < entry.lines.length; i++) {
      if (entry.lines[i].toLowerCase().includes(queryLower)) {
        matchedLines.push({ line: i + 1, text: entry.lines[i].trim() });
      }
    }

    if (matchedLines.length > 0) {
      results.push({
        path: entry.relPath,
        title: entry.title,
        matches: matchedLines.length,
        matchedLines: matchedLines.slice(0, 5),
      });
    }
  }

  results.sort((a, b) => b.matches - a.matches);
  return { results: results.slice(0, 20), total: results.length };
}

// ─── Index Management ──────────────────────────────────────────

/**
 * Update a single entry in INDEX.md when an article is written.
 */
function updateIndexEntry(articlePath, content) {
  const kbDir = getKbDir();
  const indexPath = path.join(kbDir, "INDEX.md");
  const title = extractTitle(content) || articlePath.replace(".md", "");
  const summary = extractSummary(content);
  const entry = `- [${title}](${articlePath}) — ${summary}`;

  let indexContent = "";
  if (fs.existsSync(indexPath)) {
    indexContent = fs.readFileSync(indexPath, "utf8");
  } else {
    indexContent = "# Knowledge Base Index\n\nAuto-maintained index of all articles.\n\n";
  }

  // Replace existing entry or append
  const entryPattern = new RegExp(`^- \\[.*?\\]\\(${escapeRegex(articlePath)}\\).*$`, "m");
  if (entryPattern.test(indexContent)) {
    indexContent = indexContent.replace(entryPattern, entry);
  } else {
    indexContent = indexContent.trimEnd() + "\n" + entry + "\n";
  }

  ensureDir(kbDir);
  fs.writeFileSync(indexPath, indexContent);
}

/**
 * Remove an entry from INDEX.md when an article is deleted.
 */
function removeIndexEntry(articlePath) {
  const kbDir = getKbDir();
  const indexPath = path.join(kbDir, "INDEX.md");
  if (!fs.existsSync(indexPath)) return;

  let indexContent = fs.readFileSync(indexPath, "utf8");
  const entryPattern = new RegExp(`^- \\[.*?\\]\\(${escapeRegex(articlePath)}\\).*\\n?`, "m");
  indexContent = indexContent.replace(entryPattern, "");
  fs.writeFileSync(indexPath, indexContent);
}

/**
 * Full rebuild of INDEX.md by scanning all articles.
 */
export function rebuildIndex() {
  const kbDir = getKbDir();
  ensureDir(kbDir);

  const articles = listArticles();
  const categories = {};

  for (const article of articles) {
    const cat = path.dirname(article.path) || "root";
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(article);
  }

  let content = "# Knowledge Base Index\n\nAuto-maintained index of all articles.\n";

  for (const [cat, arts] of Object.entries(categories).sort()) {
    const label = cat === "." ? "General" : cat.charAt(0).toUpperCase() + cat.slice(1);
    content += `\n## ${label}\n\n`;
    for (const a of arts) {
      content += `- [${a.title}](${a.path}) — ${a.summary} *(${a.words} words, updated ${a.updated.slice(0, 10)})*\n`;
    }
  }

  fs.writeFileSync(path.join(kbDir, "INDEX.md"), content);
  log("kb", `Rebuilt INDEX.md (${articles.length} articles)`);
  return { articles: articles.length };
}

/**
 * Full rebuild of CONCEPTS.md by scanning all articles for [[backlinks]].
 */
export function rebuildConcepts() {
  const kbDir = getKbDir();
  ensureDir(kbDir);

  const articles = listArticles();
  const concepts = {};

  // Scan for [[concept]] style links (deduplicate per article)
  const linkPattern = /\[\[([^\]]+)\]\]/g;

  for (const article of articles) {
    const fullPath = path.join(kbDir, article.path);
    try {
      const fileContent = fs.readFileSync(fullPath, "utf8");
      let match;
      while ((match = linkPattern.exec(fileContent)) !== null) {
        const concept = match[1].trim();
        if (!concepts[concept]) concepts[concept] = new Set();
        concepts[concept].add(article.path);
      }
    } catch { /* skip unreadable files */ }
  }

  let content = "# Concepts\n\nRecurring themes and their backlinks across the knowledge base.\n";

  const sorted = Object.entries(concepts).sort((a, b) => b[1].size - a[1].size);
  for (const [concept, refs] of sorted) {
    content += `\n### ${concept}\n`;
    content += `Referenced in ${refs.size} article(s):\n`;
    for (const ref of refs) {
      content += `- [${ref}](${ref})\n`;
    }
  }

  fs.writeFileSync(path.join(kbDir, "CONCEPTS.md"), content);
  log("kb", `Rebuilt CONCEPTS.md (${sorted.length} concepts)`);
  return { concepts: sorted.length };
}

// ─── Migration ─────────────────────────���───────────────────────

/**
 * One-time migration from existing JSON data to initial KB articles.
 * Idempotent — skips articles that already exist.
 */
export async function migrateFromJson() {
  const kbDir = getKbDir();
  ensureDir(kbDir);

  let created = 0;
  let skipped = 0;

  // 1. Migrate lessons.json → knowledge/lessons/
  try {
    const lessonsPath = path.join(__dirname, "lessons.json");
    if (fs.existsSync(lessonsPath)) {
      const data = JSON.parse(fs.readFileSync(lessonsPath, "utf8"));
      const lessons = data.lessons || [];

      if (lessons.length > 0) {
        // Group lessons by tags
        const groups = {};
        for (const lesson of lessons) {
          const tag = (lesson.tags && lesson.tags[0]) || "general";
          if (!groups[tag]) groups[tag] = [];
          groups[tag].push(lesson);
        }

        for (const [tag, tagLessons] of Object.entries(groups)) {
          const slug = tag.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase().replace(/^-+|-+$/g, "") || "uncategorized";
          const articlePath = `lessons/${slug}.md`;
          const fullPath = path.join(kbDir, articlePath);

          if (fs.existsSync(fullPath)) { skipped++; continue; }

          let content = `# Lessons: ${tag}\n\n`;
          content += `*Migrated from lessons.json — ${tagLessons.length} lessons*\n\n`;

          for (const l of tagLessons) {
            content += `- ${l.rule}`;
            if (l.pnl_pct != null) content += ` *(PnL: ${l.pnl_pct}%)*`;
            if (l.pool) content += ` — pool: ${l.pool}`;
            content += `\n`;
          }

          const result = writeArticle(articlePath, content);
          if (result.success) created++; else skipped++;
        }
      }

      // Migrate performance data
      const perf = data.performance || [];
      if (perf.length > 0) {
        const perfPath = "performance/historical-summary.md";
        const fullPerfPath = path.join(kbDir, perfPath);

        if (!fs.existsSync(fullPerfPath)) {
          const wins = perf.filter(p => (p.pnl_pct ?? 0) >= 0);
          const losses = perf.filter(p => (p.pnl_pct ?? 0) < 0);
          const avgPnl = perf.reduce((s, p) => s + (p.pnl_pct ?? 0), 0) / perf.length;

          let content = `# Historical Performance Summary\n\n`;
          content += `*Migrated from lessons.json — ${perf.length} closed positions*\n\n`;
          content += `## Overview\n\n`;
          content += `- Total positions: ${perf.length}\n`;
          content += `- Wins: ${wins.length} (${((wins.length / perf.length) * 100).toFixed(0)}%)\n`;
          content += `- Losses: ${losses.length}\n`;
          content += `- Average PnL: ${avgPnl.toFixed(2)}%\n\n`;

          content += `## Recent Closes\n\n`;
          for (const p of perf.slice(-10)) {
            content += `- ${p.pool_name || p.pool || "unknown"}: ${(p.pnl_pct ?? 0).toFixed(1)}% PnL, ${p.close_reason || "manual"}\n`;
          }

          const perfResult = writeArticle(perfPath, content);
          if (perfResult.success) created++; else skipped++;
        } else { skipped++; }
      }
    }
  } catch (e) {
    log("kb", `Lessons migration error: ${e.message}`);
  }

  // 2. Migrate pool-memory.json → knowledge/pools/
  try {
    const poolMemPath = path.join(__dirname, "pool-memory.json");
    if (fs.existsSync(poolMemPath)) {
      const pools = JSON.parse(fs.readFileSync(poolMemPath, "utf8"));

      for (const [addr, pool] of Object.entries(pools)) {
        if ((pool.total_deploys || 0) < 2) continue; // Only migrate pools with history

        const slug = (pool.name || addr.slice(0, 8)).replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase().replace(/^-+|-+$/g, "") || addr.slice(0, 8);
        const articlePath = `pools/${slug}.md`;
        const fullPath = path.join(kbDir, articlePath);

        if (fs.existsSync(fullPath)) { skipped++; continue; }

        let content = `# Pool: ${pool.name || addr.slice(0, 8)}\n\n`;
        content += `**Address:** \`${addr}\`\n`;
        if (pool.base_mint) content += `**Base Mint:** \`${pool.base_mint}\`\n`;
        content += `\n## Deploy History\n\n`;
        content += `- Total deploys: ${pool.total_deploys}\n`;
        content += `- Average PnL: ${pool.avg_pnl_pct}%\n`;
        content += `- Win rate: ${((pool.win_rate || 0) * 100).toFixed(0)}%\n`;
        content += `- Last outcome: ${pool.last_outcome || "unknown"}\n\n`;

        if (pool.deploys?.length > 0) {
          content += `## Deploy Details\n\n`;
          for (const d of pool.deploys.slice(-5)) {
            content += `- ${d.closed_at?.slice(0, 10) || "?"}: PnL ${d.pnl_pct ?? "?"}%, held ${d.minutes_held ?? "?"}min, strategy: ${d.strategy || "?"}, reason: ${d.close_reason || "?"}\n`;
          }
        }

        if (pool.notes?.length > 0) {
          content += `\n## Notes\n\n`;
          for (const n of pool.notes) {
            content += `- ${n.added_at?.slice(0, 10) || "?"}: ${n.note}\n`;
          }
        }

        const poolResult = writeArticle(articlePath, content);
        if (poolResult.success) created++; else skipped++;
      }
    }
  } catch (e) {
    log("kb", `Pool memory migration error: ${e.message}`);
  }

  // 3. Migrate nuggets facts → knowledge/strategies/ and knowledge/patterns/
  try {
    const { getShelf } = await import("./memory.js");
    const shelf = getShelf();

    for (const nuggetName of ["strategies", "patterns"]) {
      try {
        const nugget = shelf.get(nuggetName);
        if (!nugget) continue;
        const facts = nugget.facts();
        if (facts.length === 0) continue;

        const articlePath = `${nuggetName}/compiled-from-nuggets.md`;
        const fullPath = path.join(kbDir, articlePath);

        if (fs.existsSync(fullPath)) { skipped++; continue; }

        let content = `# ${nuggetName.charAt(0).toUpperCase() + nuggetName.slice(1)}: Compiled from Memory\n\n`;
        content += `*Migrated from Nuggets holographic memory — ${facts.length} facts*\n\n`;

        for (const f of facts) {
          content += `- **${f.key}**: ${f.value}`;
          if (f.hits > 1) content += ` *(recalled ${f.hits}x)*`;
          content += `\n`;
        }

        const nuggetResult = writeArticle(articlePath, content);
        if (nuggetResult.success) created++; else skipped++;
      } catch { /* nugget may not exist */ }
    }
  } catch (e) {
    log("kb", `Nuggets migration error: ${e.message}`);
  }

  // 4. Rebuild indexes
  rebuildIndex();
  rebuildConcepts();

  log("kb", `Migration complete: ${created} articles created, ${skipped} skipped`);
  return { created, skipped };
}

// ─── Stats & Prompt ────────────────────────────────────────────

/**
 * Get KB statistics. Cached to avoid repeated directory walks.
 */
export function getKbStats() {
  if (_cache.stats.value && Date.now() - _cache.stats.ts < CACHE_TTL_MS) {
    return _cache.stats.value;
  }

  const kbDir = getKbDir();
  if (!fs.existsSync(kbDir)) {
    return { totalArticles: 0, totalWords: 0, categories: {}, lastUpdated: null };
  }

  const articles = listArticles();
  const categories = {};
  let totalWords = 0;
  let lastUpdated = null;

  for (const a of articles) {
    const cat = path.dirname(a.path) || "root";
    categories[cat] = (categories[cat] || 0) + 1;
    totalWords += a.words;
    if (!lastUpdated || a.updated > lastUpdated) lastUpdated = a.updated;
  }

  const result = {
    totalArticles: articles.length,
    totalWords,
    categories,
    lastUpdated,
  };

  _cache.stats.value = result;
  _cache.stats.ts = Date.now();
  return result;
}

/**
 * Short summary for system prompt injection.
 * Returns null if KB is empty or disabled.
 * Cached for CACHE_TTL_MS to avoid re-reading INDEX.md every cycle.
 */
export function getKbSummaryForPrompt() {
  if (!config.knowledgeBase?.enabled) return null;

  // Return cached summary if fresh
  if (_cache.summary.value !== null && Date.now() - _cache.summary.ts < CACHE_TTL_MS) {
    return _cache.summary.value;
  }

  const kbDir = getKbDir();
  const indexPath = path.join(kbDir, "INDEX.md");
  if (!fs.existsSync(indexPath)) return null;

  const stats = getKbStats();
  if (stats.totalArticles === 0) return null;

  // Read INDEX.md (truncated if large)
  const indexContent = fs.readFileSync(indexPath, "utf8");
  const truncated = indexContent.length > 3000
    ? indexContent.slice(0, 3000) + "\n...(truncated, use kb_read for full index)"
    : indexContent;

  const result = `Knowledge Base: ${stats.totalArticles} articles, ${stats.totalWords} words across ${Object.keys(stats.categories).length} categories.
Last updated: ${stats.lastUpdated?.slice(0, 10) || "never"}
Use kb_read, kb_search, and kb_list tools to explore. Use kb_write to add observations.

${truncated}`;

  _cache.summary.value = result;
  _cache.summary.ts = Date.now();
  return result;
}

const KB_CATEGORY_PRIORITY = {
  SCREENER: ["strategies", "patterns", "screening", "lessons", "pools"],
  MANAGER: ["performance", "lessons", "patterns", "strategies", "pools"],
  GENERAL: ["patterns", "lessons", "performance", "strategies", "pools"],
};

export function getKbArticlesForPrompt(agentType = "GENERAL", maxArticles = 4) {
  if (!config.knowledgeBase?.enabled) return [];

  const categories = KB_CATEGORY_PRIORITY[agentType] || KB_CATEGORY_PRIORITY.GENERAL;
  const seenPaths = new Set();
  const selected = [];

  for (const category of categories) {
    const articles = listArticles(category);
    for (const article of articles) {
      const summary = (article.summary || "").trim();
      if (!summary || /^\*\*Address:/i.test(summary) || /^\*Auto-created/i.test(summary)) {
        continue;
      }
      if (seenPaths.has(article.path)) continue;
      seenPaths.add(article.path);
      selected.push({
        category,
        path: article.path,
        title: article.title,
        summary,
        updated: article.updated,
        words: article.words,
      });
      if (selected.length >= maxArticles) {
        return selected;
      }
    }
  }

  return selected;
}

// ─── Pre-loading for Cycles ────────────────────────────────────

/**
 * Pre-load relevant KB content for a screening cycle.
 * Searches for articles matching candidate tokens and active strategies.
 * Returns a formatted string for injection into the cycle goal, or null.
 */
export function kbRecallForScreening(candidates = []) {
  if (!config.knowledgeBase?.enabled) return null;
  const kbDir = getKbDir();
  if (!fs.existsSync(kbDir)) return null;

  const hints = [];

  // 1. Check for strategy articles
  const strategyArticles = listArticles("strategies");
  for (const a of strategyArticles.slice(0, 3)) {
    try {
      const content = fs.readFileSync(path.join(kbDir, a.path), "utf8");
      // Extract first 300 chars of body (skip title)
      const body = content.replace(/^#.*\n+/, "").trim().slice(0, 300);
      if (body) hints.push(`[KB: ${a.title}] ${body}`);
    } catch { /* skip */ }
  }

  // 2. Check for pattern articles
  const patternArticles = listArticles("patterns");
  for (const a of patternArticles.slice(0, 2)) {
    try {
      const content = fs.readFileSync(path.join(kbDir, a.path), "utf8");
      const body = content.replace(/^#.*\n+/, "").trim().slice(0, 300);
      if (body) hints.push(`[KB: ${a.title}] ${body}`);
    } catch { /* skip */ }
  }

  // 3. Search for articles matching candidate token names
  for (const c of candidates.slice(0, 3)) {
    const name = c.name || c.pair || "";
    const tokenName = name.split("-")[0]?.trim();
    if (!tokenName || tokenName.length < 2) continue;
    const results = searchArticles(tokenName);
    for (const r of (results.results || []).slice(0, 1)) {
      try {
        const content = fs.readFileSync(path.join(kbDir, r.path), "utf8");
        const body = content.replace(/^#.*\n+/, "").trim().slice(0, 400);
        if (body) hints.push(`[KB: ${r.title}] ${body}`);
      } catch { /* skip */ }
    }
  }

  if (hints.length === 0) return null;

  return `KNOWLEDGE BASE CONTEXT (compiled articles — use alongside lessons and memory):\n${hints.join("\n\n")}\n`;
}

/**
 * Pre-load relevant KB content for a management cycle.
 * Searches for articles matching open position tokens and recent performance.
 * Returns a formatted string for injection into the cycle goal, or null.
 */
export function kbRecallForManagement(positions = []) {
  if (!config.knowledgeBase?.enabled) return null;
  const kbDir = getKbDir();
  if (!fs.existsSync(kbDir)) return null;

  const hints = [];

  // 1. Search for articles matching open position tokens
  for (const p of positions.slice(0, 5)) {
    const name = p.pair || p.pool_name || "";
    const tokenName = name.split("-")[0]?.trim();
    if (!tokenName || tokenName.length < 2) continue;

    // Check pools/ directory first
    const results = searchArticles(tokenName);
    for (const r of (results.results || []).slice(0, 1)) {
      try {
        const content = fs.readFileSync(path.join(kbDir, r.path), "utf8");
        const body = content.replace(/^#.*\n+/, "").trim().slice(0, 400);
        if (body) hints.push(`[KB: ${r.title}] ${body}`);
      } catch { /* skip */ }
    }
  }

  // 2. Check for recent lesson articles (most recently updated)
  const lessonArticles = listArticles("lessons");
  for (const a of lessonArticles.slice(0, 2)) {
    try {
      const content = fs.readFileSync(path.join(kbDir, a.path), "utf8");
      const body = content.replace(/^#.*\n+/, "").trim().slice(0, 300);
      if (body) hints.push(`[KB: ${a.title}] ${body}`);
    } catch { /* skip */ }
  }

  // 3. Check for performance summary
  const perfArticles = listArticles("performance");
  if (perfArticles.length > 0) {
    try {
      const latest = perfArticles[0]; // Already sorted by updated desc
      const content = fs.readFileSync(path.join(kbDir, latest.path), "utf8");
      const body = content.replace(/^#.*\n+/, "").trim().slice(0, 300);
      if (body) hints.push(`[KB: ${latest.title}] ${body}`);
    } catch { /* skip */ }
  }

  if (hints.length === 0) return null;

  return `KNOWLEDGE BASE CONTEXT (compiled articles — use alongside lessons and memory):\n${hints.join("\n\n")}\n`;
}

// ─── Observation Filing ────────────────────────────────────────

let _lastFileTime = 0;
const FILE_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/**
 * Check if pattern synthesis should run after a management cycle.
 * Only triggers when there have been recent position closes (data to synthesize).
 * Returns a goal string for the agent if synthesis is needed, null otherwise.
 *
 * Note: Individual position closes and screening deploys are now filed directly
 * via filePositionClose() and fileScreeningResult() — no LLM needed for those.
 * This function only triggers LLM-driven pattern synthesis across articles.
 */
export function shouldFileObservations() {
  if (!config.knowledgeBase?.enabled || !config.knowledgeBase?.autoFile) return null;
  if (Date.now() - _lastFileTime < FILE_COOLDOWN_MS) return null;

  const kbDir = getKbDir();
  if (!fs.existsSync(kbDir)) return null;

  // Only trigger if there are pool articles with recent updates (position closes filed)
  const poolArticles = listArticles("pools");
  const recentCloses = poolArticles.filter(a => {
    const age = Date.now() - new Date(a.updated).getTime();
    return age < FILE_COOLDOWN_MS; // Updated within cooldown period
  });
  if (recentCloses.length === 0) return null;

  _lastFileTime = Date.now();
  return `KNOWLEDGE BASE SYNTHESIS: ${recentCloses.length} position(s) closed recently (${recentCloses.map(a => a.title).join(", ")}). Review pool articles via kb_list category=pools, look for recurring patterns across recent closes (similar loss causes, strategy effectiveness, volatility thresholds). If you find a pattern, write or update a patterns/ article using kb_write. Use [[concept]] syntax for cross-references. Be concise — max 1 new article per synthesis.`;
}

/**
 * Direct KB write on position close — no LLM needed.
 * Called from recordPerformance() to capture every close as structured data.
 * Updates or creates pool article with latest deploy outcome.
 */
export function filePositionClose(perf) {
  if (!config.knowledgeBase?.enabled) return;

  try {
    const kbDir = getKbDir();
    const name = perf.pool_name || perf.pool?.slice(0, 8) || "unknown";
    const slug = name.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase().replace(/^-+|-+$/g, "") || "unknown";
    const articlePath = `pools/${slug}.md`;
    const fullPath = path.join(kbDir, articlePath);

    const pnl = perf.pnl_pct ?? perf.actual_pnl_pct ?? 0;
    const outcome = pnl >= 0 ? "WIN" : "LOSS";
    const now = new Date().toISOString().slice(0, 16);
    const strategy = perf.strategy || "unknown";
    const reason = perf.close_reason || "manual";
    const held = perf.minutes_held ?? "?";
    const vol = perf.volatility ?? "?";
    const rangeEff = perf.minutes_held > 0
      ? ((perf.minutes_in_range / perf.minutes_held) * 100).toFixed(0)
      : "?";

    const closeLine = `- **${outcome}** ${now}: PnL ${pnl.toFixed(1)}%, held ${held}min, strategy: ${strategy}, range_eff: ${rangeEff}%, vol: ${vol}, reason: ${reason}`;

    if (fs.existsSync(fullPath)) {
      // Append to existing pool article under Deploy History section
      let content = fs.readFileSync(fullPath, "utf8");
      const historyMarker = "## Deploy History";
      if (content.includes(historyMarker)) {
        // Insert new close after the section header line
        const idx = content.indexOf(historyMarker);
        const afterHeader = content.indexOf("\n", idx) + 1;
        content = content.slice(0, afterHeader) + "\n" + closeLine + "\n" + content.slice(afterHeader);
      } else {
        content += `\n\n${historyMarker}\n\n${closeLine}\n`;
      }
      writeArticle(articlePath, content);
    } else {
      // Create new pool article
      let content = `# Pool: ${name}\n\n`;
      if (perf.pool) content += `**Address:** \`${perf.pool}\`\n`;
      if (perf.base_mint) content += `**Base Mint:** \`${perf.base_mint}\`\n`;
      content += `\n## Deploy History\n\n${closeLine}\n`;
      content += `\n## Notes\n\n*Auto-created on position close.*\n`;
      writeArticle(articlePath, content);
    }

    log("kb", `Filed position close: ${name} (${outcome}, ${pnl.toFixed(1)}%)`);

    // ─── Richer ingest: update concept articles touched by this close ───
    try {
      _updateConceptArticles(perf, outcome, pnl, name, strategy, reason, vol, rangeEff, held);
    } catch (e) {
      log("kb", `Concept article update failed (non-fatal): ${e.message}`);
    }

    // ─── Log the change ───
    try {
      _appendLog(`CLOSE ${outcome}: ${name} PnL ${pnl.toFixed(1)}%, strategy=${strategy}, held=${held}min, reason=${reason}`);
    } catch { /* best-effort */ }

  } catch (e) {
    log("kb", `Failed to file position close: ${e.message}`);
  }
}

// ─── Richer Ingest: concept article updates ──────────────────────
function _updateConceptArticles(perf, outcome, pnl, name, strategy, reason, vol, rangeEff, held) {
  const kbDir = getKbDir();
  const now = new Date().toISOString().slice(0, 16);
  const line = `- ${now} ${name}: ${outcome} ${pnl.toFixed(1)}%, held ${held}min, vol=${vol}, range_eff=${rangeEff}%`;

  // 1. Strategy pattern article (e.g. lessons/bid-ask-patterns.md)
  const stratSlug = (strategy || "unknown").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const stratPath = `lessons/${stratSlug}-patterns.md`;
  const stratFull = path.join(kbDir, stratPath);
  if (fs.existsSync(stratFull)) {
    let content = fs.readFileSync(stratFull, "utf8");
    const marker = "## Recent Results";
    if (content.includes(marker)) {
      const idx = content.indexOf(marker);
      const after = content.indexOf("\n", idx) + 1;
      content = content.slice(0, after) + "\n" + line + "\n" + content.slice(after);
    } else {
      content += `\n\n${marker}\n\n${line}\n`;
    }
    // Add cross-reference to pool article
    const poolRef = `pools/${name.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}.md`;
    if (!content.includes(poolRef)) {
      content += `\n\nSee also: [${name}](../${poolRef})\n`;
    }
    writeArticle(stratPath, content);
  } else {
    let content = `# Strategy: ${strategy}\n\nPerformance patterns for the **${strategy}** strategy.\n\n## Recent Results\n\n${line}\n`;
    writeArticle(stratPath, content);
  }

  // 2. OOR pattern article if close was OOR
  const oorMatch = reason?.match(/OOR (upside|downside)/i);
  if (oorMatch) {
    const oorDir = oorMatch[1].toLowerCase();
    const oorPath = `lessons/oor-${oorDir}-patterns.md`;
    const oorFull = path.join(kbDir, oorPath);
    if (fs.existsSync(oorFull)) {
      let content = fs.readFileSync(oorFull, "utf8");
      const marker = "## Recent Cases";
      if (content.includes(marker)) {
        const idx = content.indexOf(marker);
        const after = content.indexOf("\n", idx) + 1;
        content = content.slice(0, after) + "\n" + line + "\n" + content.slice(after);
      } else {
        content += `\n\n${marker}\n\n${line}\n`;
      }
      writeArticle(oorPath, content);
    } else {
      let content = `# OOR ${oorDir.charAt(0).toUpperCase() + oorDir.slice(1)} Patterns\n\n`;
      content += `Positions that went out-of-range ${oorDir}.\n\n## Recent Cases\n\n${line}\n`;
      writeArticle(oorPath, content);
    }
  }

  // 3. Bin step performance article
  const binStep = perf.bin_step;
  if (binStep) {
    const bsPath = `lessons/bin-step-${binStep}-performance.md`;
    const bsFull = path.join(kbDir, bsPath);
    if (fs.existsSync(bsFull)) {
      let content = fs.readFileSync(bsFull, "utf8");
      const marker = "## Recent Results";
      if (content.includes(marker)) {
        const idx = content.indexOf(marker);
        const after = content.indexOf("\n", idx) + 1;
        content = content.slice(0, after) + "\n" + line + "\n" + content.slice(after);
      } else {
        content += `\n\n${marker}\n\n${line}\n`;
      }
      writeArticle(bsPath, content);
    } else {
      let content = `# Bin Step ${binStep} Performance\n\nResults for pools with bin_step=${binStep}.\n\n## Recent Results\n\n${line}\n`;
      writeArticle(bsPath, content);
    }
  }
}

// ─── Log: chronological record of KB changes ────────────────────
function _appendLog(entry) {
  const kbDir = getKbDir();
  const logPath = path.join(kbDir, "LOG.md");
  const now = new Date().toISOString().slice(0, 19);
  const logLine = `- ${now} ${entry}\n`;

  if (fs.existsSync(logPath)) {
    // Append to top (after header)
    let content = fs.readFileSync(logPath, "utf8");
    const headerEnd = content.indexOf("\n\n");
    if (headerEnd >= 0) {
      content = content.slice(0, headerEnd + 2) + logLine + content.slice(headerEnd + 2);
    } else {
      content += "\n" + logLine;
    }
    // Keep max 200 entries
    const lines = content.split("\n");
    const entryLines = lines.filter(l => l.startsWith("- "));
    if (entryLines.length > 200) {
      const keep = new Set(entryLines.slice(0, 200));
      const filtered = lines.filter(l => !l.startsWith("- ") || keep.has(l));
      content = filtered.join("\n");
    }
    fs.writeFileSync(logPath, content);
  } else {
    ensureDir(kbDir);
    fs.writeFileSync(logPath, `# Knowledge Base Log\n\nChronological record of KB changes.\n\n${logLine}`);
  }
}

// ─── Lint: periodic KB health check ──────────────────────────────
export function lintKnowledgeBase() {
  if (!config.knowledgeBase?.enabled) return null;
  const kbDir = getKbDir();
  if (!fs.existsSync(kbDir)) return null;

  const issues = [];
  const allArticles = listArticles();

  // 1. Find orphan articles (no cross-references from any other article)
  const referenced = new Set();
  for (const a of allArticles) {
    try {
      const content = fs.readFileSync(path.join(kbDir, a.path), "utf8");
      const links = content.match(/\[.*?\]\((.*?\.md)\)/g) || [];
      for (const link of links) {
        const match = link.match(/\((.*?\.md)\)/);
        if (match) referenced.add(match[1].replace(/^\.\.\//, ""));
      }
    } catch { /* skip */ }
  }
  const orphans = allArticles.filter(a =>
    !referenced.has(a.path) &&
    !a.path.includes("INDEX") &&
    !a.path.includes("CONCEPTS") &&
    !a.path.includes("LOG")
  );
  if (orphans.length > 10) {
    issues.push(`${orphans.length} orphan articles (no incoming links)`);
  }

  // 2. Find stale articles (not updated in 7+ days)
  const staleThreshold = Date.now() - 7 * 86400_000;
  const stale = allArticles.filter(a => {
    try {
      return fs.statSync(path.join(kbDir, a.path)).mtimeMs < staleThreshold;
    } catch { return false; }
  });
  if (stale.length > 0) {
    issues.push(`${stale.length} stale articles (not updated in 7+ days)`);
  }

  // 3. Find empty articles (< 50 chars of content)
  const empty = allArticles.filter(a => {
    try {
      const content = fs.readFileSync(path.join(kbDir, a.path), "utf8");
      return content.replace(/^#.*\n+/g, "").trim().length < 50;
    } catch { return false; }
  });
  if (empty.length > 0) {
    issues.push(`${empty.length} near-empty articles`);
  }

  // 4. Check for duplicate pool articles (same pool, different slugs)
  const poolArticles = allArticles.filter(a => a.path.startsWith("pools/"));
  const poolNames = new Map();
  for (const a of poolArticles) {
    try {
      const content = fs.readFileSync(path.join(kbDir, a.path), "utf8");
      const nameMatch = content.match(/^# Pool: (.+)/m);
      if (nameMatch) {
        const n = nameMatch[1].trim().toLowerCase();
        if (poolNames.has(n)) {
          issues.push(`Duplicate pool articles for "${nameMatch[1]}": ${poolNames.get(n)} and ${a.path}`);
        }
        poolNames.set(n, a.path);
      }
    } catch { /* skip */ }
  }

  _appendLog(`LINT: ${issues.length} issues found`);

  return {
    total_articles: allArticles.length,
    issues,
    orphan_count: orphans.length,
    stale_count: stale.length,
    empty_count: empty.length,
  };
}

/**
 * Direct KB write after screening deploys — no LLM needed.
 * Called from the screening cycle to record deploy decisions.
 */
export function fileScreeningResult(report) {
  if (!config.knowledgeBase?.enabled || !config.knowledgeBase?.autoFile) return;
  if (!report) return;

  try {
    // Extract deploy info from screening report text
    const deployMatch = report.match(/deploy.*?(\w+-SOL)/i);
    if (!deployMatch) return; // No deploy happened

    const now = new Date();
    const weekNum = getWeekNumber(now);
    const articlePath = `performance/weekly-screening-${now.getFullYear()}-w${weekNum}.md`;
    const kbDir = getKbDir();
    const fullPath = path.join(kbDir, articlePath);

    const entry = `- ${now.toISOString().slice(0, 16)}: ${deployMatch[0].slice(0, 200)}`;

    if (fs.existsSync(fullPath)) {
      let content = fs.readFileSync(fullPath, "utf8");
      content = content.trimEnd() + "\n" + entry + "\n";
      writeArticle(articlePath, content);
    } else {
      const content = `# Screening Log: ${now.getFullYear()} Week ${weekNum}\n\n*Auto-maintained log of screening deploys.*\n\n${entry}\n`;
      writeArticle(articlePath, content);
    }
  } catch (e) {
    log("kb", `Failed to file screening result: ${e.message}`);
  }
}

function getWeekNumber(d) {
  const start = new Date(d.getFullYear(), 0, 1);
  const diff = d - start + (start.getTimezoneOffset() - d.getTimezoneOffset()) * 60000;
  return Math.ceil((diff / 86400000 + start.getDay() + 1) / 7);
}

// ─── Helpers ───────────────────────────────────────────────────

function extractTitle(content) {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

function extractSummary(content) {
  // First non-empty, non-heading line
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("*Migrated")) {
      return trimmed.slice(0, 120);
    }
  }
  return "";
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
