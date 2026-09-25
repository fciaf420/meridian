// tools/knowledge-graph.js — Aggregates agent data into a knowledge graph for visualization

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getMyPositions } from "./dlmm.js";
import { getWalletBalances } from "./wallet.js";
import { log } from "../logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE = path.join(__dirname, "..");

// ─── Color helpers ─────────────────────────────────────────────

function winRateColor(rate) {
  if (rate < 0.4) return "#ef4444"; // red
  if (rate < 0.7) return "#f59e0b"; // amber
  return "#22c55e"; // green
}

function pnlColor(pnl) {
  if (pnl < -5) return "#ef4444";
  if (pnl < 0) return "#f87171";
  if (pnl < 5) return "#86efac";
  return "#22c55e";
}

// ─── Safe JSON reader ──────────────────────────────────────────

function readJSON(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ─── Main builder ──────────────────────────────────────────────

export async function buildKnowledgeGraph() {
  const nodes = [];
  const edges = [];

  // ── 1. Read static data files ────────────────────────────────

  const stateData = readJSON(path.join(BASE, "state.json"));
  const poolMemory = readJSON(path.join(BASE, "pool-memory.json"));
  const lessonsData = readJSON(path.join(BASE, "lessons.json"));
  const userConfig = readJSON(path.join(BASE, "user-config.json"));

  const strategiesNugget = readJSON(path.join(BASE, "data", "nuggets", "strategies.nugget.json"));
  const patternsNugget = readJSON(path.join(BASE, "data", "nuggets", "patterns.nugget.json"));
  const lessonsNugget = readJSON(path.join(BASE, "data", "nuggets", "lessons.nugget.json"));
  const poolsNugget = readJSON(path.join(BASE, "data", "nuggets", "pools.nugget.json"));

  // ── 2. Fetch live data in parallel ───────────────────────────

  const [livePositionsResult, walletResult] = await Promise.allSettled([
    getMyPositions(),
    getWalletBalances(),
  ]);

  const livePositions =
    livePositionsResult.status === "fulfilled" ? livePositionsResult.value : null;
  const walletData =
    walletResult.status === "fulfilled" ? walletResult.value : null;

  if (livePositionsResult.status === "rejected") {
    log("knowledge-graph-warn", `Failed to fetch live positions: ${livePositionsResult.reason}`);
  }
  if (walletResult.status === "rejected") {
    log("knowledge-graph-warn", `Failed to fetch wallet balances: ${walletResult.reason}`);
  }

  // ── 3. Build lookup maps ─────────────────────────────────────

  const positions = stateData?.positions || {};
  const pools = poolMemory || {};

  // Collect all known pool names for text matching
  const poolNameMap = {}; // lowercased name → pool key
  for (const [poolKey, poolData] of Object.entries(pools)) {
    if (poolData.name) {
      poolNameMap[poolData.name.toLowerCase()] = poolKey;
    }
  }

  // Also collect pool names from state positions
  for (const pos of Object.values(positions)) {
    if (pos.pool_name && pos.pool) {
      const lc = pos.pool_name.toLowerCase();
      if (!poolNameMap[lc]) poolNameMap[lc] = pos.pool;
    }
  }

  // Build a map of live position addresses for quick lookup
  const livePositionMap = new Map();
  if (livePositions?.positions) {
    for (const lp of livePositions.positions) {
      livePositionMap.set(lp.position, lp);
    }
  }

  // ── 4. Wallet node ───────────────────────────────────────────

  nodes.push({
    id: "wallet",
    type: "wallet",
    label: walletData ? `Wallet (${walletData.sol?.toFixed(2) ?? "?"} SOL)` : "Wallet",
    size: 16,
    color: "#f59e0b",
    data: walletData || {},
  });

  // ── 5. Pool nodes ────────────────────────────────────────────

  const poolNodeIds = new Set();

  for (const [poolKey, poolData] of Object.entries(pools)) {
    const deploys = poolData.total_deploys || 0;
    const wr = poolData.win_rate ?? 0;
    const size = Math.max(7, Math.min(deploys * 2 + 5, 18));

    nodes.push({
      id: poolKey,
      type: "pool",
      label: poolData.name || poolKey.slice(0, 8),
      size,
      color: winRateColor(wr),
      data: {
        total_deploys: deploys,
        avg_pnl_pct: poolData.avg_pnl_pct,
        win_rate: wr,
        last_outcome: poolData.last_outcome,
        last_deployed_at: poolData.last_deployed_at,
        notes: poolData.notes,
      },
    });
    poolNodeIds.add(poolKey);
  }

  // Ensure pool nodes exist for positions whose pool isn't in pool-memory
  for (const pos of Object.values(positions)) {
    if (pos.pool && !poolNodeIds.has(pos.pool)) {
      nodes.push({
        id: pos.pool,
        type: "pool",
        label: pos.pool_name || pos.pool.slice(0, 8),
        size: 8,
        color: "#f59e0b",
        data: {},
      });
      poolNodeIds.add(pos.pool);
    }
  }

  // ── 6. Position nodes (cap: all open + 30 recent closed) ────

  const allPositions = Object.values(positions);
  const openPositions = allPositions.filter((p) => !p.closed);
  const closedPositions = allPositions
    .filter((p) => p.closed)
    .sort((a, b) => new Date(b.closed_at || 0) - new Date(a.closed_at || 0))
    .slice(0, 30);

  const selectedPositions = [...openPositions, ...closedPositions];
  const walletPoolEdges = new Set();

  for (const pos of selectedPositions) {
    const pnl = pos.pnl_pct ?? 0;
    const isLive = !pos.closed || livePositionMap.has(pos.position);
    const size = Math.max(6, Math.min((pos.amount_sol || 0) * 3 + 5, 14));

    // Merge live data if available
    const liveMatch = livePositionMap.get(pos.position);

    nodes.push({
      id: pos.position,
      type: "position",
      label: `${pos.pool_name || "Pos"} ${(pos.amount_sol || 0).toFixed(2)} SOL`,
      size: Math.min(size, 14),
      color: pnlColor(liveMatch?.pnl_pct ?? pnl),
      data: {
        live: isLive,
        pool: pos.pool,
        pool_name: pos.pool_name,
        strategy: pos.strategy,
        amount_sol: pos.amount_sol,
        pnl_pct: liveMatch?.pnl_pct ?? pnl,
        deployed_at: pos.deployed_at,
        closed: pos.closed,
        closed_at: pos.closed_at,
        peak_pnl_pct: pos.peak_pnl_pct,
        in_range: liveMatch?.in_range,
        pnl_usd: liveMatch?.pnl_usd,
        unclaimed_fees_sol: liveMatch?.unclaimed_fees_sol,
      },
    });

    // Edge: pool → position
    if (pos.pool && poolNodeIds.has(pos.pool)) {
      edges.push({
        source: pos.pool,
        target: pos.position,
        label: pos.strategy || undefined,
        style: isLive ? "solid" : "dashed",
      });
    }

    // Edge: wallet → pool (if live position)
    if (isLive && pos.pool && poolNodeIds.has(pos.pool) && !walletPoolEdges.has(pos.pool)) {
      walletPoolEdges.add(pos.pool);
      edges.push({
        source: "wallet",
        target: pos.pool,
        style: "solid",
      });
    }
  }

  // ── 7. Strategy nodes (from nuggets) ─────────────────────────

  const strategyFacts = strategiesNugget?.facts || [];
  const strategyNodeIds = new Set();

  for (const fact of strategyFacts) {
    const id = `strategy_${fact.key}`;
    const size = Math.max(5, Math.min((fact.hits || 1) * 2 + 3, 14));

    nodes.push({
      id,
      type: "strategy",
      label: fact.key,
      size,
      color: "#60a5fa",
      data: {
        key: fact.key,
        value: fact.value,
        hits: fact.hits,
        last_hit_session: fact.last_hit_session,
      },
    });
    strategyNodeIds.add(fact.key);
  }

  // Edge: position → strategy (match position strategy to strategy node)
  for (const pos of selectedPositions) {
    if (pos.strategy && strategyNodeIds.has(pos.strategy)) {
      edges.push({
        source: pos.position,
        target: `strategy_${pos.strategy}`,
        style: "thin",
      });
    }
  }

  // Edge: strategy → pool (from pool-memory deploys)
  for (const [poolKey, poolData] of Object.entries(pools)) {
    const deploys = poolData.deploys || [];
    const strategiesUsed = new Set(deploys.map((d) => d.strategy).filter(Boolean));
    for (const strat of strategiesUsed) {
      if (strategyNodeIds.has(strat)) {
        edges.push({
          source: `strategy_${strat}`,
          target: poolKey,
          style: "thin",
        });
      }
    }
  }

  // ── 8. Lesson nodes (cap 50 most recent) ────────────────────

  const allLessons = lessonsData?.lessons || [];
  const recentLessons = allLessons
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    .slice(0, 50);

  for (const lesson of recentLessons) {
    const id = `lesson_${lesson.id}`;
    const tags = lesson.tags || [];
    const size = Math.min(tags.length * 2 + 4, 14);
    const outcome = (lesson.outcome || "").toLowerCase();
    const isPositive = outcome.includes("good") || outcome.includes("profit") || outcome.includes("win");
    const isNegative = outcome.includes("poor") || outcome.includes("loss");
    const color = isPositive ? "#22c55e" : isNegative ? "#ef4444" : "#94a3b8";

    nodes.push({
      id,
      type: "lesson",
      label: (lesson.rule || "").slice(0, 60),
      size,
      color,
      data: {
        rule: lesson.rule,
        tags,
        outcome: lesson.outcome,
        created_at: lesson.created_at,
      },
    });

    // Edge: lesson → pool (scan rule text for pool names)
    const ruleLC = (lesson.rule || "").toLowerCase();
    for (const [poolNameLC, poolKey] of Object.entries(poolNameMap)) {
      if (ruleLC.includes(poolNameLC) && poolNodeIds.has(poolKey)) {
        edges.push({
          source: id,
          target: poolKey,
          style: "dashed",
        });
      }
    }
  }

  // ── 9. Pattern nodes (from nuggets) ──────────────────────────

  const patternFacts = patternsNugget?.facts || [];
  const PATTERN_COLORS = ["#a78bfa", "#818cf8", "#c084fc", "#e879f9", "#f472b6"];

  for (let i = 0; i < patternFacts.length; i++) {
    const fact = patternFacts[i];
    const id = `pattern_${fact.key}`;
    const size = Math.max(5, Math.min((fact.hits || 1) * 2 + 3, 14));
    const color = PATTERN_COLORS[i % PATTERN_COLORS.length];

    nodes.push({
      id,
      type: "pattern",
      label: fact.key,
      size,
      color,
      data: {
        key: fact.key,
        value: fact.value,
        hits: fact.hits,
        last_hit_session: fact.last_hit_session,
      },
    });

    // Edge: pattern → pool (scan value text for pool names)
    const valLC = (fact.value || "").toLowerCase();
    for (const [poolNameLC, poolKey] of Object.entries(poolNameMap)) {
      if (valLC.includes(poolNameLC) && poolNodeIds.has(poolKey)) {
        edges.push({
          source: id,
          target: poolKey,
          style: "dashed",
        });
      }
    }
  }

  // ── 10. Compute insights ─────────────────────────────────────

  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;

  // Per-pool insights — attach to each pool node's data
  for (const node of nodes) {
    if (node.type !== "pool") continue;

    const poolKey = node.id;
    const poolData = pools[poolKey];
    const deploys = poolData?.deploys || [];
    const insights = [];

    if (deploys.length >= 3) {
      // 1. Loss streak warning
      let lossStreak = 0;
      for (let i = deploys.length - 1; i >= 0; i--) {
        if ((deploys[i].pnl_pct ?? 0) < 0) lossStreak++;
        else break;
      }
      if (lossStreak >= 3) {
        insights.push({
          type: "warning",
          text: `Loss streak: last ${lossStreak} deploys all negative. Consider avoiding.`,
        });
      }

      // 2. Win streak opportunity
      let winStreak = 0;
      for (let i = deploys.length - 1; i >= 0; i--) {
        if ((deploys[i].pnl_pct ?? 0) >= 0) winStreak++;
        else break;
      }
      if (winStreak >= 3) {
        const totalWins = deploys.filter((d) => (d.pnl_pct ?? 0) >= 0).length;
        const winRate = ((totalWins / deploys.length) * 100).toFixed(0);
        insights.push({
          type: "opportunity",
          text: `Hot streak: last ${winStreak} wins in a row. Win rate: ${winRate}%.`,
        });
      }

      // 4. Declining performance — first half vs second half avg PnL
      const mid = Math.floor(deploys.length / 2);
      const firstHalf = deploys.slice(0, mid);
      const secondHalf = deploys.slice(mid);
      const avgPnl = (arr) =>
        arr.length ? arr.reduce((s, d) => s + (d.pnl_pct ?? 0), 0) / arr.length : 0;
      const firstAvg = avgPnl(firstHalf);
      const secondAvg = avgPnl(secondHalf);
      if (firstAvg - secondAvg > 3) {
        insights.push({
          type: "warning",
          text: `Declining returns: recent avg PnL ${secondAvg.toFixed(1)}% vs earlier ${firstAvg.toFixed(1)}%.`,
        });
      }

      // 5. Strategy effectiveness — compare strategies within this pool
      const stratBuckets = {};
      for (const d of deploys) {
        const s = d.strategy || "unknown";
        if (!stratBuckets[s]) stratBuckets[s] = { wins: 0, total: 0 };
        stratBuckets[s].total++;
        if ((d.pnl_pct ?? 0) >= 0) stratBuckets[s].wins++;
      }
      const stratNames = Object.keys(stratBuckets);
      if (stratNames.length >= 2) {
        const parts = stratNames.map((s) => {
          const b = stratBuckets[s];
          return `${s}: ${((b.wins / b.total) * 100).toFixed(0)}% win rate`;
        });
        insights.push({ type: "info", text: parts.join(" vs ") + " in this pool." });
      }
    }

    // 3. Lesson contradiction — AVOID lesson + recent deploy
    const poolName = poolData?.name || node.label || "";
    const poolNameLC = poolName.toLowerCase();
    if (poolNameLC) {
      for (const lesson of recentLessons) {
        const ruleText = lesson.rule || "";
        const ruleLC = ruleText.toLowerCase();
        if (ruleLC.includes("avoid") && ruleLC.includes(poolNameLC)) {
          // Check if pool has a deploy in the last 24h
          const lastDeployTime = poolData?.last_deployed_at
            ? new Date(poolData.last_deployed_at).getTime()
            : 0;
          if (now - lastDeployTime < ONE_DAY) {
            insights.push({
              type: "warning",
              text: `Deployed despite lesson: ${ruleText.slice(0, 100)}`,
            });
          }
        }
      }
    }

    // 6. High fee capture — any deploy with pnl_pct > 5%
    if (deploys.length > 0) {
      let bestPnl = -Infinity;
      let bestDate = "";
      for (const d of deploys) {
        if ((d.pnl_pct ?? 0) > bestPnl) {
          bestPnl = d.pnl_pct ?? 0;
          bestDate = d.deployed_at || d.closed_at || "";
        }
      }
      if (bestPnl > 5) {
        insights.push({
          type: "opportunity",
          text: `Has produced >5% PnL. Best: ${bestPnl.toFixed(1)}% on ${bestDate ? new Date(bestDate).toLocaleDateString() : "unknown date"}.`,
        });
      }
    }

    node.data.insights = insights;
  }

  // Global insights
  const globalInsights = [];

  const poolNodes = nodes.filter((n) => n.type === "pool" && pools[n.id]);

  // 1. Pools performing well vs struggling
  const wellPools = poolNodes.filter((n) => (pools[n.id]?.win_rate ?? 0) > 0.7).length;
  const strugglingPools = poolNodes.filter((n) => (pools[n.id]?.win_rate ?? 0) < 0.3 && (pools[n.id]?.total_deploys ?? 0) > 0).length;
  if (wellPools > 0 || strugglingPools > 0) {
    globalInsights.push({
      type: "info",
      text: `${wellPools} pool${wellPools !== 1 ? "s" : ""} performing well, ${strugglingPools} struggling.`,
    });
  }

  // 2. Most deployed pool
  let mostDeployedPool = null;
  let mostDeploys = 0;
  for (const n of poolNodes) {
    const d = pools[n.id]?.total_deploys ?? 0;
    if (d > mostDeploys) {
      mostDeploys = d;
      mostDeployedPool = n;
    }
  }
  if (mostDeployedPool) {
    globalInsights.push({
      type: "info",
      text: `Most active: ${mostDeployedPool.label} with ${mostDeploys} deploys.`,
    });
  }

  // 3. Best performing pool
  let bestPool = null;
  let bestAvgPnl = -Infinity;
  for (const n of poolNodes) {
    const avg = pools[n.id]?.avg_pnl_pct ?? -Infinity;
    if (avg > bestAvgPnl && (pools[n.id]?.total_deploys ?? 0) > 0) {
      bestAvgPnl = avg;
      bestPool = n;
    }
  }
  if (bestPool && bestAvgPnl > -Infinity) {
    globalInsights.push({
      type: "opportunity",
      text: `Top performer: ${bestPool.label} at ${bestAvgPnl.toFixed(1)}% avg PnL.`,
    });
  }

  // 4. Strategy with highest overall win rate
  const globalStratStats = {};
  for (const poolData of Object.values(pools)) {
    for (const d of poolData.deploys || []) {
      const s = d.strategy || "unknown";
      if (!globalStratStats[s]) globalStratStats[s] = { wins: 0, total: 0 };
      globalStratStats[s].total++;
      if ((d.pnl_pct ?? 0) >= 0) globalStratStats[s].wins++;
    }
  }
  let bestStrat = null;
  let bestStratWR = -1;
  for (const [name, stats] of Object.entries(globalStratStats)) {
    if (stats.total >= 3) {
      const wr = stats.wins / stats.total;
      if (wr > bestStratWR) {
        bestStratWR = wr;
        bestStrat = name;
      }
    }
  }
  if (bestStrat) {
    globalInsights.push({
      type: "info",
      text: `${bestStrat} has highest win rate at ${(bestStratWR * 100).toFixed(0)}%.`,
    });
  }

  // ── 11. Build meta ───────────────────────────────────────────

  const nodeCounts = {};
  for (const node of nodes) {
    nodeCounts[node.type] = (nodeCounts[node.type] || 0) + 1;
  }

  const meta = {
    generated_at: new Date().toISOString(),
    node_counts: nodeCounts,
    total_positions: allPositions.length,
    total_pools: Object.keys(pools).length,
  };

  log("knowledge-graph", `Built graph: ${nodes.length} nodes, ${edges.length} edges, ${globalInsights.length} global insights`);

  return { nodes, links: edges, meta, insights: globalInsights };
}
