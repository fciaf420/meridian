// ohlcvBufferMult evolution + depth-use tracking + update_config bounds.
process.env.DRY_RUN = "true";
import test from "node:test";
import assert from "node:assert/strict";

const { evolveOhlcvBuffer } = await import("../lessons.js");
const { deepestBinReachedPct, depthUseAtClose } = await import("../state.js");
const { CONFIG_KEY_MAP } = await import("../runtime-helpers.js");

const cfg = (buf = 1.3, mode = "ohlcv") => ({ strategy: { rangeDepthMode: mode, ohlcvBufferMult: buf } });
const close = (o = {}) => ({ range_depth_mode: "ohlcv", ohlcv_buffer_mult: 1.3, oor_direction_at_close: null, stop_loss_close: false, deepest_bin_reached_pct: 60, ...o });
const many = (n, o) => Array.from({ length: n }, () => close(o));

test("raises the buffer when downside OOR / stop losses are frequent", () => {
  const perf = [...many(2, { oor_direction_at_close: "downside" }), close({ stop_loss_close: true }), ...many(2)];
  const r = evolveOhlcvBuffer(perf, cfg());
  assert.equal(r.value, 1.4);
  assert.match(r.rationale, /3\/5/);
});

test("lowers the buffer when ranges go mostly unused", () => {
  const r = evolveOhlcvBuffer(many(5, { deepest_bin_reached_pct: 20 }), cfg());
  assert.equal(r.value, 1.2);
});

test("upside OOR is ignored", () => {
  const perf = many(5, { oor_direction_at_close: "upside", deepest_bin_reached_pct: 70 });
  assert.equal(evolveOhlcvBuffer(perf, cfg()), null);
});

test("needs 5 closes at the current buffer; other buffers don't count", () => {
  assert.equal(evolveOhlcvBuffer(many(4, { oor_direction_at_close: "downside" }), cfg()), null);
  const perf = many(6, { oor_direction_at_close: "downside", ohlcv_buffer_mult: 1.2 });
  assert.equal(evolveOhlcvBuffer(perf, cfg(1.3)), null);
});

test("clamped to 1.0–1.8 and off outside ohlcv mode", () => {
  assert.equal(evolveOhlcvBuffer(many(5, { oor_direction_at_close: "downside", ohlcv_buffer_mult: 1.8 }), cfg(1.8)), null);
  assert.equal(evolveOhlcvBuffer(many(5, { deepest_bin_reached_pct: 10, ohlcv_buffer_mult: 1.0 }), cfg(1.0)), null);
  assert.equal(evolveOhlcvBuffer(many(5, { oor_direction_at_close: "downside" }), cfg(1.3, "volatility")), null);
});

test("deepest bin reached: price-terms share of the range", () => {
  const pos = { active_bin_at_deploy: 0, bin_range: { min: -100, max: 0 }, bin_step: 100, min_active_bin: 0 };
  assert.equal(deepestBinReachedPct(pos), 0);
  assert.equal(deepestBinReachedPct({ ...pos, min_active_bin: -100 }), 100);
  assert.equal(deepestBinReachedPct({ ...pos, min_active_bin: -150 }), 100, "below the range counts as 100");
  const half = deepestBinReachedPct({ ...pos, min_active_bin: -50 });
  assert.ok(half > 50 && half < 70, `half the bins is >50% of the price depth, got ${half}`);
  assert.equal(deepestBinReachedPct({ bin_range: {} }), null);
});

test("depthUseAtClose flags stop losses and the OOR side", () => {
  const pos = { active_bin_at_deploy: 0, bin_range: { min: -100, max: 0 }, bin_step: 100, min_active_bin: -20,
    out_of_range_since: Date.now(), oor_direction: "downside", range_depth_mode: "ohlcv", ohlcv_buffer_mult: 1.3 };
  const d = depthUseAtClose(pos, "STOP_LOSS: pnl -15%");
  assert.equal(d.stop_loss_close, true);
  assert.equal(d.oor_direction_at_close, "downside");
  assert.equal(d.ohlcv_buffer_mult, 1.3);
  assert.equal(depthUseAtClose({ ...pos, out_of_range_since: null }, "take profit").oor_direction_at_close, null);
});

test("the AI can set ohlcvBufferMult, bounded to 1.0–1.8", async () => {
  assert.deepEqual(CONFIG_KEY_MAP.ohlcvBufferMult, ["strategy", "ohlcvBufferMult"]);
  const { executeTool } = await import("../tools/executor.js");
  const bad = await executeTool("update_config", { changes: { ohlcvBufferMult: 2.5 } });
  assert.match(JSON.stringify(bad), /outside the allowed range/);
});
