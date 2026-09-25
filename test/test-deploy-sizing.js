// Deploy sizing: positionSizePct × (portfolio total − gasReserve), clamped to
// maxDeployAmount, capped by free SOL − gasReserve, skipped below the floor.
// Pure math + injected wallet/positions: no RPC, no LLM, no transaction.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-sizing-"));
const USER_CFG = path.join(TMP, "user-config.json");
fs.writeFileSync(USER_CFG, "{}");
process.env.MERIDIAN_USER_CONFIG_PATH = USER_CFG;
process.env.MERIDIAN_GMGN_CONFIG_PATH = path.join(TMP, "gmgn-config.json");
process.env.DRY_RUN = "true";
process.chdir(TMP);
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const cfgMod = await import("../config.js");
const { config, computeDeploySizing, computeDeployAmount, resolveDeploySizing } = cfgMod;
const { computePortfolioSol, valueDlmmPositions } = await import("../portfolio-value.js");
const ui = await import("../telegram-ui.js");
const as = await import("../all-settings.js");

const PRICE = 200; // USD per SOL

function setSizing({ pct = 0.45, reserve = 0.1, floor = 0.5, ceil = 5, base = "total" } = {}) {
  config.management.positionSizePct = pct;
  config.management.gasReserve = reserve;
  config.management.deployAmountSol = floor;
  config.risk.maxDeployAmount = ceil;
  config.management.positionSizeBase = base;
}

/** An open position worth `sol` SOL (value excl. fees) with `feesSol` unclaimed. */
const pos = (sol, feesSol = 0, extra = {}) => ({
  position: `Pos${Math.random().toString(36).slice(2)}`,
  pair: "AAA-SOL",
  total_value_usd: sol * PRICE,
  total_value_sol: sol,
  unclaimed_fees_usd: feesSol * PRICE,
  unclaimed_fees_sol: feesSol,
  sol_price: PRICE,
  ...extra,
});
const wallet = (sol) => ({ wallet: "W", sol, sol_price: PRICE, sol_usd: sol * PRICE, usdc: 0, tokens: [] });
const portfolio = (freeSol, positions) => computePortfolioSol({ walletSol: freeSol, wallet: wallet(freeSol), positionsResult: { positions } });

test("portfolio total: free SOL + position value + unclaimed fees (once), converted to SOL", () => {
  const p = portfolio(1.5, [pos(0.8, 0.05), pos(0.25)]);
  assert.equal(p.ok, true);
  assert.equal(p.positionCount, 2);
  assert.ok(Math.abs(p.dlmmSol - 1.1) < 1e-9, `dlmmSol ${p.dlmmSol}`);
  assert.ok(Math.abs(p.totalSol - 2.6) < 1e-9, `totalSol ${p.totalSol}`);
  // USD value missing → total_value_sol × price, same number.
  const viaSol = portfolio(1.5, [pos(0.8, 0.05, { total_value_usd: null }), pos(0.25)]);
  assert.ok(Math.abs(viaSol.totalSol - 2.6) < 1e-9);
  // Same valuation the Wallet screen shows.
  const t = ui.computeWalletTotals(wallet(1.5), { positions: [pos(0.8, 0.05), pos(0.25)] });
  assert.ok(Math.abs(t.dlmmSol - p.dlmmSol) < 1e-9, "Wallet screen and sizing agree on the DLMM value");
  assert.ok(Math.abs(valueDlmmPositions([pos(1, 0.1)], PRICE).dlmmUsd - 220) < 1e-9);
  // No positions → total is the free SOL, no price needed.
  assert.deepEqual(
    { ok: true, totalSol: 2 },
    (({ ok, totalSol }) => ({ ok, totalSol }))(computePortfolioSol({ walletSol: 2, wallet: { sol: 2 }, positionsResult: { positions: [] } })),
  );
});

test("example: pct 0.45, reserve 0.1, total 2.6 → 1.13; capped by free SOL", () => {
  setSizing({ pct: 0.45, reserve: 0.1, floor: 0.5, ceil: 5 });
  const s = computeDeploySizing(2.0, portfolio(2.0, [pos(0.6)]));
  assert.equal(s.basis, "total");
  assert.equal(s.amount, 1.13);
  assert.equal(s.skip, false);
  assert.equal(s.label, "1.13 SOL = 45% of (2.60 SOL total − 0.1 reserve)");

  // Same total, but only 1.0 SOL free: capped at free − reserve − ~0.12 rent/fees = 0.77.
  const capped = computeDeploySizing(1.0, portfolio(1.0, [pos(1.6)]));
  assert.equal(capped.amount, 0.77);
  assert.match(capped.label, /^0\.77 SOL = free SOL 1\.00 − 0\.1 reserve − ~0\.12 rent\/fees \(cap; 45% of \(2\.60 SOL total − 0\.1 reserve\) = 1\.13\)$/);
});

