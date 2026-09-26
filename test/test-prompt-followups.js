// Prompt-audit follow-ups: F3 (management goal uses the preloaded positions),
// F4 (GENERAL deploy size computed in code), F6 (one sol_split_pct rule).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.DRY_RUN = "true";
const { config, computeDeploySizing } = await import("../config.js");
const { computePortfolioSol } = await import("../portfolio-value.js");
const prompt = await import("../prompt.js");
const { tools } = await import("../tools/definitions.js");

const WALLET = { sol: 10.2, sol_price: 150 };
const POSITIONS = { total_positions: 1, positions: [{ position: "P1", pool: "POOL1", pair: "ABC-SOL", total_value_usd: 405, total_value_sol: 2.7, unclaimed_fees_usd: 0, unclaimed_fees_sol: 0, pnl_pct: 2.1, sol_price: 150 }] };

function withConfig(section, patch, fn) {
  const prev = { ...config[section] };
  Object.assign(config[section], patch);
  try { return fn(); } finally { Object.assign(config[section], prev); }
}
const classic = (fn) => withConfig("strategy", { activeStrategy: "classic" }, () => withConfig("usdc", { enabled: false }, fn));

// ─── F3 ────────────────────────────────────────────────────────
test("F3: management goal uses Open Positions instead of re-fetching them", () => {
  const goal = prompt.buildManagementGoal("", { usdcMode: false });
  assert.doesNotMatch(goal, /1\. get_my_positions — check all open positions/);
  assert.doesNotMatch(goal, /^\s*- Call get_position_pnl\.$/m, "no unconditional per-position PnL call");
  assert.match(goal, /Open Positions in CURRENT STATE is this cycle's get_my_positions result/);
  assert.match(goal, /do not call get_my_positions again/);
  assert.match(goal, /get_position_pnl to confirm fresh PnL before a close on rule 1, 3 or 6, or when pnl_pct is null/);
  assert.match(goal, /get_pool_detail for rule 5 or a yield judgment, unless RUNNER PRE-CHECK already cleared that position/);
  // Rules, thresholds and the report format are unchanged.
  assert.ok(goal.includes(`pnl_pct >= ${config.management.takeProfitFeePct}% → CLOSE (take profit)`));
  assert.ok(goal.includes(`minutes_out_of_range >= ${config.management.outOfRangeWaitMinutes} → CLOSE (OOR timeout)`));
  assert.ok(goal.includes('**Rule triggered:** [rule number or "none"]'));
});

test("F3: runner pre-check hits are passed to the goal", () => {
  assert.equal(prompt.formatRunnerPrecheck([]), "");
  const block = prompt.formatRunnerPrecheck(["ABC-SOL: rule 3", "XYZ-SOL: pnl unknown"]);
  assert.match(block, /^\n\nRUNNER PRE-CHECK \(hard rules evaluated in code on Open Positions; a position not listed passed all of them, rule 5 included\):\nABC-SOL: rule 3\nXYZ-SOL: pnl unknown\n$/);
  assert.ok(prompt.buildManagementGoal(block).includes(block), "inserted as-is");
  const src = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(src, /memoryHints \+= formatRunnerPrecheck\(ruleHits\);/, "management cycle feeds its rule hits into the goal context");
});

// ─── F4 ────────────────────────────────────────────────────────
test("F4: GENERAL gets the code-computed deploy amount, not a formula", () => classic(() => {
  const expected = computeDeploySizing(WALLET.sol, config.management.positionSizeBase === "wallet" ? null
    : computePortfolioSol({ walletSol: WALLET.sol, wallet: WALLET, positionsResult: POSITIONS })).label;
  assert.match(expected, /^\d+\.\d\d SOL = /);
  const general = prompt.buildSystemPrompt("GENERAL", WALLET, POSITIONS, null, null, null, null);
  assert.ok(general.includes(`Default deploy amount: ${expected}\n`), general.slice(-400));
  assert.match(general, /use "Default deploy amount" in CURRENT STATE/);
  assert.doesNotMatch(general, /amount = \(base - gasReserve|× positionSizePct/, "the hand formula is gone");
  for (const role of ["SCREENER", "MANAGER"]) {
    assert.doesNotMatch(prompt.buildSystemPrompt(role, WALLET, POSITIONS, null, null, null, null), /Default deploy amount/, role);
  }
}));

test("F4: sizing text covers total basis, skip, unknown wallet and USDC mode", () => classic(() => {
  withConfig("management", { positionSizeBase: "total", positionSizePct: 0.5, gasReserve: 0.2, deployAmountSol: 0.5 }, () => {
    withConfig("risk", { maxDeployAmount: 50 }, () => {
      // 10.2 free + 2.7 in the position = 12.90 total; 50% of it = 6.45.
      assert.equal(prompt.generalDeploySizingText(WALLET, POSITIONS), "6.45 SOL = 50% of 12.90 SOL total");
      // Positions not loaded → the conservative free-wallet basis, as deploy_position does.
      assert.match(prompt.generalDeploySizingText(WALLET, {}), /^5\.10 SOL = 50% of 10\.20 SOL free wallet \[wallet basis: positions not loaded\]$/);
      // Below the floor → no deploy, with the reason.
      assert.match(prompt.generalDeploySizingText({ sol: 0.6, sol_price: 150 }, { positions: [] }), /^none \(size .* below floor 0\.5/);
      assert.match(prompt.generalDeploySizingText({ error: "rpc down" }, POSITIONS), /^unknown .*omit the amount/);
      assert.match(prompt.generalDeploySizingText(null, POSITIONS), /^unknown /);
    });
  });
  withConfig("usdc", { enabled: true }, () => {
    assert.match(prompt.generalDeploySizingText(WALLET, POSITIONS), new RegExp(`^\\$${config.usdc.deployAmountUsd} per position \\(USDC mode`));
  });
}));

// ─── F6 ────────────────────────────────────────────────────────
test("F6: prompts and tool text state one sol_split_pct rule (85-90)", () => classic(() => {
  const deploy = tools.find((t) => t.function.name === "deploy_position").function;
  const texts = {
    SCREENER: prompt.buildSystemPrompt("SCREENER", WALLET, POSITIONS, null, null, null, null),
    GENERAL: prompt.buildSystemPrompt("GENERAL", WALLET, POSITIONS, null, null, null, null),
    deploy_description: deploy.description,
    sol_split_pct_param: deploy.parameters.properties.sol_split_pct.description,
  };
  for (const [name, text] of Object.entries(texts)) {
    assert.doesNotMatch(text, /Never go below sol_split_pct = 80%/, name);
    assert.doesNotMatch(text, /25 = mostly token|50 = equal|80 = mostly SOL/, `${name}: no conviction scale below the rule`);
    assert.match(text, /85-90/, name);
  }
  assert.match(texts.SCREENER, /- sol_split_pct MUST be 85-90% \(mostly SOL, minimal token exposure\)/, "protected line kept verbatim");
  assert.match(texts.GENERAL, /Use the user's split when they give one; otherwise sol_split_pct must be 85-90/);
}));
