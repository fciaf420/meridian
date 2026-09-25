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
