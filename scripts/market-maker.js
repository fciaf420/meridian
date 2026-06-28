#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// Market Maker CLI — standalone runner for a single DLMM pool.
//
// Usage:
//   npm run mm     -- --pool <POOL> [flags]
//   npm run mm:dry -- --pool <POOL> [flags]     (DRY_RUN, no on-chain sends)
//
// Flags (override config.marketMaker):
//   --pool <addr>             limit-order-enabled DLMM pool (or env MM_POOL)
//   --mode <m>                two_sided | bid_only | ask_only
//   --levels <n>              orders (bins) per side
//   --spread-bins <n>         bins from active to the nearest quote
//   --step-bins <n>           bins between successive levels
//   --order-size-quote <ui>   quote (Y) per bid order (else 25% of balance)
//   --order-size-base <ui>    base (X) per ask order  (else 25% of balance)
//   --max-inventory-base <ui> pause bids once base held >= this
//   --max-inventory-quote <ui>pause asks once quote held >= this
//   --drift-bins <n>          requote when active drifts > n from ladder center
//   --requote-fill-pct <p>    requote a side once it's >= p% filled
//   --volatility-pause-bins <n> pull quotes if active jumps > n bins in a tick
//   --tick <sec>              loop interval
//   --min-requote-sec <sec>   anti-thrash throttle per side
//   --dry                     force DRY_RUN
// ═══════════════════════════════════════════════════════════════

import "dotenv/config";
import { loadMarketMakerConfig, runMarketMaker } from "../tools/market-maker.js";
import { log } from "../logger.js";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true; // boolean flag
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function toOverrides(args) {
  const o = {};
  if (args.mode) o.mode = args.mode;
  if (args.levels != null) o.levels = Number(args.levels);
  if (args["spread-bins"] != null) o.spreadBins = Number(args["spread-bins"]);
  if (args["step-bins"] != null) o.stepBins = Number(args["step-bins"]);
  if (args["order-size-quote"] != null) o.orderSizeQuote = Number(args["order-size-quote"]);
  if (args["order-size-base"] != null) o.orderSizeBase = Number(args["order-size-base"]);
  if (args["max-inventory-base"] != null) o.maxInventoryBase = Number(args["max-inventory-base"]);
  if (args["max-inventory-quote"] != null) o.maxInventoryQuote = Number(args["max-inventory-quote"]);
  if (args["drift-bins"] != null) o.driftBins = Number(args["drift-bins"]);
  if (args["requote-fill-pct"] != null) o.requoteFillPct = Number(args["requote-fill-pct"]);
  if (args["volatility-pause-bins"] != null) o.volatilityPauseBins = Number(args["volatility-pause-bins"]);
  if (args.tick != null) o.tickIntervalSec = Number(args.tick);
  if (args["min-requote-sec"] != null) o.minRequoteIntervalSec = Number(args["min-requote-sec"]);
  if (args["max-active-bin-slippage"] != null) o.maxActiveBinSlippage = Number(args["max-active-bin-slippage"]);
  return o;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    console.log("See header of scripts/market-maker.js for usage and flags.");
    process.exit(0);
  }
  if (args.dry) process.env.DRY_RUN = "true";

  const poolAddress = (args.pool || process.env.MM_POOL || "").toString().trim();
  if (!poolAddress) {
    console.error("Error: --pool <address> is required (or set MM_POOL). Must be a limit-order-enabled DLMM pool.");
    process.exit(1);
  }

  let mm;
  try {
    mm = loadMarketMakerConfig(toOverrides(args));
    mm.__resolved = true;
  } catch (e) {
    console.error(`Config error: ${e.message}`);
    process.exit(1);
  }

  const controller = new AbortController();
  let shuttingDown = false;
  const onSignal = (sig) => {
    if (shuttingDown) return; // second Ctrl-C: let the default handler force-exit
    shuttingDown = true;
    log("mm", `Received ${sig} — shutting down, cancelling open orders…`);
    controller.abort();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  try {
    const result = await runMarketMaker({ poolAddress, config: mm, signal: controller.signal });
    log("mm", `Done. ${JSON.stringify(result)}`);
    process.exit(0);
  } catch (e) {
    log("mm_error", e.message);
    console.error(e.stack || e.message);
    process.exit(1);
  }
}

main();
