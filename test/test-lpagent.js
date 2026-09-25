/**
 * LPAgent API mapping tests — mocked fetch, no network, no signing.
 * Response fixtures follow the documented examples at https://docs.lpagent.io.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.DRY_RUN = "true";
process.env.LPAGENT_API_KEY = "test-key";
process.env.LPAGENT_RPM = "1000";

const { fetchTopLpersStats, mapTopLpersRows, evaluateTopLpersGate } = await import("../tools/study.js");

const realFetch = globalThis.fetch;
function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts);
  };
  return calls;
}
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
test.afterEach(() => { globalThis.fetch = realFetch; });

// Shaped like the documented GET /pools/{poolId}/top-lpers 200 response.
const topLpersRow = (over = {}) => ({
  pool: "7d51qGEeAKiPakkxLoHda9egShXQLJcjFYpHEcX4d3EM",
  owner: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  chain: "SOL",
  protocol: "meteora",
  total_inflow: 5000,
  total_outflow: 5400,
  total_fee: 420,
  total_pnl: 400,
  total_inflow_native: 30,
  total_pnl_native: 2.4,
  total_lp: 10,
  avg_age_hour: 6.5,
  win_lp: 9,
  win_lp_native: 8,
  win_rate: 0.9,
  win_rate_native: 0.8,
  fee_percent: 0.084,
  apr: 1.2,
  roi: 0.08,
  ...over,
});

test("fetchTopLpersStats sends documented params and maps win rate from counts", async () => {
  const calls = mockFetch(() => jsonResponse({
    status: "success",
    data: [topLpersRow(), topLpersRow({ owner: "B", total_lp: 4, win_lp: 3, win_rate: 75, total_inflow: 1200 })],
    pagination: { page: 1, pageSize: 20, totalCount: 2, totalPages: 1, hasNextPage: false },
  }));
  const lpers = await fetchTopLpersStats({ pool_address: "POOL1", limit: 20 });

  assert.equal(calls.length, 1);
  const u = new URL(calls[0].url);
  assert.equal(u.pathname, "/open-api/v1/pools/POOL1/top-lpers");
  assert.equal(u.searchParams.get("chain"), "SOL");
  assert.equal(u.searchParams.get("platform"), "meteora");
  assert.equal(u.searchParams.get("order_by"), "total_pnl_native");
  assert.equal(u.searchParams.get("limit"), "20");
  assert.equal(calls[0].opts.headers["x-api-key"], "test-key");

  assert.equal(lpers.length, 2);
  assert.equal(lpers[0].win_rate, 0.9);
  assert.equal(lpers[0].total_inflow, 5000);
  assert.equal(lpers[0].total_lp, 10);
  // API win_rate on a 0-100 scale must not leak into the gate's 0..1 win rate.
  assert.equal(lpers[1].win_rate, 0.75);
  assert.equal(lpers[1].api_win_rate, 75);
});

test("fetchTopLpersStats returns [] on 401 (Basic key) so the gate fails closed", async () => {
  mockFetch(() => jsonResponse({ message: "A Premium or Enterprise plan is required to access this endpoint." }, 401));
  assert.deepEqual(await fetchTopLpersStats({ pool_address: "POOL2" }), []);
});

test("fetchTopLpersStats returns [] on unexpected shape or network error", async () => {
  mockFetch(() => jsonResponse({ status: "success", data: { not: "an array" } }));
  assert.deepEqual(await fetchTopLpersStats({ pool_address: "POOL3" }), []);
  mockFetch(() => { throw new Error("ECONNRESET"); });
  assert.deepEqual(await fetchTopLpersStats({ pool_address: "POOL4" }), []);
});

test("mapTopLpersRows handles missing and zero counts", () => {
  const [zero, missing, strings] = mapTopLpersRows([
    topLpersRow({ total_lp: 0, win_lp: 0 }),
    topLpersRow({ win_lp: undefined, total_inflow: undefined }),
    topLpersRow({ total_lp: "5", win_lp: "4", total_inflow: "2500" }),
  ]);
  assert.equal(zero.win_rate, null);
  assert.equal(missing.win_rate, null);
  assert.equal(missing.total_inflow, null);
  assert.equal(strings.win_rate, 0.8);
  assert.equal(strings.total_inflow, 2500);
});

test("top-lpers gate requires >= 2 credible LPers averaging >= 80%", () => {
  const lp = (over) => ({ total_lp: 10, win_rate: 0.9, total_inflow: 5000, ...over });

  assert.equal(evaluateTopLpersGate([]).passes, false);
  assert.equal(evaluateTopLpersGate([lp()]).passes, false, "one credible LPer is not enough");
  assert.equal(evaluateTopLpersGate([lp(), lp({ win_rate: 0.85 })]).passes, true);
  assert.equal(evaluateTopLpersGate([lp({ win_rate: 0.8 }), lp({ win_rate: 0.7 })]).passes, false, "avg 0.75 < 0.80");

  const r = evaluateTopLpersGate([
    lp(),
    lp({ win_rate: 0.95 }),
    lp({ total_lp: 2 }),            // too few LPs
    lp({ win_rate: 0.5 }),          // below 60%
    lp({ total_inflow: 999 }),      // below $1,000
    lp({ win_rate: null }),         // unknown win rate
  ]);
  assert.equal(r.credible.length, 2);
  assert.ok(Math.abs(r.avgWR - 0.925) < 1e-9);
  assert.equal(r.passes, true);
});

const { lpaCurrentValueUsd } = await import("../runtime-helpers.js");

test("current value prefers numeric `value` over string `currentValue`", () => {
  // Documented opening-positions example: value reconciles with pnl.value, currentValue does not.
  assert.equal(lpaCurrentValueUsd({ value: 50639.07907119099, currentValue: "53413.446031254" }), 50639.07907119099);
  assert.equal(lpaCurrentValueUsd({ currentValue: "53413.446031254" }), 53413.446031254);
  assert.equal(lpaCurrentValueUsd({ value: null, currentValue: "abc" }), 0);
  assert.equal(lpaCurrentValueUsd({}), 0);
});
