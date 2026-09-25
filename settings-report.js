// settings-report.js — single builder for the "what am I running?" report.
// Used by settings.js (CLI, colored) and the Telegram /settings command (plain).
//
// The 3 config files and their ONE job each:
//   .env              → SECRETS ONLY (keys, wallet, RPC). Never tuning knobs.
//   user-config.json  → ALL bot behavior (strategy, risk, schedule, models, screening, learning).
//   gmgn-config.json  → ONLY the GMGN screening filters. Only when screeningSource = "gmgn" or "both".

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, f), "utf8")); }
  catch { return {}; }
};
const exists = (f) => fs.existsSync(path.join(__dirname, f));

/**
 * Build the settings report.
 * @param {object} opts
 * @param {boolean} opts.color  emit ANSI color (CLI). false = plain text (Telegram).
 * @returns {string}
 */
export function buildSettingsReport({ color = false } = {}) {
  const u    = read("user-config.json");
  const gmgn = read("gmgn-config.json");

  // Parse RAW .env (not process.env — config.js copies user-config values into
  // process.env at load, which would cause false conflict reports).
  const rawEnv = (() => {
    try {
      const out = {};
      for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
        if (m) out[m[1]] = true;
      }
      return out;
    } catch { return {}; }
  })();

  const wrap = (code) => (s) => color ? `\x1b[${code}m${s}\x1b[0m` : String(s);
  const C = {
    dim: wrap(2), bold: wrap(1), green: wrap(32),
    yellow: wrap(33), red: wrap(31), cyan: wrap(36),
  };

  const L = [];
  const h = (t) => L.push("", C.bold(C.cyan(t)));
  const row = (label, value, src) =>
    L.push(`  ${String(label).padEnd(22)} ${String(value).padEnd(24)} ${src ? C.dim(src) : ""}`.trimEnd());

  const dryRun = process.env.DRY_RUN === "true" || u.dryRun === true;
  const srcSource = config.screening.source;
  const gmgnActive = srcSource === "gmgn" || srcSource === "both";
  const meteoraActive = srcSource !== "gmgn";
  const usdc = config.usdc.enabled;

  // ── header ──
  L.push(C.bold("═══ MERIDIAN — effective settings ═══"));
  L.push(
    "  " +
      (dryRun ? C.green("○ DRY RUN — no on-chain txns") : C.red(C.bold("● LIVE — real funds"))) +
      "   " + C.bold(`screening: ${srcSource}`) +
      "   " + C.bold(`capital: ${usdc ? "USDC" : "SOL"}`)
  );

  // ── config-file map ──
  h("Config files");
  row(".env", exists(".env") ? "present" : C.red("MISSING"), "secrets only");
  row("user-config.json", exists("user-config.json") ? "present" : C.red("MISSING"), "all bot behavior — edit here");
  row("gmgn-config.json",
    exists("gmgn-config.json") ? "present" : C.yellow("missing"),
    gmgnActive ? C.green("ACTIVE — GMGN filters in use") : C.dim("ignored (screeningSource is meteora)"));

  // ── conflict detector (raw .env vs user-config) ──
  const envWins = [
    ["DRY_RUN", "dryRun"], ["USDC_MODE", "usdcMode"],
    ["LLM_PROVIDER", "llmProvider"], ["LLM_MODEL", "llmModel"],
    ["RPC_URL", "rpcUrl"], ["WALLET_PRIVATE_KEY", "walletKey"],
  ];
  const conflicts = [];
  for (const [envKey, ucKey] of envWins) {
    if (rawEnv[envKey] && u[ucKey] !== undefined) {
      conflicts.push(`${envKey} (.env) overrides ${ucKey} (user-config.json) → using .env`);
    }
  }
  for (const k of Object.keys(gmgn)) {
    const legacy = "gmgn" + k.charAt(0).toUpperCase() + k.slice(1);
    if (u[legacy] !== undefined) {
      conflicts.push(`${k} in BOTH gmgn-config.json and user-config.json (${legacy}) → using gmgn-config.json`);
    }
  }
  const keyPlaces = [
    gmgn.apiKey && "gmgn-config.json",
    u.gmgnApiKey && "user-config.json",
    rawEnv.GMGN_API_KEY && ".env",
  ].filter(Boolean);
  if (keyPlaces.length > 1) conflicts.push(`GMGN key set in ${keyPlaces.length} places (${keyPlaces.join(", ")}) → gmgn-config > user-config > .env`);

  if (conflicts.length) {
    h("⚠  Overlaps (resolved automatically — listed so you know which wins)");
    conflicts.forEach((c) => L.push("  " + C.yellow(c)));
  } else {
    h("Overlaps");
    L.push("  " + C.green("none — each setting lives in exactly one place ✓"));
  }

  // ── capital & risk ──
  h("Capital & risk  " + C.dim("(user-config.json)"));
  if (usdc) {
    row("deploy per position", `$${config.usdc.deployAmountUsd}`, "deployAmountUsd");
    row("max per position", `$${config.usdc.maxDeployUsd}`, "maxDeployUsd");
    row("min USDC to open", `$${config.usdc.minUsdcToOpen}`, "minUsdcToOpen");
    row("gas reserve (SOL)", `${config.usdc.gasReserveSol} SOL`, "gasReserveSol — protected");
    if (u.gasReserve != null && u.gasReserveSol == null && u.gasReserve !== config.usdc.gasReserveSol) {
      row("", C.yellow(`gasReserve=${u.gasReserve} is ignored in USDC mode — set gasReserveSol`), "");
    }
  } else {
    row("deploy per position", `${config.management.deployAmountSol} SOL`, "deployAmountSol");
    row("min SOL to open", `${config.management.minSolToOpen} SOL`, "minSolToOpen");
    row("gas reserve (SOL)", `${config.management.gasReserve} SOL`, "gasReserve — protected");
  }
  row("max positions", config.risk.maxPositions, "maxPositions");
  row("position size %", `${(config.management.positionSizePct * 100).toFixed(0)}%`, "positionSizePct");

  // ── strategy ──
  h("Strategy  " + C.dim("(user-config.json)"));
  row("active strategy", config.strategy.activeStrategy, "activeStrategy");
  row("shape", config.strategy.strategy, "strategy");
  if (config.strategy.activeStrategy === "evil_panda") {
    row("evil panda range %", `${config.strategy.evilPanda.priceRangePct}%`, "evilPandaPriceRangePct");
    row("evil panda min mcap", `$${config.strategy.evilPanda.minMcap.toLocaleString()}`, "evilPandaMinMcap");
    row("evil panda min vol24h", `$${config.strategy.evilPanda.minTokenVolume24h.toLocaleString()}`, "evilPandaMinTokenVolume24h");
  }

  // ── exits ──
  h("Exits  " + C.dim("(user-config.json)"));
  row("take profit", `${config.management.takeProfitFeePct}% fees`, "takeProfitFeePct");
  row("stop loss", `${config.management.stopLossPct}%`, "stopLossPct");
  row("trailing TP", config.management.trailingTakeProfit ? `on (trig ${config.management.trailingTriggerPct}% / drop ${config.management.trailingDropPct}%)` : "off", "trailing*");
  row("out-of-range wait", `${config.management.outOfRangeWaitMinutes} min`, "outOfRangeWaitMinutes");

  // ── entry-safety filters ──
  const ef = config.entryFilters || {};
  const onOff = (v) => (v ? C.green("block") : C.yellow("allow"));
  h("Entry filters  " + C.dim("(user-config.json · Telegram ⚙️ → 🛡 Entry filters · the agent may only tighten)"));
  row("transfer fee above", ef.blockTransferFeeAbovePct == null ? C.yellow("off") : `${ef.blockTransferFeeAbovePct}% → block`, "blockTransferFeeAbovePct");
  row("transfer hook", onOff(ef.blockTransferHook), "blockTransferHook");
  row("permanent delegate", onOff(ef.blockPermanentDelegate), "blockPermanentDelegate");
  row("freeze authority", onOff(ef.blockFreezeAuthority), "blockFreezeAuthority (+ default frozen)");
  row("mint authority", onOff(ef.blockMintAuthority), "blockMintAuthority");
  row("pausable", onOff(ef.blockPausable), "blockPausable");
  row("non-transferable", onOff(ef.blockNonTransferable), "blockNonTransferable");
  row("SOL-fee pools only", ef.solFeePoolsOnly ? C.green("on") : "off", "solFeePoolsOnly (CollectFeeMode OnlyY)");
  row("TWAP spike (bid_ask)", ef.twapSpikeMaxPct == null ? C.yellow("off") : `> +${ef.twapSpikeMaxPct}% vs ${ef.twapWindowMinutes}-min TWAP → block`, "twapSpikeMaxPct / twapWindowMinutes");

  // ── screening (active source(s) only) ──
  if (srcSource === "both") {
    h("Screening — BOTH  " + C.dim("(Meteora + GMGN in parallel)"));
    L.push("  " + C.dim("Meteora filters apply to Meteora discovery. GMGN filters apply to the GMGN pipeline."));
    L.push("  " + C.dim("GMGN-only pools must also pass bin step, TVL range and max volatility below;"));
    L.push("  " + C.dim("one pool per token; pools found by both sources rank first."));
  }
  if (gmgnActive) {
    h("Screening — GMGN  " + C.dim("(gmgn-config.json)"));
    row("min mcap", `$${Number(config.gmgn.minMcap).toLocaleString()}`, "minMcap");
    row("max mcap", `$${Number(config.gmgn.maxMcap).toLocaleString()}`, "maxMcap");
    row("token age", `${config.gmgn.minTokenAgeHours}–${config.gmgn.maxTokenAgeHours} h`, "min/maxTokenAgeHours");
    row("min holders", config.gmgn.minHolders, "minHolders");
    row("min volume", `$${Number(config.gmgn.minVolume).toLocaleString()}`, "minVolume");
    row("require KOL", config.gmgn.requireKol, "requireKol");
    row("max sniper count", config.gmgn.maxSniperCount, "maxSniperCount");
    row("indicator filter", config.gmgn.indicatorFilter ? "on (Evil Panda gates)" : "off", "indicatorFilter");
  }
  if (meteoraActive) {
    h("Screening — Meteora  " + C.dim("(user-config.json)"));
    row("fee/active-TVL ratio", `≥ ${config.screening.minFeeActiveTvlRatio}`, "minFeeActiveTvlRatio");
    row("TVL range", `$${config.screening.minTvl.toLocaleString()}–$${config.screening.maxTvl.toLocaleString()}`, "min/maxTvl");
    row("mcap range", `$${config.screening.minMcap.toLocaleString()}–$${config.screening.maxMcap.toLocaleString()}`, "min/maxMcap");
    row("min holders", config.screening.minHolders, "minHolders");
    row("timeframe", config.screening.timeframe, "timeframe");
    if (srcSource === "both") {
      row("bin step range", `${config.screening.minBinStep}–${config.screening.maxBinStep}`, "min/maxBinStep — also GMGN picks");
      row("max volatility", config.screening.maxVolatility, "maxVolatility — also GMGN picks");
    }
  }

  // ── LLM ──
  h("LLM  " + C.dim("(user-config.json)"));
  row("provider", u.llmProvider ?? process.env.LLM_PROVIDER ?? "(default)", "llmProvider");
  row("screening model", config.llm.screeningModel, "screeningModel");
  row("management model", config.llm.managementModel, "managementModel");
  row("general model", config.llm.generalModel, "generalModel");
  row("reasoning effort", config.llm.reasoningEffort ?? "per role (manager high, others medium)", "llmReasoningEffort");

  // ── schedule ──
  h("Schedule  " + C.dim("(user-config.json)"));
  row("management", `every ${config.schedule.managementIntervalMin} min`, "managementIntervalMin");
  row("screening", `every ${config.schedule.screeningIntervalMin} min`, "screeningIntervalMin");
  row("pnl watcher", `every ${config.schedule.pnlWatcherIntervalSec} s`, "pnlWatcherIntervalSec");

  // ── learning (with live gating) ──
  const closes = (read("lessons.json").performance || []).length;
  const ar = read("autoresearch.json");
  const arKept = Object.keys(ar.kept_overrides || {}).length;
  const arQuarantined = Object.keys(ar.quarantined_overrides || {}).length;
  h("Learning  " + C.dim("(user-config.json) — closed trades so far: " + closes));
  const darwinReady = closes >= (config.darwin.minSamples ?? 10);
  row("darwinian weights", config.darwin.enabled ? "on" : "off",
    config.darwin.enabled
      ? (darwinReady ? C.green("active — adjusting") : C.yellow(`dormant — needs ${config.darwin.minSamples} closes (have ${closes})`))
      : "");
  // Kept overrides are only restored into the prompt while autoresearch is enabled.
  const arNotes = [
    arKept ? `${arKept} kept override${arKept > 1 ? "s" : ""}${config.autoresearch.enabled ? " applied" : " (inactive while off)"}` : "",
    arQuarantined ? `${arQuarantined} quarantined` : "",
    ar.active ? `experiment running (A/B, ${config.autoresearch.minClosesPerArm} closes/arm)` : "",
    ar.pending_proposal ? C.yellow("proposal awaiting /autoresearch approve|reject") : "",
  ].filter(Boolean).join(", ");
  row("autoresearch", config.autoresearch.enabled ? "on" : "off",
    (config.autoresearch.enabled ? C.green("active") : "") + (arNotes ? C.dim((config.autoresearch.enabled ? " — " : "") + arNotes) : ""));

  // ── secrets (masked) ──
  h("Secrets in .env  " + C.dim("(presence only — values never printed)"));
  const need = [
    ["WALLET_PRIVATE_KEY", true], ["RPC_URL", true],
    ["GMGN_API_KEY", gmgnActive], ["DEEPSEEK_API_KEY", u.llmProvider === "deepseek"],
    ["TELEGRAM_BOT_TOKEN", false], ["JUPITER_API_KEY", false], ["HELIUS_API_KEY", false],
    ["LPAGENT_API_KEY", false], ["DASHBOARD_TOKEN", false],
  ];
  for (const [k, required] of need) {
    const set = !!rawEnv[k] || !!process.env[k];
    const mark = set ? C.green("✓ set") : (required ? C.red("✗ MISSING (required)") : C.dim("– not set"));
    row(k, mark, "");
  }

  // ── footer ──
  L.push("", C.dim("─".repeat(60)));
  L.push(C.dim("  Where to change things:"));
  L.push(C.dim("    secret/key        → .env"));
  L.push(C.dim("    any tuning knob   → user-config.json  (restart, or agent update_config)"));
  L.push(C.dim(`    GMGN filters      → gmgn-config.json  ${gmgnActive ? "(active)" : "(only when screeningSource=gmgn or both)"}`));

  return L.join("\n");
}
