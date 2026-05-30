import fs from "fs";
import { log } from "./logger.js";
import { getPerformanceSummary } from "./lessons.js";
import { config } from "./config.js";
import { getLpOverview } from "./tools/lp-overview.js";

const STATE_FILE = "./state.json";
const LESSONS_FILE = "./lessons.json";

export async function generateBriefing() {
  const state = loadJson(STATE_FILE) || { positions: {}, recentEvents: [] };
  const lessonsData = loadJson(LESSONS_FILE) || { lessons: [], performance: [] };

  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // 1. Positions Activity
  const allPositions = Object.values(state.positions || {});
  const openedLast24h = allPositions.filter(p => new Date(p.deployed_at) > last24h);
  const closedLast24h = allPositions.filter(p => p.closed && new Date(p.closed_at) > last24h);

  // 2. Performance — prefer LP Agent overview, fall back to local data
  const lpOverview = await getLpOverview().catch(() => null);
  const perfSummary = getPerformanceSummary();
  const unit = config.management.pnlUnit || "sol";
  const useSol = unit === "sol";

  let pnlLine, feesLine, winRateLine, allTimeLine;

  if (lpOverview) {
    // Use LP Agent real data
    const pnlLabel = useSol
      ? `${lpOverview.total_pnl_sol} SOL`
      : `$${lpOverview.total_pnl_usd}`;
    const feesLabel = useSol
      ? `${lpOverview.total_fees_sol} SOL`
      : `$${lpOverview.total_fees_usd}`;

    pnlLine = `Total PnL: ${pnlLabel}`;
    feesLine = `Fees Earned: ${feesLabel}`;
    winRateLine = `Win Rate: ${lpOverview.win_rate_pct}%`;
    allTimeLine = [
      `Closed: ${lpOverview.closed_positions}`,
      `Avg Hold: ${lpOverview.avg_hold_hours}h`,
      `ROI: ${lpOverview.roi_pct}%`,
    ].join(" | ");
  } else if (perfSummary) {
    // Fallback to local performance data
    pnlLine = `Total PnL: $${perfSummary.total_pnl_usd}`;
    feesLine = null;
    winRateLine = `Win Rate: ${perfSummary.win_rate_pct}%`;
    allTimeLine = `Closed: ${perfSummary.total_positions_closed} | Avg PnL: ${perfSummary.avg_pnl_pct}%`;
  } else {
    pnlLine = "Total PnL: N/A";
    feesLine = null;
    winRateLine = "Win Rate: N/A";
    allTimeLine = null;
  }

  // 3. Lessons Learned — only those created in the last 24h (honest "Last 24h"),
  //    then cap at the 5 most recent. Lessons missing a parseable created_at are
  //    excluded so stale entries can't masquerade as recent.
  const allLessons = lessonsData.lessons || [];
  const recentLessons = allLessons
    .filter(l => {
      const ts = l.created_at ? new Date(l.created_at) : null;
      return ts && !isNaN(ts.getTime()) && ts > last24h;
    })
    .slice(-5);

  // 4. Current State
  const openPositions = allPositions.filter(p => !p.closed);

  // 5. Format Message (HTML for Telegram)
  const lines = [
    `<b>Morning Briefing (Last 24h)</b>`,
    "",
    `<b>Activity</b>`,
    `  Positions Opened: ${openedLast24h.length}`,
    `  Positions Closed: ${closedLast24h.length}`,
    "",
    `<b>Performance</b>`,
    `  ${pnlLine}`,
    feesLine ? `  ${feesLine}` : null,
    `  ${winRateLine}`,
    allTimeLine ? `  ${allTimeLine}` : null,
    "",
    `<b>Lessons Learned</b>`,
    recentLessons.length > 0
      ? recentLessons.map(l => `  - ${l.rule}`).join("\n")
      : "  - No new lessons recorded.",
    "",
    `<b>Current Portfolio</b>`,
    `  Open Positions: ${openPositions.length}`,
    lpOverview
      ? `  Open LP Positions: ${lpOverview.open_positions}`
      : null,
  ];

  return lines.filter(l => l !== null).join("\n");
}

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    log("briefing_error", `Failed to read ${file}: ${err.message}`);
    return null;
  }
}