test("total vs wallet basis", () => {
  setSizing({ pct: 0.45, reserve: 0.1, floor: 0.2, ceil: 5 });
  const p = portfolio(2.0, [pos(0.6)]);
  assert.equal(computeDeploySizing(2.0, p).amount, 1.13, "total: 0.45 × (2.6 − 0.1)");
  setSizing({ pct: 0.45, reserve: 0.1, floor: 0.2, ceil: 5, base: "wallet" });
  const w = computeDeploySizing(2.0, p);
  assert.equal(w.basis, "wallet");
  assert.equal(w.fallbackReason, null, "wallet basis by choice is not a fallback");
  assert.equal(w.amount, 0.86, "wallet: 0.45 × (2.0 − 0.1) = 0.855");
  assert.match(w.label, /of \(2\.00 SOL free wallet − 0\.1 reserve\)/);
  // Case-insensitive; anything else means total.
  config.management.positionSizeBase = "Wallet";
  assert.equal(computeDeploySizing(2.0, p).basis, "wallet");
  config.management.positionSizeBase = "bogus";
  assert.equal(computeDeploySizing(2.0, p).basis, "total");
});

test("maxDeployAmount clamps the size; the label says so", () => {
  setSizing({ pct: 0.5, reserve: 0.1, floor: 0.5, ceil: 1 });
  const s = computeDeploySizing(5, portfolio(5, [pos(3)]));
  assert.equal(s.amount, 1);
  assert.match(s.label, /^1\.00 SOL = max 1 \(50% of \(8\.00 SOL total − 0\.1 reserve\) = 3\.95\)$/);
});

test("free-SOL cap: never more than free SOL − gasReserve, even after rounding", () => {
  setSizing({ pct: 0.45, reserve: 0.1, floor: 0.1, ceil: 5 });
  // Big portfolio, little free SOL.
  const s = computeDeploySizing(0.6, portfolio(0.6, [pos(10)]));
  assert.equal(s.amount, 0.37); // 0.6 − 0.1 reserve − ~0.1215 rent/fees, rounded down
  // 0.45 × (2.6 − 0.1) = 1.125 rounds up to 1.13, but only 1.125 fits after reserve + ~0.1215
  // rent/fees: round DOWN to the cap.
  const edge = computeDeploySizing(1.3465, portfolio(1.3465, [pos(1.2535)]));
  assert.equal(edge.amount, 1.12);
  assert.ok(edge.amount <= 1.3465 - 0.1 - 0.1215);
  // Nothing free at all → skip, not a negative or forced amount.
  const none = computeDeploySizing(0.05, portfolio(0.05, [pos(5)]));
  assert.equal(none.amount, 0);
  assert.equal(none.skip, true);
});

