/**
 * Interactive setup wizard.
 * Runs before the agent starts. MERGES settings into user-config.json
 * (never overwrites the whole file — keys it doesn't ask about are preserved).
 * Run: npm run setup
 */

import "dotenv/config";
import readline from "readline";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getEffectiveMinSolToOpen } from "./runtime-helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "user-config.json");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question, defaultVal) {
  return new Promise((resolve) => {
    const hint = defaultVal !== undefined ? ` (default: ${defaultVal})` : "";
    rl.question(`${question}${hint}: `, (ans) => {
      const trimmed = ans.trim();
      resolve(trimmed === "" ? defaultVal : trimmed);
    });
  });
}

function askNum(question, defaultVal, { min, max } = {}) {
  return new Promise(async (resolve) => {
    while (true) {
      const raw = await ask(question, defaultVal);
      const n = parseFloat(raw);
      if (isNaN(n))                        { console.log(`  ⚠ Please enter a number.`); continue; }
      if (min !== undefined && n < min)    { console.log(`  ⚠ Minimum is ${min}.`);     continue; }
      if (max !== undefined && n > max)    { console.log(`  ⚠ Maximum is ${max}.`);     continue; }
      resolve(n);
      break;
    }
  });
}

async function askBool(question, defaultVal) {
  const raw = await ask(`${question} (true/false)`, String(defaultVal));
  return raw === true || String(raw).toLowerCase() === "true";
}

function askChoice(question, choices) {
  return new Promise(async (resolve) => {
    const labels = choices.map((c, i) => `  ${i + 1}. ${c.label}`).join("\n");
    while (true) {
      console.log(`\n${question}`);
      console.log(labels);
      const raw = await ask("Enter number", "");
      const idx = parseInt(raw) - 1;
      if (idx >= 0 && idx < choices.length) { resolve(choices[idx]); break; }
      console.log("  ⚠ Invalid choice.");
    }
  });
}

// ─── Presets (Meteora screening + cadence/exits) ────────────────────────────────
const PRESETS = {
  degen: {
    label:                 "🔥 Degen",
    timeframe:             "30m",
    maxVolatility:         12.0,
    maxPriceChangePct:     1000,
    minOrganic:            60,
    minHolders:            200,
    maxMcap:               5_000_000,
    takeProfitFeePct:      10,
    outOfRangeWaitMinutes: 15,
    managementIntervalMin: 5,
    screeningIntervalMin:  15,
    description: "30m timeframe, pumping tokens allowed, fast cycles. High risk/reward.",
  },
  moderate: {
    label:                 "⚖️  Moderate",
    timeframe:             "4h",
    maxVolatility:         8.0,
    maxPriceChangePct:     300,
    minOrganic:            65,
    minHolders:            500,
    maxMcap:               10_000_000,
    takeProfitFeePct:      5,
    outOfRangeWaitMinutes: 30,
    managementIntervalMin: 10,
    screeningIntervalMin:  30,
    description: "4h timeframe, balanced risk/reward. Recommended for most users.",
  },
  safe: {
    label:                 "🛡️  Safe",
    timeframe:             "24h",
    maxVolatility:         2.5,
    maxPriceChangePct:     80,
    minOrganic:            75,
    minHolders:            1000,
    maxMcap:               10_000_000,
    takeProfitFeePct:      3,
    outOfRangeWaitMinutes: 60,
    managementIntervalMin: 15,
    screeningIntervalMin:  60,
    description: "24h timeframe, stable pools only, avoids pumps. Lower yield, lower risk.",
  },
};

