import test from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "../prompt.js";
import { tools } from "../tools/definitions.js";
import { retainNewestDecisions } from "../decision-log.js";

const portfolio = { sol: 2 };
const positions = { authoritative: true, positions: [{ position: "pos-1", pair: "X-SOL" }] };

test("screener prompt makes host own deployment parameters and keeps bot metrics distinct", () => {
  const prompt = buildSystemPrompt("SCREENER", portfolio, positions, null, "shared text", null, null, null);
  assert.match(prompt, /call deploy_position with only the selected pool_address/i);
  assert.match(prompt, /jupiter_bot_holders_pct/);
  assert.match(prompt, /gmgn_bot_degen_pct/);
  assert.match(prompt, /gmgn_bundler_pct/);
  assert.doesNotMatch(prompt, /already hard-filtered before you see/i);
  assert.doesNotMatch(prompt, /smart-wallet confirmation/i);
  assert.match(prompt, /untrusted advisory/i);
});

test("manager prompt contains authoritative positions and delegates post-close swap to executor", () => {
  const prompt = buildSystemPrompt("MANAGER", portfolio, positions, null, null);
  assert.match(prompt, /pos-1/);
  assert.match(prompt, /close_position handles.*auto-swap/i);
  assert.doesNotMatch(prompt, /swap_token is MANDATORY/i);
});

test("tool contracts do not call 24h fee TVL APY and describe autonomous host ownership", () => {
  const pnl = tools.find((tool) => tool.function.name === "get_position_pnl").function.description;
  const deploy = tools.find((tool) => tool.function.name === "deploy_position").function.description;
  assert.doesNotMatch(pnl, /current APY/i);
  assert.match(pnl, /not an annualized APY/i);
  assert.match(deploy, /autonomous screener/i);
  assert.match(deploy, /host-computed/i);
});

test("decision retention keeps newest entries in order", () => {
  const decisions = Array.from({ length: 105 }, (_, index) => ({ id: index }));
  assert.deepEqual(retainNewestDecisions(decisions, 100).map((entry) => entry.id), Array.from({ length: 100 }, (_, index) => index));
});