test("below-floor skip: amount 0 with a clear reason; the floor is never forced", () => {
  setSizing({ pct: 0.25, reserve: 0.1, floor: 1.0, ceil: 5 });
  const s = computeDeploySizing(2.58, portfolio(2.58, []));
  assert.equal(s.amount, 0);
  assert.equal(s.skip, true);
  assert.match(s.reason, /^size 0\.62 below floor 1 \(25% of \(2\.58 SOL total − 0\.1 reserve\)\)$/);
  assert.equal(computeDeployAmount(2.58, portfolio(2.58, [])), 0);
  // Big enough total, but the free-SOL cap lands under the floor → skip too.
  const capped = computeDeploySizing(0.8, portfolio(0.8, [pos(10)]));
  assert.equal(capped.skip, true);
  assert.match(capped.reason, /^size 0\.57 below floor 1 \(free SOL 0\.80 − 0\.1 reserve − ~0\.12 rent\/fees \(cap;/);
  // A floor above the ceiling is treated as the ceiling (it can't block every deploy).
  setSizing({ pct: 0.5, reserve: 0.1, floor: 3, ceil: 1 });
  assert.equal(computeDeploySizing(5, portfolio(5, [])).amount, 1);
});

test("unknown value → conservative free-wallet fallback, never counted as 0", () => {
  setSizing({ pct: 0.45, reserve: 0.1, floor: 0.2, ceil: 5 });
  const cases = [
    ["value unknown", computePortfolioSol({ walletSol: 2, wallet: wallet(2), positionsResult: { positions: [pos(0.6), pos(0, 0, { total_value_usd: 0, total_value_sol: null })] } }), /1 position with unknown value/],
    ["value missing", computePortfolioSol({ walletSol: 2, wallet: wallet(2), positionsResult: { positions: [pos(0.6, 0, { total_value_usd: null, total_value_sol: null })] } }), /unknown value/],
    ["API failed", computePortfolioSol({ walletSol: 2, wallet: wallet(2), positionsResult: { positions: [], error: "LP Agent 500" } }), /positions unavailable \(LP Agent 500\)/],
    ["not loaded", computePortfolioSol({ walletSol: 2, wallet: wallet(2), positionsResult: null }), /positions not loaded/],
    ["no SOL price", computePortfolioSol({ walletSol: 2, wallet: { sol: 2, sol_price: 0 }, positionsResult: { positions: [pos(0.6, 0, { sol_price: 0 })] } }), /SOL price unknown/],
  ];
  for (const [name, p, re] of cases) {
    assert.equal(p.ok, false, name);
    assert.match(p.reason, re, name);
    const s = computeDeploySizing(2, p);
    assert.equal(s.basis, "wallet", name);
    assert.match(s.fallbackReason, re, name);
    assert.equal(s.amount, 0.86, `${name}: 0.45 × (2 − 0.1), the free-wallet size`);
    assert.match(s.label, /\[wallet basis: /, name);
  }
  // The sync helper without a portfolio also sizes from the free wallet.
  assert.equal(computeDeployAmount(2), 0.86);
});

test("an open position lowers the next deploy size proportionally to its value", () => {
  setSizing({ pct: 0.5, reserve: 0.1, floor: 0.1, ceil: 10 });
  // 3 SOL free, nothing open: 0.5 × 2.9 = 1.45.
  assert.equal(computeDeploySizing(3, portfolio(3, [])).amount, 1.45);
  // After deploying 1.45 the total is unchanged (1.55 free + 1.45 position), but free SOL must also
  // cover the next position's rent/fees: capped at 1.55 − 0.1 − ~0.1215 = 1.32.
  assert.equal(computeDeploySizing(1.55, portfolio(1.55, [pos(1.45)])).amount, 1.32);
  // The position loses half its value: total 2.275 → 0.5 × 2.175 = 1.0875 → 1.09.
  const down = computeDeploySizing(1.55, portfolio(1.55, [pos(0.725)]));
  assert.equal(down.amount, 1.09);
  // Every 1 SOL of position value moves the size by exactly pct.
  const a = computeDeploySizing(5, portfolio(5, [pos(1)])).amount;
  const b = computeDeploySizing(5, portfolio(5, [pos(2)])).amount;
  assert.ok(Math.abs((b - a) - 0.5) < 0.011, `${b} − ${a}`);
  // The wallet basis ignores the position entirely.
  config.management.positionSizeBase = "wallet";
  assert.equal(computeDeploySizing(1.55, portfolio(1.55, [pos(0.725)])).amount, 0.73);
});

test("user's current settings (pct 0.55, reserve 0.1, floor = max = 1.1): fixed 1.1 once total ≥ 2.1", () => {
  setSizing({ pct: 0.55, reserve: 0.1, floor: 1.1, ceil: 1.1 });
  config.management.minSolToOpen = 1.2;
  // Total ≥ 2.1 with ≥ 1.1 + 0.1 reserve + ~0.12 rent/fees free → exactly 1.1.
  for (const [free, positions] of [[2.1, []], [3, []], [1.5, [pos(1.1)]], [1.33, [pos(1.1)]], [1.33, [pos(2), pos(1.5)]]]) {
    assert.equal(computeDeploySizing(free, portfolio(free, positions)).amount, 1.1, `free ${free}, ${positions.length} positions`);
  }
  // 1.2 free no longer fits 1.1 + reserve + position rent → skip instead of eating the gas reserve.
  assert.equal(computeDeploySizing(1.2, portfolio(1.2, [pos(1.1)])).skip, true);
  // Total under 2.1: 0.55 × (total − 0.1) < 1.1 → skip (today this forced 1.1).
  const s = computeDeploySizing(1.2, portfolio(1.2, []));
  assert.equal(s.skip, true);
  assert.match(s.reason, /^size 0\.61 below floor 1\.1/);
});

test("resolveDeploySizing: uses the passed wallet + positions; wallet error → skip", async () => {
  setSizing({ pct: 0.45, reserve: 0.1, floor: 0.5, ceil: 5 });
  const s = await resolveDeploySizing({ wallet: wallet(2), positions: { positions: [pos(0.6)] } });
  assert.equal(s.amount, 1.13);
  assert.equal(s.basis, "total");
  const failed = await resolveDeploySizing({ wallet: { sol: 0, error: "Helius down" }, positions: { positions: [] } });
  assert.equal(failed.skip, true);
  assert.match(failed.reason, /wallet balance unavailable \(Helius down\)/);
  const fb = await resolveDeploySizing({ wallet: wallet(2), positions: { positions: [], error: "rpc" } });
  assert.equal(fb.basis, "wallet");
  assert.equal(fb.amount, 0.86);
  const logText = fs.readdirSync(path.join(TMP, "logs")).map((f) => fs.readFileSync(path.join(TMP, "logs", f), "utf8")).join("\n");
  assert.match(logText, /Portfolio total unknown \(positions unavailable \(rpc\)\) — sizing from free wallet SOL instead/);
});

test("Telegram deploy card: amount states the basis; a sizing skip refuses the deploy", () => {
  const cfg = { strategy: { activeStrategy: "custom", strategy: "bid_ask" }, usdc: {}, management: {}, risk: {} };
  const c = { pool: "Pool1", name: "AAA-SOL", bin_step: 100, volatility: 3 };
  setSizing({ pct: 0.45, reserve: 0.1, floor: 0.5, ceil: 5 });
  const sizing = computeDeploySizing(2, portfolio(2, [pos(0.6)]));
  const plan = ui.buildDeployPlan(c, { wallet: wallet(2), config: cfg, computeDeployAmount: () => 99, sizing });
  assert.equal(plan.args.amount_y, 1.13);
  assert.equal(plan.amountLabel, "1.13 SOL (1.13 SOL = 45% of (2.60 SOL total − 0.1 reserve))");
  setSizing({ pct: 0.25, reserve: 0.1, floor: 1, ceil: 5 });
  const skip = ui.buildDeployPlan(c, { wallet: wallet(2.58), config: cfg, computeDeployAmount: () => 99, sizing: computeDeploySizing(2.58, portfolio(2.58, [])) });
  assert.match(skip.error, /^Deploy skipped — size 0\.62 below floor 1/);
});

test("All settings lists positionSizeBase as a total/wallet enum under Capital & sizing", () => {
  const svc = as.createAllSettings({
    config, lockedKeys: cfgMod.LOCKED_KEYS, integerKeys: cfgMod.INTEGER_KEYS,
    persistUserConfig: () => {}, persistGmgnConfig: () => {}, dryRunInEnv: false,
  });
  const e = svc.find("positionSizeBase");
  assert.ok(e, "listed");
  assert.equal(e.type, "enum");
  assert.deepEqual(e.enum, ["total", "wallet"]);
  assert.equal(e.group, "cap");
  assert.deepEqual(e.path, ["management", "positionSizeBase"]);
  config.management.positionSizeBase = "wallet";
  assert.equal(svc.risk(e, "total").length, 1, "wallet → total grows deploys: second tap");
  assert.deepEqual(svc.risk(e, "wallet"), []);
  config.management.positionSizeBase = "total";
  assert.deepEqual(svc.risk(e, "wallet"), [], "total → wallet shrinks deploys: one tap");
});

test("rent guard: deposit + position rent + fees never dip into the gas reserve", async () => {
  const { estimatePositionRentSol, fitDeployAmount, worstCaseDeployOverheadSol } = await import("../runtime-helpers.js");
  assert.ok(Math.abs(estimatePositionRentSol(70) - 0.0574) < 1e-9);
  assert.ok(Math.abs(estimatePositionRentSol(162) - 0.0948) < 0.001, "matches the live 162-bin OP-SOL account");
  assert.ok(worstCaseDeployOverheadSol({ minBinStep: 80, maxRangePct: 80 }) > 0.11);
  // The live OP-SOL case: 1.643 free, 1.51 requested, 162 bins → shrunk to keep the 0.1 reserve.
  const op = fitDeployAmount({ freeSol: 1.643, reserve: 0.1, amount: 1.51, totalBins: 162 });
  assert.equal(op.shrunk, true);
  assert.equal(op.amount, 1.43);
  assert.ok(1.643 - op.amount - op.overhead >= 0.1);
  // Plenty of SOL → untouched.
  assert.deepEqual(
    (({ amount, shrunk }) => ({ amount, shrunk }))(fitDeployAmount({ freeSol: 5, reserve: 0.1, amount: 1.5, totalBins: 162 })),
    { amount: 1.5, shrunk: false },
  );
  // Nothing fits → 0 (deploy_position rejects).
  assert.equal(fitDeployAmount({ freeSol: 0.15, reserve: 0.1, amount: 1, totalBins: 70 }).amount, 0);
});
