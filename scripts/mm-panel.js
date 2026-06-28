#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// Market Maker Control Panel — standalone server.
//
// A self-contained Express server + single static page to configure per-pool
// market makers, start/stop them, and watch live status. Deliberately
// INDEPENDENT of the agent dashboard: it does NOT import server.js or anything
// under web/, runs on its own port, and works with the dashboard fully stopped.
//
// Usage:
//   npm run mm:panel                    # live (DRY_RUN off)
//   DRY_RUN=true npm run mm:panel       # simulated, no on-chain sends
//
// Env: MM_PANEL_PORT (default config.marketMaker.panelPort=3838),
//      MM_PANEL_HOST (default 127.0.0.1), MM_PANEL_TOKEN (optional; if set,
//      mutating routes require header x-mm-token to match).
// ═══════════════════════════════════════════════════════════════

import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "../config.js";
import { log } from "../logger.js";
import { loadMarketMakerConfig } from "../tools/market-maker.js";
import { listPoolConfigs, upsertPoolConfig, removePoolConfig } from "../market-maker-config.js";
import { poolSupportsLimitOrder } from "../tools/dlmm.js";
import { startMm, stopMm, stopAllMm, getMmStatus } from "../market-maker-runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = path.join(__dirname, "..", "mm-panel");

const PORT = Number(process.env.MM_PANEL_PORT || config.marketMaker?.panelPort || 3838);
const HOST = process.env.MM_PANEL_HOST || config.marketMaker?.panelHost || "127.0.0.1";
const TOKEN = process.env.MM_PANEL_TOKEN || "";

const app = express();
app.use(express.json());

// Token gate for mutating routes (no-op if MM_PANEL_TOKEN is unset).
function requireToken(req, res, next) {
  if (!TOKEN) return next();
  if (req.get("x-mm-token") === TOKEN) return next();
  return res.status(401).json({ error: "Unauthorized: missing/invalid x-mm-token" });
}

// ── Read routes ──
app.get("/api/configs", (_req, res) => {
  res.json({ defaults: config.marketMaker, pools: listPoolConfigs(), authRequired: Boolean(TOKEN) });
});

app.get("/api/status", (_req, res) => {
  res.json(getMmStatus());
});

// ── Mutating routes ──
app.post("/api/configs/:pool", requireToken, (req, res) => {
  const pool = req.params.pool;
  try {
    // Validate the merged result before persisting (throws on bad values).
    loadMarketMakerConfig(req.body || {}, { poolAddress: pool });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const result = upsertPoolConfig(pool, req.body || {});
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.delete("/api/configs/:pool", requireToken, (req, res) => {
  const result = removePoolConfig(req.params.pool);
  if (result.error) return res.status(404).json(result);
  res.json(result);
});

app.post("/api/run/:pool", requireToken, async (req, res) => {
  const pool = req.params.pool;
  // Guard: refuse pools that don't support limit orders, with a clear message.
  try {
    const support = await poolSupportsLimitOrder({ pool_address: pool });
    if (!support.supported) {
      return res.status(400).json({ error: `Pool does not support DLMM limit orders${support.error ? ` (${support.error})` : ""}.` });
    }
  } catch (e) {
    return res.status(400).json({ error: `Could not verify pool: ${e.message}` });
  }
  const result = startMm(pool, (req.body && req.body.overrides) || {});
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post("/api/stop/:pool", requireToken, (req, res) => {
  const result = stopMm(req.params.pool);
  if (result.error) return res.status(404).json(result);
  res.json(result);
});

// ── Static page ──
app.use(express.static(PANEL_DIR));
app.get("/", (_req, res) => res.sendFile(path.join(PANEL_DIR, "index.html")));

const server = app.listen(PORT, HOST, () => {
  const dry = process.env.DRY_RUN === "true";
  log("mm_panel", `Control panel on http://${HOST}:${PORT}${dry ? " [DRY_RUN]" : " [LIVE]"}${TOKEN ? " (token required)" : ""}`);
});

function shutdown(sig) {
  log("mm_panel", `${sig} — stopping all market makers and closing panel…`);
  stopAllMm();
  // Give running loops a moment to abort/cancel their orders before exit.
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
