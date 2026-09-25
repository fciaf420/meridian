// Prompt text that depends on the configured strategy and the management close policy.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DRY_RUN = "true";
const { config } = await import("../config.js");
const prompt = await import("../prompt.js");
const { tools } = await import("../tools/definitions.js");

const CANDLES = { supertrend_direction: "up", supertrend_price_above: true, rsi_2: 55 };

function withStrategy(name, fn) {
  const prev = config.strategy.activeStrategy;
  config.strategy.activeStrategy = name;
  try { return fn(); } finally { config.strategy.activeStrategy = prev; }
}

test("Evil Panda entry gating is shown only under evil_panda", () => {
  withStrategy("classic", () => {
    const line = prompt.evilPandaCandidateText(false, CANDLES);
    assert.doesNotMatch(line, /Evil Panda/);
    assert.match(line, /supertrend=up\/above \| RSI\(2\)=55/, "indicator data is still shown");
    assert.equal(prompt.evilPandaGuideLine(), "");
  });
  withStrategy("evil_panda", () => {
    assert.match(prompt.evilPandaCandidateText(true, CANDLES), /Evil Panda entry: PASS \| need token24hVol>=/);
    assert.match(prompt.evilPandaCandidateText(false, CANDLES), /Evil Panda entry: FAIL/);
    assert.match(prompt.evilPandaGuideLine(), /^- Evil Panda entry requires token-level GMGN volume24H/);
  });
});

test("classic prompts never state the Evil Panda entry gate", () => {
  withStrategy("classic", () => {
    for (const role of ["SCREENER", "MANAGER", "GENERAL"]) {
      assert.doesNotMatch(prompt.buildSystemPrompt(role, {}, {}, null, null, null, null), /Evil Panda entry/, role);
    }
  });
  const deploy = tools.find((t) => t.function.name === "deploy_position").function.description;
  assert.doesNotMatch(deploy, /Supertrend|entry checks/, "static tool text is shared by every strategy");
});

test("management goal: hard rules first, judgment closes need a stated reason, otherwise hold", () => {
  const goal = prompt.buildManagementGoal("\n\nEXIT ALERTS (CLOSE THESE IMMEDIATELY):\nX", { usdcMode: false });
  assert.ok(goal.includes("EXIT ALERTS (CLOSE THESE IMMEDIATELY):\nX"), "runner context is inserted as-is");
  assert.ok(goal.indexOf("HARD CLOSE RULES") < goal.indexOf("JUDGMENT CLOSES"), "hard rules come first");
  assert.match(goal, /JUDGMENT CLOSES: When no hard rule fires and no exit alert applies, you may still close/);
  for (const factor of [/downside out of range with negative PnL/, /yield dying/, /opportunity cost/]) assert.match(goal, factor);
  assert.match(goal, /A judgment close needs a stated reason/);
  assert.match(goal, /Without a hard rule, an exit alert or a stated judgment reason → HOLD\./);
  assert.doesNotMatch(goal, /Do not close for any other reason/);
  assert.ok(goal.includes(`pnl_pct >= ${config.management.takeProfitFeePct}% → CLOSE`), "thresholds still come from config");
  assert.ok(goal.includes('**Rule triggered:** [rule number or "none"]'), "report format unchanged");
  assert.match(prompt.buildManagementGoal("", { usdcMode: true }), /auto-settles all recovered tokens/);
  // The manager instructions describe the same judgment factors, so the two prompts agree.
  const mgr = prompt.buildSystemPrompt("MANAGER", {}, {}, null, null, null, null);
  assert.match(mgr, /needs the factor and its data named in the close reason/);
  assert.match(mgr, /Opportunity Cost/);
});
