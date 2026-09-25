/**
 * Knowledge Base tool implementations for the agent.
 * Thin wrappers around knowledge-base.js exports.
 */

import {
  listArticles,
  readArticle,
  writeArticle,
  deleteArticle,
  searchArticles,
  rebuildIndex,
  rebuildConcepts,
  migrateFromJson,
  getKbStats,
} from "../knowledge-base.js";

// ─── READ tools ────────────────────────────────────────────────

/**
 * Read INDEX.md or a specific article from the knowledge base.
 */
export function kbRead({ path: articlePath }) {
  if (!articlePath || articlePath === "INDEX.md" || articlePath === "index") {
    return readArticle("INDEX.md");
  }
  if (articlePath === "CONCEPTS.md" || articlePath === "concepts") {
    return readArticle("CONCEPTS.md");
  }
  return readArticle(articlePath);
}

/**
 * List all articles, optionally filtered by category.
 */
export function kbList({ category, limit } = {}) {
  const articles = listArticles(category || null);
  const capped = articles.slice(0, limit || 50);
  return {
    articles: capped,
    total: articles.length,
    showing: capped.length,
  };
}

/**
 * Full-text search across all KB articles.
 */
export function kbSearch({ query }) {
  if (!query) return { error: "query is required" };
  return searchArticles(query);
}

/**
 * Get KB statistics.
 */
export function kbGetStats() {
  return getKbStats();
}

// ─── WRITE tools ───────────────────────────────────────────────

/**
 * Write or update a markdown article in the knowledge base.
 */
export function kbWrite({ path: articlePath, content }) {
  if (!articlePath) return { error: "path is required (e.g. 'pools/bonk-sol.md')" };
  if (!content) return { error: "content is required" };

  // Ensure .md extension
  if (!articlePath.endsWith(".md")) articlePath += ".md";

  return writeArticle(articlePath, content);
}

/**
 * Delete an article from the knowledge base.
 */
export function kbDelete({ path: articlePath }) {
  if (!articlePath) return { error: "path is required" };
  return deleteArticle(articlePath);
}

/**
 * One-time migration from existing JSON data to KB articles.
 */
export async function kbMigrate() {
  return migrateFromJson();
}

/**
 * Rebuild INDEX.md and CONCEPTS.md from scratch.
 */
export function kbRebuildIndexes() {
  const indexResult = rebuildIndex();
  const conceptsResult = rebuildConcepts();
  return {
    success: true,
    articles_indexed: indexResult.articles,
    concepts_found: conceptsResult.concepts,
  };
}