// Load existing config — we MERGE onto this, never replace it.
const existing = fs.existsSync(CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
  : {};

const DEFAULT_MODELS_BY_PROVIDER = {
  claude: "sonnet",
  codex: "gpt-4o",
  deepseek: "deepseek-v4-pro",
  minimax: "MiniMax-M2.7",
  openrouter: "openai/gpt-5.4-nano",
};

const e = (key, fallback) => existing[key] ?? fallback;

console.log(`
╔═══════════════════════════════════════════╗
║       DLMM LP Agent — Setup Wizard        ║
╚═══════════════════════════════════════════╝

  Settings are MERGED into user-config.json — anything not asked here
  (learning, knowledge base, GMGN filters, etc.) is left untouched.
  Secrets (keys/wallet/RPC) belong in .env, not here.
`);

// ─── Preset selection ─────────────────────────────────────────────────────────
const presetChoice = await askChoice("Select a risk preset:", [
  { label: `Degen    — ${PRESETS.degen.description}`,    key: "degen"    },
  { label: `Moderate — ${PRESETS.moderate.description}`, key: "moderate" },
  { label: `Safe     — ${PRESETS.safe.description}`,     key: "safe"     },
  { label: "Custom   — Configure every setting manually", key: "custom"  },
]);

let preset = presetChoice.key === "custom" ? null : PRESETS[presetChoice.key];

console.log(preset
  ? `\n✓ Using ${preset.label} preset. You can still override individual values below.\n`
  : `\nCustom mode — configure everything manually.\n`
);

const p = (key, fallback) => preset?.[key] ?? e(key, fallback);

// ─── Wallet & RPC (secrets stay in .env) ────────────────────────────────────────
console.log("── Wallet & RPC ──────────────────────────────");

const rpcUrl = await ask(
  "RPC URL",
  e("rpcUrl", process.env.RPC_URL || "https://api.mainnet-beta.solana.com")
);

if (process.env.WALLET_PRIVATE_KEY) {
  console.log("  Wallet: *** already set in .env (leaving it there — secrets belong in .env)");
} else {
  console.log("  ⚠ WALLET_PRIVATE_KEY is NOT set in .env. Add it to .env before running the bot.");
}

// ─── Deployment ───────────────────────────────────────────────────────────────
console.log("\n── Deployment ────────────────────────────────");

const deployAmountSol = await askNum(
  "SOL to deploy per position",
  e("deployAmountSol", 0.1),
  { min: 0.01, max: 50 }
);

const maxPositions = await askNum(
  "Max concurrent positions",
  e("maxPositions", 3),
  { min: 1, max: 10 }
);

const gasReserve = await askNum(
  "SOL gas reserve to always keep (hard floor)",
  e("gasReserve", 0.2),
  { min: 0.01 }
);

const minSolToOpen = await askNum(
  "Min SOL balance to open a new position",
  e("minSolToOpen", getEffectiveMinSolToOpen({ deployAmountSol, gasReserve })),
  { min: 0.05 }
);

const maxDeployAmount = await askNum(
  "Max SOL per single position (safety cap)",
  e("maxDeployAmount", 50),
  { min: deployAmountSol }
);

// ─── USDC Mode ──────────────────────────────────────────────────────────────────
console.log("\n── USDC Mode ─────────────────────────────────");
console.log("  Hold capital in USDC: auto-swap USDC→SOL on entry, settle back to USDC on exit.");

const usdcMode = await askBool("Enable USDC mode?", e("usdcMode", false));

let deployAmountUsd, maxDeployUsd, minUsdcToOpen, gasReserveSol;
if (usdcMode) {
  deployAmountUsd = await askNum("USD to deploy per position", e("deployAmountUsd", 50), { min: 1 });
  maxDeployUsd = await askNum("Max USD per single position (safety cap)", e("maxDeployUsd", Math.max(500, deployAmountUsd)), { min: deployAmountUsd });
  minUsdcToOpen = await askNum("Min USDC balance to open a new position", e("minUsdcToOpen", deployAmountUsd), { min: 0 });
  gasReserveSol = await askNum("Native SOL gas reserve to keep", e("gasReserveSol", 0.2), { min: 0.01 });
}

// ─── Screening source ───────────────────────────────────────────────────────────
console.log("\n── Screening Source ──────────────────────────");
const sourceChoice = await askChoice("Where do pool candidates come from?", [
  { label: `GMGN     — advanced token screening (filters live in gmgn-config.json)${e("screeningSource") === "gmgn" ? " (current)" : ""}`, key: "gmgn" },
  { label: `Meteora  — Meteora pool API + thresholds below${e("screeningSource", "meteora") === "meteora" ? " (current)" : ""}`, key: "meteora" },
]);
const screeningSource = sourceChoice.key;

// Meteora-specific filters only matter when source = meteora.
let timeframe, maxVolatility, maxPriceChangePct, minOrganic, minHolders, maxMcap;
if (screeningSource === "meteora") {
  console.log("\n── Meteora Filters ───────────────────────────");
  timeframe         = await ask("Pool discovery timeframe (30m / 1h / 4h / 12h / 24h)", p("timeframe", "4h"));
  maxVolatility     = await askNum("Max pool volatility", p("maxVolatility", 8.0), { min: 0.5, max: 20 });
  maxPriceChangePct = await askNum("Max price change % allowed (300 = allow 3x pumps)", p("maxPriceChangePct", 300), { min: 10 });
  minOrganic        = await askNum("Min organic score (0-100)", p("minOrganic", 65), { min: 0, max: 100 });
  minHolders        = await askNum("Min token holders", p("minHolders", 500), { min: 1 });
  maxMcap           = await askNum("Max token market cap USD", p("maxMcap", 10_000_000), { min: 100_000 });
} else {
  console.log("\n  ✓ GMGN screening — edit token filters (mcap, holders, KOL, snipers, indicators)");
  console.log("    in gmgn-config.json. Copy gmgn-config.example.json if it doesn't exist yet.");
}

// ─── Strategy ─────────────────────────────────────────────────────────────────
console.log("\n── Strategy ──────────────────────────────────");
const stratChoice = await askChoice("Active strategy:", [
  { label: `Evil Panda — single-sided SOL spot, indicator-gated${e("activeStrategy", "evil_panda") === "evil_panda" ? " (current)" : ""}`, key: "evil_panda" },
  { label: `Classic    — use the configured shape below${e("activeStrategy") && e("activeStrategy") !== "evil_panda" ? " (current)" : ""}`, key: "classic" },
]);

let activeStrategy, strategyShape, evilPandaPriceRangePct, evilPandaMinMcap, evilPandaMinTokenVolume24h;
if (stratChoice.key === "evil_panda") {
  activeStrategy = "evil_panda";
  strategyShape  = "spot"; // Evil Panda is always spot
  evilPandaPriceRangePct     = await askNum("Evil Panda price range %", e("evilPandaPriceRangePct", 75), { min: 5, max: 100 });
  evilPandaMinMcap           = await askNum("Evil Panda min market cap USD", e("evilPandaMinMcap", 200_000), { min: 0 });
  evilPandaMinTokenVolume24h = await askNum("Evil Panda min 24h volume USD", e("evilPandaMinTokenVolume24h", 750_000), { min: 0 });
} else {
  activeStrategy = e("activeStrategy", "classic") === "evil_panda" ? "classic" : e("activeStrategy", "classic");
  const shapeChoice = await askChoice("Position shape:", [
    { label: "Spot",    key: "spot" },
    { label: "Bid/Ask", key: "bid_ask" },
  ]);
  strategyShape = shapeChoice.key;
}

// ─── Exit Rules ─────────────────────────────────────────────────────────────────
console.log("\n── Exit Rules ────────────────────────────────");

const takeProfitFeePct = await askNum("Take profit when fees earned >= X% of deployed capital", p("takeProfitFeePct", 7), { min: 0.1, max: 100 });
const stopLossPct      = await askNum("Stop loss % (negative, e.g. -5)", e("stopLossPct", -5), { max: 0 });
const trailingTakeProfit = await askBool("Trailing take profit?", e("trailingTakeProfit", true));
let trailingTriggerPct, trailingDropPct;
if (trailingTakeProfit) {
  trailingTriggerPct = await askNum("  Trailing trigger % (arm trailing once PnL ≥ this)", e("trailingTriggerPct", 5), { min: 0.1 });
  trailingDropPct    = await askNum("  Trailing drop % (close after this drop from peak)", e("trailingDropPct", 4), { min: 0.1 });
}
const outOfRangeWaitMinutes = await askNum("Minutes out-of-range before closing", p("outOfRangeWaitMinutes", 3), { min: 1 });

// ─── Scheduling ───────────────────────────────────────────────────────────────
console.log("\n── Scheduling ────────────────────────────────");

const managementIntervalMin = await askNum("Management cycle interval (minutes)", p("managementIntervalMin", 3), { min: 1 });
const screeningIntervalMin   = await askNum("Screening cycle interval (minutes)", p("screeningIntervalMin", 45), { min: 5 });

// ─── LLM ──────────────────────────────────────────────────────────────────────
console.log("\n── LLM ───────────────────────────────────────");

const defaultLlmProvider = e("llmProvider", process.env.LLM_PROVIDER || "deepseek");
const llmProviderChoice = await askChoice("LLM provider:", [
  { label: `DeepSeek${defaultLlmProvider === "deepseek" ? " (current)" : ""}`, key: "deepseek" },
  { label: `Claude OAuth${defaultLlmProvider === "claude" ? " (current)" : ""}`, key: "claude" },
  { label: `Codex OAuth${defaultLlmProvider === "codex" ? " (current)" : ""}`, key: "codex" },
  { label: `OpenRouter${defaultLlmProvider === "openrouter" ? " (current)" : ""}`, key: "openrouter" },
  { label: `MiniMax Token Plan${defaultLlmProvider === "minimax" ? " (current)" : ""}`, key: "minimax" },
]);
const llmProvider = llmProviderChoice.key || defaultLlmProvider;
const providerDefaultModel = DEFAULT_MODELS_BY_PROVIDER[llmProvider] || "gpt-4o";
const globalDefaultLlmModel = e("llmModel", process.env.LLM_MODEL || providerDefaultModel);
const managementModel  = await ask("Manager model ID", e("managementModel", globalDefaultLlmModel));
const screeningModel   = await ask("Screener model ID", e("screeningModel", globalDefaultLlmModel));
const generalModel     = await ask("General/chat model ID", e("generalModel", globalDefaultLlmModel));
const autoresearchModel = await ask("Autoresearch model ID", e("autoresearchModel", globalDefaultLlmModel));

const dryRun = await askBool("Dry run mode? (true = no real transactions)", e("dryRun", false));

rl.close();

// ─── Save (MERGE onto existing) ─────────────────────────────────────────────────
const changes = {
  preset: presetChoice.key,
  rpcUrl,
  deployAmountSol,
  maxPositions,
  gasReserve,
  minSolToOpen,
  maxDeployAmount,
  usdcMode,
  ...(usdcMode ? { deployAmountUsd, maxDeployUsd, minUsdcToOpen, gasReserveSol } : {}),
  screeningSource,
  ...(screeningSource === "meteora"
    ? { timeframe, maxVolatility, maxPriceChangePct, minOrganic, minHolders, maxMcap }
    : {}),
  activeStrategy,
  strategy: strategyShape,
  ...(activeStrategy === "evil_panda"
    ? { evilPandaPriceRangePct, evilPandaMinMcap, evilPandaMinTokenVolume24h }
    : {}),
  takeProfitFeePct,
  stopLossPct,
  trailingTakeProfit,
  ...(trailingTakeProfit ? { trailingTriggerPct, trailingDropPct } : {}),
  outOfRangeWaitMinutes,
  managementIntervalMin,
  screeningIntervalMin,
  llmProvider,
  llmModel: globalDefaultLlmModel,
  managementModel,
  screeningModel,
  generalModel,
  autoresearchModel,
  dryRun,
};

// MERGE: preserve every key the wizard didn't touch (learning, knowledgeBase, etc.)
const userConfig = { ...existing, ...changes };
fs.writeFileSync(CONFIG_PATH, JSON.stringify(userConfig, null, 2));

const presetName = preset ? preset.label : "Custom";
const preserved = Object.keys(existing).filter((k) => !(k in changes));

console.log(`
╔═══════════════════════════════════════════╗
║           Configuration Saved             ║
╚═══════════════════════════════════════════╝

Preset:        ${presetName}
Screening:     ${screeningSource}${screeningSource === "gmgn" ? "  (filters in gmgn-config.json)" : `  (timeframe ${timeframe})`}
Strategy:      ${activeStrategy} / ${strategyShape}${activeStrategy === "evil_panda" ? `  (range ${evilPandaPriceRangePct}%)` : ""}

  Deploy:      ${deployAmountSol} SOL/position  |  Max: ${maxPositions} positions
  Min balance: ${minSolToOpen} SOL to open  |  gas reserve ${gasReserve} SOL${usdcMode ? `
  USDC mode:   ON — $${deployAmountUsd}/position  |  max $${maxDeployUsd}  |  gas reserve ${gasReserveSol} SOL` : `
  USDC mode:   OFF`}
  Take profit: fees >= ${takeProfitFeePct}%
  Stop loss:   ${stopLossPct}%
  Trailing TP: ${trailingTakeProfit ? `on (trigger ${trailingTriggerPct}% / drop ${trailingDropPct}%)` : "off"}
  OOR close:   after ${outOfRangeWaitMinutes} min
  Mgmt:        every ${managementIntervalMin} min
  Screening:   every ${screeningIntervalMin} min
  Provider:    ${llmProvider}  (manager ${managementModel} / screener ${screeningModel})
  Dry run:     ${dryRun}

  Preserved untouched: ${preserved.length ? preserved.join(", ") : "(none)"}

Run "npm run settings" to review, then "npm start" to launch.
`);
