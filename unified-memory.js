import { getLessonRecordsForPrompt } from "./lessons.js";
import { getMemoryFactsForPrompt } from "./memory.js";
import { getKbArticlesForPrompt } from "./knowledge-base.js";
import { config } from "./config.js";

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[`*_[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function trimSentence(value, maxLen = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > maxLen ? `${text.slice(0, maxLen - 3).trim()}...` : text;
}

function formatLessonLine(lesson, label) {
  const outcome = String(lesson.outcome || "note").toUpperCase();
  const priority = label ? `${label} | ` : "";
  return `- [${priority}${outcome}] ${trimSentence(lesson.rule, 240)}`;
}

function formatFactLine(fact) {
  return `- [${fact.nugget} | hits=${fact.hits}] ${fact.key}: ${trimSentence(fact.value, 180)}`;
}

function formatKbLine(article) {
  const updated = article.updated ? article.updated.slice(0, 10) : "unknown";
  return `- [${article.category} | ${updated}] ${article.title}: ${trimSentence(article.summary, 180)}`;
}

export function buildUnifiedMemoryBrief(agentType = "GENERAL") {
  const lessonRecords = getLessonRecordsForPrompt({ agentType, maxLessons: 20 });
  const facts = getMemoryFactsForPrompt(agentType, 12);
  const kbArticles = getKbArticlesForPrompt(agentType, 4);

  const dedupe = new Set();
  const addUnique = (items, formatter, seed = "") => {
    const lines = [];
    for (const item of items) {
      const raw = normalizeText(seed ? `${seed} ${item?.rule || item?.value || item?.summary || ""}` : item?.rule || item?.value || item?.summary || "");
      if (!raw || dedupe.has(raw)) continue;
      dedupe.add(raw);
      lines.push(formatter(item));
    }
    return lines;
  };

  const pinnedLessons = addUnique(lessonRecords.pinned, (lesson) => formatLessonLine(lesson, "PINNED"), "lesson");
  const roleLessons = addUnique(lessonRecords.roleMatched.slice(0, facts.length > 0 && config.memory.nuggetsFirst ? 6 : 10), (lesson) => formatLessonLine(lesson, agentType), "lesson");
  const recentLessons = facts.length === 0
    ? addUnique(lessonRecords.recent.slice(0, 4), (lesson) => formatLessonLine(lesson, "RECENT"), "lesson")
    : [];
  const factLines = addUnique(facts, formatFactLine, "fact");
  const kbLines = addUnique(kbArticles, formatKbLine, "kb");

  const sections = [
    "Use this memory in order of precedence: 1) pinned/rule lessons, 2) recalled facts, 3) KB synthesis, 4) recent lessons. If sources conflict, prefer the higher-precedence source and the more specific pool/strategy evidence.",
  ];

  if (pinnedLessons.length || roleLessons.length || recentLessons.length) {
    sections.push([
      "ACTIONABLE RULES",
      ...pinnedLessons,
      ...roleLessons,
      ...recentLessons,
    ].join("\n"));
  }

  if (factLines.length) {
    sections.push([
      "RECALLED FACTS",
      ...factLines,
    ].join("\n"));
  }

  if (kbLines.length) {
    sections.push([
      "SYNTHESIZED KB CONTEXT",
      ...kbLines,
    ].join("\n"));
  }

  return sections.join("\n\n");
}
