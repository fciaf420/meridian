// Deploy-path safety ports from yunus-0x/meridian: instance lock, crash
// checkpoint, deploy-time threshold re-check, volatility refusal, pre-submit
// gate, deposit slippage, RPC host masking.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-deploy-safety-"));
process.env.MERIDIAN_DEPLOY_ATTEMPTS_FILE = path.join(tmp, "deploy-attempts.json");

const lockMod = await import("../instance-lock.js");
const { acquireInstanceLock, releaseInstanceLock, isLiveInstance, pidExists } = lockMod;
const { maskRpcUrl, activeRpcHosts, formatRpcHosts } = await import("../rpc-hosts.js");
const g = await import("../deploy-guards.js");
const cp = await import("../deploy-checkpoint.js");
const { config } = await import("../config.js");
const ex = await import("../tools/executor.js");

// ─── instance lock ────────────────────────────────────────────────
test("lock: first acquire writes the pid in the legacy file format", () => {
  const f = path.join(tmp, "a", "bot.pid");
  const lock = acquireInstanceLock(f, { pid: 4242, isLive: () => false });
  assert.equal(fs.readFileSync(f, "utf8"), "4242\n");
  assert.equal(lock.reclaimedStale, false);
  lock.release();
  assert.equal(fs.existsSync(f), false);
});

test("lock: refuses while another live instance holds it", () => {
  const f = path.join(tmp, "b.pid");
  fs.writeFileSync(f, "1111\n");
  assert.throws(() => acquireInstanceLock(f, { pid: 2222, isLive: (p) => p === 1111 }),
    (e) => e.code === "INSTANCE_LOCKED" && e.pid === 1111);
  assert.equal(fs.readFileSync(f, "utf8"), "1111\n", "the holder's file is untouched");
});

test("lock: a stale pidfile is reclaimed (crash / reboot)", () => {
  const f = path.join(tmp, "c.pid");
  fs.writeFileSync(f, "1111\n");
  const lock = acquireInstanceLock(f, { pid: 2222, isLive: () => false });
  assert.equal(lock.reclaimedStale, true);
  assert.equal(fs.readFileSync(f, "utf8"), "2222\n");
});

test("lock: garbage or empty pidfile counts as stale", () => {
  const f = path.join(tmp, "d.pid");
  fs.writeFileSync(f, "not-a-pid");
  assert.equal(acquireInstanceLock(f, { pid: 7, isLive: () => true }).reclaimedStale, true);
});

test("lock: our own pid in the file is not 'another instance'", () => {
  const f = path.join(tmp, "e.pid");
  fs.writeFileSync(f, "99\n");
  assert.equal(acquireInstanceLock(f, { pid: 99, isLive: () => true }).reclaimedStale, true);
});

test("lock: release never removes someone else's lock", () => {
  const f = path.join(tmp, "f.pid");
  fs.writeFileSync(f, "5\n");
  releaseInstanceLock(f, { pid: 6 });
  assert.equal(fs.existsSync(f), true);
  releaseInstanceLock(f, { pid: 5 });
  assert.equal(fs.existsSync(f), false);
});

test("isLiveInstance: a recycled pid running something else is stale; unreadable command fails closed", () => {
  const exists = () => true;
  assert.equal(isLiveInstance(10, { exists, command: () => "/usr/bin/some-other-daemon" }), false);
  assert.equal(isLiveInstance(10, { exists, entry: "/opt/meridian/index.js", command: () => "node /opt/meridian/index.js" }), true);
  assert.equal(isLiveInstance(10, { exists, command: () => null }), true);
  assert.equal(isLiveInstance(10, { exists: () => false, command: () => "node index.js" }), false);
});

test("pidExists: signal-0 probe; EPERM means it exists; bad pids don't", () => {
  assert.equal(pidExists(process.pid), true);
  assert.equal(pidExists(0), false);
  assert.equal(pidExists(-3), false);
  assert.equal(pidExists(5, () => { const e = new Error("x"); e.code = "EPERM"; throw e; }), true);
  assert.equal(pidExists(5, () => { const e = new Error("x"); e.code = "ESRCH"; throw e; }), false);
});

// ─── rpc hosts ────────────────────────────────────────────────────
test("rpc hosts: only hostnames, never keys in path/query/userinfo", () => {
  assert.equal(maskRpcUrl("https://mainnet.helius-rpc.com/?api-key=SECRETKEY123"), "mainnet.helius-rpc.com");
  assert.equal(maskRpcUrl("https://user:pw@rpc.example.com:8899/v1/SECRETPATH"), "rpc.example.com");
  assert.equal(maskRpcUrl("not a url SECRET"), "invalid");
  assert.equal(maskRpcUrl(""), null);
  const hosts = activeRpcHosts({ RPC_URL: "https://a.example/k/SECRET1", BALANCE_RPC_URL: "https://b.example/?key=SECRET2" });
  const out = formatRpcHosts(hosts);
  assert.equal(out, "main=a.example, balances=b.example");
  assert.ok(!/SECRET/.test(out));
  assert.equal(formatRpcHosts([]), "none configured");
});

// ─── volatility ───────────────────────────────────────────────────
test("volatility: unknown / garbage refuses; ZERO is valid (one-bin trading); negative is broken data", () => {
  for (const v of [undefined, null, "", NaN, "abc", -1]) assert.equal(g.checkVolatilityKnown(v).pass, false, String(v));
  assert.deepEqual(g.checkVolatilityKnown(0), { pass: true, volatility: 0 });
  assert.deepEqual(g.checkVolatilityKnown("0"), { pass: true, volatility: 0 });
  assert.deepEqual(g.checkVolatilityKnown("2.5"), { pass: true, volatility: 2.5 });
});

test("pickVolatility: fresh positive beats stale 0; 0 stands when nothing positive; unknown stays unknown", () => {
  assert.equal(g.pickVolatility(0, 3), 3);
  assert.equal(g.pickVolatility(2, 0), 2);
  assert.equal(g.pickVolatility(0, 0), 0);
  assert.equal(g.pickVolatility(0, null), 0);
  assert.equal(g.pickVolatility(undefined, 0), 0);
  assert.equal(g.checkVolatilityKnown(g.pickVolatility(undefined, undefined)).pass, false);
});

// ─── screening thresholds at deploy ───────────────────────────────
const S = { minTvl: 10_000, maxTvl: 150_000, minVolume: 500, minOrganic: 60, minHolders: 500, minMcap: 150_000, maxMcap: 10_000_000, minBinStep: 80, maxBinStep: 125, maxVolatility: 8, maxPriceChangePct: 300, minFeeActiveTvlRatio: 0.05, timeframe: "5m" };
const goodPool = () => ({ tvl: 50_000, volume: 2_000, fee_active_tvl_ratio: 0.4, volatility: 3, dlmm_params: { bin_step: 100 }, base_token_holders: 900, token_x: { market_cap: 500_000, organic_score: 80 }, pool_price_change_pct: 5, pool_price: 1.5 });

test("thresholds: a healthy pool passes", () => {
  const r = g.evaluatePoolThresholds(goodPool(), S);
  assert.equal(r.pass, true);
  assert.equal(r.volatility, 3);
});

test("thresholds: each breached bound is refused with its reason", () => {
  const cases = [
    [{ tvl: 5_000 }, /below minTvl/], [{ tvl: 900_000 }, /above maxTvl/], [{ volume: 10 }, /below minVolume/],
    [{ fee_active_tvl_ratio: 0, active_tvl: 1000, fee: 0.1 }, /minFeeActiveTvlRatio/],
    [{ volatility: 9 }, /above maxVolatility/], [{ dlmm_params: { bin_step: 20 } }, /below minBinStep/],
    [{ dlmm_params: { bin_step: 200 } }, /above maxBinStep/], [{ base_token_holders: 10 }, /minHolders/],
    [{ token_x: { market_cap: 1, organic_score: 80 } }, /minMcap/], [{ token_x: { market_cap: 5e8, organic_score: 80 } }, /maxMcap/],
    [{ token_x: { market_cap: 500_000, organic_score: 10 } }, /minOrganic/], [{ pool_price_change_pct: -400 }, /maxPriceChangePct/],
    [{ is_blacklisted: true }, /blacklisted/],
  ];
  for (const [patch, re] of cases) {
    const r = g.evaluatePoolThresholds({ ...goodPool(), ...patch }, S);
    assert.equal(r.pass, false, JSON.stringify(patch));
    assert.match(r.reason, re);
  }
});

test("thresholds: pool-level gaps fail closed, token-level gaps are skipped with a note", () => {
  assert.equal(g.evaluatePoolThresholds(null, S).pass, false);
  for (const k of ["tvl", "volume", "volatility"]) {
    const p = goodPool(); delete p[k]; delete p.active_tvl;
    assert.equal(g.evaluatePoolThresholds(p, S).pass, false, k);
  }
  const p = goodPool(); delete p.base_token_holders; delete p.token_x;
  const r = g.evaluatePoolThresholds(p, S);
  assert.equal(r.pass, true);
  assert.ok(r.notes.length >= 2);
});

test("thresholds: null/0 bounds mean no limit", () => {
  const r = g.evaluatePoolThresholds({ ...goodPool(), tvl: 1e9, volume: 0 }, { ...S, maxTvl: null, minVolume: 0 });
  assert.equal(r.pass, true);
});

test("fetchPoolForRecheck: builds a pool_address filter, returns the first row / null, throws on HTTP error", async () => {
  let url;
  const mk = (body, ok = true) => async (u) => { url = u; return { ok, status: ok ? 200 : 503, statusText: "x", json: async () => body }; };
  assert.deepEqual(await g.fetchPoolForRecheck("POOLX", "5m", mk({ data: [{ pool_address: "POOLX", tvl: 1 }] })), { pool_address: "POOLX", tvl: 1 });
  assert.equal(await g.fetchPoolForRecheck("POOLX", "5m", mk({ data: [{ pool_address: "OTHER", tvl: 1 }] })), null, "echo-check: a different pool_address is treated as not found");
  assert.match(url, /filter_by=pool_address%3DPOOLX/);
  assert.match(url, /timeframe=5m/);
  assert.equal(await g.fetchPoolForRecheck("POOLX", "5m", mk({ data: [] })), null);
  await assert.rejects(g.fetchPoolForRecheck("POOLX", "5m", mk({}, false)), /503/);
});

// ─── executor integration of the two guards ───────────────────────
function withConfig(patch, fn) {
  const before = { safety: { ...config.safety }, source: config.screening.source };
  Object.assign(config.safety, patch.safety || {});
  if (patch.source) config.screening.source = patch.source;
  return Promise.resolve(fn()).finally(() => { config.safety = before.safety; config.screening.source = before.source; ex.__setDeployRecheckFetch(null); });
}

test("executor guard: passes a healthy pool; refuses a threshold breach; fails closed when the fetch fails", async () => {
  await withConfig({}, async () => {
    ex.__setDeployRecheckFetch(async () => goodPool());
    assert.equal((await ex.checkDeploySafetyGuards({ pool_address: "P", volatility: 3 })).pass, true);
    ex.__setDeployRecheckFetch(async () => ({ ...goodPool(), tvl: 10 }));
    const bad = await ex.checkDeploySafetyGuards({ pool_address: "P", volatility: 3 });
    assert.equal(bad.pass, false);
    assert.match(bad.reason, /Deploy-time screening re-check failed: .*minTvl/);
    ex.__setDeployRecheckFetch(async () => { throw new Error("boom"); });
    const down = await ex.checkDeploySafetyGuards({ pool_address: "P", volatility: 3 });
    assert.equal(down.pass, false);
    assert.match(down.reason, /Could not verify pool screening thresholds before deploy: boom/);
  });
});

test("executor guard: unknown volatility refuses; falls back to the fresh pool's volatility; toggles disable", async () => {
  await withConfig({}, async () => {
    ex.__setDeployRecheckFetch(async () => goodPool());
    assert.equal((await ex.checkDeploySafetyGuards({ pool_address: "P" })).pass, true, "fresh pool volatility is used");
    ex.__setDeployRecheckFetch(async () => ({ ...goodPool(), volatility: 0 }));
    await withConfig({ safety: { recheckScreeningAtDeploy: false } }, async () => {
      assert.equal((await ex.checkDeploySafetyGuards({ pool_address: "P", volatility: null })).pass, true, "fresh pool volatility 0 is valid (one-bin trading)");
      assert.equal((await ex.checkDeploySafetyGuards({ pool_address: "P", volatility: 0 })).pass, true);
      ex.__setDeployRecheckFetch(async () => ({ ...goodPool(), volatility: 4 }));
      assert.equal((await ex.checkDeploySafetyGuards({ pool_address: "P", volatility: 0 })).pass, true, "stale screener 0 rescued by fresh positive");
      ex.__setDeployRecheckFetch(async () => ({ ...goodPool(), volatility: null }));
      const r = await ex.checkDeploySafetyGuards({ pool_address: "P", volatility: null });
      assert.equal(r.pass, false);
      assert.match(r.reason, /Volatility is unknown/);
      config.safety.requireKnownVolatility = false;
      assert.equal((await ex.checkDeploySafetyGuards({ pool_address: "P" })).pass, true);
    });
  });
});

test("executor guard: owner-manual deploys are exempt; gmgn source skips the Meteora threshold re-check", async () => {
  await withConfig({}, async () => {
    ex.__setDeployRecheckFetch(async () => { throw new Error("must not be called"); });
    assert.equal((await ex.checkDeploySafetyGuards({ pool_address: "P", _manual: true })).pass, true);
  });
  await withConfig({ source: "gmgn" }, async () => {
    ex.__setDeployRecheckFetch(async () => ({ ...goodPool(), tvl: 1 }));
    assert.equal((await ex.checkDeploySafetyGuards({ pool_address: "P", volatility: 3 })).pass, true);
  });
});

// ─── price move + deposit slippage ────────────────────────────────
test("price move: (1+step)^bins - 1, symmetric sign, limit enforced", () => {
  assert.ok(Math.abs(g.priceMovePctBetweenBins(100, 0, 5) - 5.101) < 0.01); // 1.01^5
  assert.ok(g.priceMovePctBetweenBins(100, 5, 0) < 0);
  assert.equal(g.checkEntryPriceMove({ binStep: 100, fromBinId: 100, toBinId: 104, maxMovePct: 5 }).pass, true);
  const r = g.checkEntryPriceMove({ binStep: 100, fromBinId: 100, toBinId: 106, maxMovePct: 5 });
  assert.equal(r.pass, false);
  assert.match(r.reason, /limit is 5%/);
  assert.equal(g.checkEntryPriceMove({ binStep: 100, fromBinId: 100, toBinId: 94, maxMovePct: 5 }).pass, false, "downward moves count too");
  assert.equal(g.checkEntryPriceMove({ binStep: undefined, fromBinId: 1, toBinId: 2, maxMovePct: 5 }).pass, false, "unknown step fails closed");
});

test("deposit slippage: pct -> SDK active-bin drift = ceil(pct / (binStep/100))", () => {
  assert.deepEqual(g.depositSlippage(80, 5), { slippagePct: 5, driftBins: 7 });
  assert.deepEqual(g.depositSlippage(100, 5), { slippagePct: 5, driftBins: 5 });
  assert.deepEqual(g.depositSlippage(125, 5), { slippagePct: 5, driftBins: 4 });
  assert.equal(g.depositSlippage(100, 10).driftBins, 10, "the old hard-coded 10% allowed 10 bins at bin step 100");
  assert.equal(g.depositSlippage(100, 0.2).driftBins, 1, "never below one bin");
  assert.equal(g.depositSlippage(100, 90).slippagePct, 25, "capped at 25%");
  assert.equal(g.depositSlippage(100, "junk").slippagePct, 5);
  assert.equal(g.depositSlippage(null, 5).driftBins, null);
});

test("deploy source: no hard-coded 10% slippage remains; checkpoint precedes the first send", () => {
  const src = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  assert.ok(!/slippage:\s*10\b/.test(src));
  const begin = src.indexOf("beginAttempt({");
  const gate = src.indexOf("await preSubmitGate({");
  const create = src.indexOf("pool.createExtendedEmptyPosition(");
  const std = src.indexOf("pool.initializePositionAndAddLiquidityByStrategy({");
  assert.ok(begin > 0 && gate > begin && create > gate && std > gate, "checkpoint -> gate -> build/send");
});

// ─── pre-submit gate ──────────────────────────────────────────────
const gateArgs = (o = {}) => ({
  refetch: async () => {}, getActiveId: () => 100, readFreeSol: async () => 5,
  binStep: 100, loadBinId: 100, anchorBinId: 100, maxMovePct: 5, reserve: 0.2, amount: 1, totalBins: 60, ...o,
});

test("pre-submit gate: ok when price is steady and funds cover rent + reserve", async () => {
  const r = await g.preSubmitGate(gateArgs());
  assert.equal(r.pass, true);
  assert.equal(r.freeSol, 5);
});

test("pre-submit gate: refuses a >5% move since load OR since the range anchor", async () => {
  const a = await g.preSubmitGate(gateArgs({ getActiveId: () => 107 }));
  assert.equal(a.pass, false); assert.match(a.reason, /price moved/);
  const b = await g.preSubmitGate(gateArgs({ getActiveId: () => 93, anchorBinId: 99 }));
  assert.equal(b.pass, false);
  const cfg = await g.preSubmitGate(gateArgs({ getActiveId: () => 107, maxMovePct: 10 }));
  assert.equal(cfg.pass, true, "limit is configurable");
});

test("pre-submit gate: refetch failure, balance failure and insufficient SOL all refuse", async () => {
  assert.match((await g.preSubmitGate(gateArgs({ refetch: async () => { throw new Error("rpc down"); } }))).reason, /fresh pool read failed/);
  assert.match((await g.preSubmitGate(gateArgs({ readFreeSol: async () => { throw new Error("nope"); } }))).reason, /balance read unavailable/);
  assert.match((await g.preSubmitGate(gateArgs({ readFreeSol: async () => NaN }))).reason, /balance read unavailable/);
  const poor = await g.preSubmitGate(gateArgs({ readFreeSol: async () => 1.1 }));
  assert.equal(poor.pass, false);
  assert.match(poor.reason, /insufficient spendable SOL/);
  assert.equal((await g.preSubmitGate(gateArgs({ amount: 0, readFreeSol: async () => { throw new Error("unused"); } }))).pass, true);
});

// ─── crash checkpoint ─────────────────────────────────────────────
test("checkpoint: begin -> submitting blocks the pool and mint until resolved", () => {
  const id = cp.beginAttempt({ pool: "POOL1", mint: "MINT1", position: "POSITIONAAAA", amountSol: 1 });
  assert.equal(cp.getUnresolvedAttempts().length, 1);
  assert.equal(cp.findBlockingAttempt({ pool: "POOL1" }).id, id);
  assert.equal(cp.findBlockingAttempt({ pool: "OTHER", mint: "MINT1" }).id, id, "same token via a different pool is blocked too");
  assert.equal(cp.findBlockingAttempt({ pool: "OTHER", mint: "M2" }), null);
  cp.markAttempt(id, "entered", { txs: 1 });
  assert.equal(cp.findBlockingAttempt({ pool: "POOL1" }), null);
});

test("checkpoint: corrupt JSON self-heals to .corrupt-<ts>, alerts, and continues empty (finding 4)", () => {
  const f = process.env.MERIDIAN_DEPLOY_ATTEMPTS_FILE;
  const alerts = [];
  cp.setCorruptionHandler((a) => alerts.push(a));
  for (const bad of ["{ not json", JSON.stringify({ nope: 1 }), "[]"]) {
    fs.writeFileSync(f, bad);
    assert.equal(cp.findBlockingAttempt({ pool: "X" }), null, "does not refuse every deploy");
    assert.ok(fs.readdirSync(path.dirname(f)).some((n) => n.startsWith("deploy-attempts.json.corrupt-")), "backup kept");
    assert.doesNotThrow(() => cp.markAttempt(cp.beginAttempt({ pool: "X", position: "Y" }), "entered"));
    fs.rmSync(f, { force: true });
  }
  assert.equal(alerts.length, 3);
  assert.match(alerts[0].backup, /\.corrupt-\d+$/);
  cp.setCorruptionHandler(null);
});

test("checkpoint: real I/O errors (not corruption) still fail closed", () => {
  const f = process.env.MERIDIAN_DEPLOY_ATTEMPTS_FILE;
  fs.rmSync(f, { force: true });
  fs.mkdirSync(f); // reading a directory -> EISDIR, not a parse error
  assert.equal(cp.findBlockingAttempt({ pool: "X" }).status, "unreadable");
  assert.throws(() => cp.beginAttempt({ pool: "X", position: "Y" }), /unreadable/);
  fs.rmdirSync(f);
});

test("checkpoint: clearAttempt resolves only unresolved attempts; periodic re-reconcile resolves an earlier 'uncertain' (finding 3)", async () => {
  const id = cp.beginAttempt({ pool: "PC", mint: "MC", position: "POS_CLEAR_001" });
  cp.markAttempt(id, "uncertain", { error: "rpc" });
  // first pass: chain unreadable -> stays blocking; a later pass (next management tick) resolves it
  await cp.reconcileAttempts({ positionExists: async () => null, log: () => {} });
  assert.equal(cp.findBlockingAttempt({ pool: "PC" }).id, id);
  await cp.reconcileAttempts({ positionExists: async () => false, log: () => {} });
  assert.equal(cp.findBlockingAttempt({ pool: "PC" }), null);
  const id2 = cp.beginAttempt({ pool: "PC2", mint: "MC2", position: "POS_CLEAR_002" });
  assert.equal(cp.clearAttempt("nope"), null);
  assert.equal(cp.clearAttempt(id2).status, "cleared_manual");
  assert.equal(cp.findBlockingAttempt({ pool: "PC2" }), null);
  assert.equal(cp.clearAttempt(id2), null, "already resolved");
});

test("index.js wires periodic reconcile into the management tick and a /reconcile command", () => {
  const src = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const tick = src.indexOf("const mgmtTask = cron.schedule");
  const call = src.indexOf('reconcileDeployAttemptsNow({ source: "periodic" })');
  const earlyReturn = src.indexOf("Management skipped — no open positions");
  assert.ok(tick > 0 && call > tick && call < earlyReturn, "runs before the no-positions early return");
  assert.ok(src.includes('text === "/reconcile"') && src.includes('input === "/reconcile"'));
  assert.ok(src.includes("setCorruptionHandler"));
});

// ─── instance lock identity (finding 6) ───────────────────────────
test("entryMatches: own entry script only; relative argv resolved via the process cwd", () => {
  const entry = "/opt/meridian/index.js";
  const m = (cmd, cwd) => isLiveInstance(10, { exists: () => true, entry, command: () => cmd, cwdOf: () => cwd });
  assert.equal(m("node /opt/meridian/index.js", null), true, "absolute path");
  assert.equal(m("node index.js", "/opt/meridian"), true, "relative, same cwd (how it is usually started)");
  assert.equal(m("node index.js", "/Users/dev/other-app"), false, "someone else's index.js");
  assert.equal(m("node /Users/dev/other-app/index.js", null), false);
  assert.equal(m("node index.js", null), true, "relative and cwd unreadable: fail closed");
  assert.equal(m("/usr/bin/vim notes.txt", null), false);
  assert.equal(isLiveInstance(10, { exists: () => true, entry: null, command: () => "node whatever/index.js" }), true, "no argv[1]: legacy index.js match");
});

test("lock refusal explains the unverifiable case (EPERM sandboxes)", () => {
  const f = path.join(tmp, "unverifiable.pid");
  fs.writeFileSync(f, "4242\n");
  assert.throws(() => acquireInstanceLock(f, { pid: 1, isLive: () => true, command: () => null }), /MERIDIAN_SKIP_INSTANCE_LOCK=1/);
  fs.rmSync(f);
});

test("checkpoint: boot reconcile resolves landed / absent and keeps unverified blocking", async () => {
  const a = cp.beginAttempt({ pool: "PL", mint: "ML", position: "POS_LANDED_1" });
  const b = cp.beginAttempt({ pool: "PA", mint: "MA", position: "POS_ABSENT_1", now: Date.now() + 1 });
  const c = cp.beginAttempt({ pool: "PU", mint: "MU", position: "POS_UNKNOWN_1", now: Date.now() + 2 });
  const seen = [];
  const res = await cp.reconcileAttempts({
    positionExists: async (p) => (p === "POS_LANDED_1" ? true : p === "POS_ABSENT_1" ? false : null),
    log: () => {},
    notify: async (r) => seen.push(r.map((x) => x.outcome)),
  });
  assert.deepEqual(res.map((r) => r.outcome).sort(), ["absent", "landed", "unverified"]);
  assert.equal(cp.findBlockingAttempt({ pool: "PL" }), null);
  assert.equal(cp.findBlockingAttempt({ pool: "PA" }), null);
  assert.equal(cp.findBlockingAttempt({ pool: "PU" }).id, c);
  assert.equal(seen.length, 1);
  void a; void b;
  // a thrown read counts as unknown, not as absent
  const d = cp.beginAttempt({ pool: "PT", position: "POS_THROWS_1", now: Date.now() + 3 });
  const r2 = await cp.reconcileAttempts({ positionExists: async () => { throw new Error("rpc"); }, log: () => {} });
  assert.ok(r2.every((x) => x.outcome === "unverified"));
  assert.equal(cp.findBlockingAttempt({ pool: "PT" }).id, d);
});

test("checkpoint: eligibility refuses a pool with an unreconciled interrupted deploy", async () => {
  cp.beginAttempt({ pool: "BLOCKED_POOL", mint: "BLOCKED_MINT", position: "POS_BLK_1", now: Date.now() + 10 });
  const r = await ex.checkDeployEligibility({ pool_address: "BLOCKED_POOL", bin_step: 100, base_mint: "BLOCKED_MINT" });
  assert.equal(r.pass, false);
  assert.match(r.reason, /interrupted and not yet reconciled/);
});

test("checkpoint: resolved history is pruned to a bounded size", () => {
  for (let i = 0; i < 70; i++) {
    const id = cp.beginAttempt({ pool: `PR${i}`, position: `POS_PRUNE_${i}`, now: Date.now() + 100 + i });
    cp.markAttempt(id, "failed");
  }
  const db = JSON.parse(fs.readFileSync(process.env.MERIDIAN_DEPLOY_ATTEMPTS_FILE, "utf8"));
  const resolved = Object.values(db.attempts).filter((x) => !["submitting", "uncertain"].includes(x.status));
  assert.ok(resolved.length <= 50);
});

// ─── screening -> deploy drift (finding 5) ────────────────────────
test("screen drift: pure check; skipped when a side is missing", () => {
  assert.equal(g.checkScreenPriceDrift({ screenPrice: 1, freshPrice: 1.04, maxDropPct: 5 }).pass, true);
  const bad = g.checkScreenPriceDrift({ screenPrice: 1, freshPrice: 0.9, maxDropPct: 5 });
  assert.equal(bad.pass, false); assert.match(bad.reason, /dropped 10\.0%/);
  assert.deepEqual(g.checkScreenPriceDrift({ screenPrice: null, freshPrice: 1, maxDropPct: 5 }), { pass: true, checked: false });
  assert.equal(g.checkScreenPriceDrift({ screenPrice: 1, freshPrice: 0.5, maxDropPct: 0 }).pass, true, "0 disables");
});

test("executor guard: screening price (LLM arg or code snapshot) vs fresh pool price", async () => {
  g.resetRefusalStats(); g.clearScreenedPrices();
  await withConfig({}, async () => {
    ex.__setDeployRecheckFetch(async () => ({ ...goodPool(), pool_price: 1.5 }));
    assert.equal((await ex.checkDeploySafetyGuards({ pool_address: "PD", screen_price: 1.5 })).pass, true);
    // B: a RISE (+50%) is harmless for SOL-only below-active deposits: passes.
    assert.equal((await ex.checkDeploySafetyGuards({ pool_address: "PD", screen_price: 1.0 })).pass, true, "rise is not refused");
    // a drop beyond the 12% default refuses; a 10% drop does not
    ex.__setDeployRecheckFetch(async () => ({ ...goodPool(), pool_price: 0.8 }));
    const r = await ex.checkDeploySafetyGuards({ pool_address: "PD", screen_price: 1.0 });
    assert.equal(r.pass, false); assert.match(r.reason, /price dropped 20\.0%/);
    ex.__setDeployRecheckFetch(async () => ({ ...goodPool(), pool_price: 0.9 }));
    assert.equal((await ex.checkDeploySafetyGuards({ pool_address: "PD", screen_price: 1.0 })).pass, true, "10% drop < 12% limit");
    // The code-recorded snapshot wins over a (possibly dodging) model-supplied value.
    ex.__setDeployRecheckFetch(async () => ({ ...goodPool(), pool_price: 0.5 }));
    g.noteScreenedPrice("PD", 1.0);
    assert.equal((await ex.checkDeploySafetyGuards({ pool_address: "PD", screen_price: 0.5 })).pass, false);
    ex.__setDeployRecheckFetch(async () => ({ ...goodPool(), pool_price: 1.5 }));
    g.clearScreenedPrices();
    assert.equal((await ex.checkDeploySafetyGuards({ pool_address: "PD" })).pass, true, "no screening price -> documented fallback: not checked");
    await withConfig({ safety: { maxScreenToDeployDropPct: 0 } }, async () => {
      ex.__setDeployRecheckFetch(async () => ({ ...goodPool(), pool_price: 0.1 }));
      assert.equal((await ex.checkDeploySafetyGuards({ pool_address: "PD", screen_price: 1.0 })).pass, true, "0 = disabled");
    });
  });
  assert.equal(g.getRefusalStats().screen_drift, 2);
});

test("refusal counters: tallied by kind and exposed with the last reason", () => {
  g.resetRefusalStats();
  g.recordRefusal("recheck", "tvl"); g.recordRefusal("pre_submit", "moved"); g.recordRefusal("bogus", "x");
  const st = g.getRefusalStats();
  assert.equal(st.total, 3); assert.equal(st.recheck, 1); assert.equal(st.other, 1); assert.equal(st.last.kind, "other");
  g.resetRefusalStats();
});

// ─── post-swap gate (finding 2) ───────────────────────────────────
test("pre-submit gate after an auto-swap: own swap impact excluded; balance leg shrinks instead of refusing", async () => {
  // load-time bin 100, pool moved to 110 BECAUSE of our swap; anchor is the post-swap refetch (110).
  const ok = await g.preSubmitGate(gateArgs({ loadBinId: null, anchorBinId: 110, getActiveId: () => 110 }));
  assert.equal(ok.pass, true);
  // Same inputs with the stale load bin would have refused (the bug).
  assert.equal((await g.preSubmitGate(gateArgs({ loadBinId: 100, anchorBinId: 110, getActiveId: () => 110 }))).pass, false);
  // Balance short: refuses normally, shrinks with allowShrink.
  const tight = gateArgs({ readFreeSol: async () => 1.25, amount: 1 });
  assert.equal((await g.preSubmitGate(tight)).pass, false);
  const fit = await g.preSubmitGate({ ...tight, allowShrink: true });
  assert.equal(fit.pass, true); assert.equal(fit.shrunk, true); assert.ok(fit.amount < 1 && fit.amount >= 0.1);
  // Too little even after shrinking: still a refusal (caller must swap back).
  assert.equal((await g.preSubmitGate({ ...tight, readFreeSol: async () => 0.3, allowShrink: true })).pass, false);
});

test("swapBackAfterRefusal: sells the swapped token to SOL; reports failures without throwing", async () => {
  const calls = [];
  const ok = await g.swapBackAfterRefusal({ swapFn: async (a, d) => { calls.push(a, d); return { success: true }; }, baseMint: "MINTX", amount: 12.5, solMint: "SOL" });
  assert.equal(ok.ok, true);
  assert.deepEqual(calls[0], { input_mint: "MINTX", output_mint: "SOL", amount: 12.5 });
  assert.deepEqual(calls[1], { impactCap: "close" }, "swap-back uses the close-path price-impact cap (D1)");
  assert.equal((await g.swapBackAfterRefusal({ swapFn: async () => ({ success: false, error: "no route" }), baseMint: "MINTX", amount: 1, solMint: "SOL" })).ok, false);
  assert.equal((await g.swapBackAfterRefusal({ swapFn: async () => { throw new Error("boom"); }, baseMint: "MINTX", amount: 1, solMint: "SOL" })).ok, false);
  assert.equal((await g.swapBackAfterRefusal({ swapFn: async () => { throw new Error("unused"); }, baseMint: "MINTX", amount: 0, solMint: "SOL" })).ok, false);
});

test("deploy source: every refusal after the auto-swap unwinds it; gate skips the load bin post-swap", () => {
  const src = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  const swapAt = src.indexOf("autoSwapped = { baseMint");
  const afterSwap = src.slice(swapAt);
  assert.ok(swapAt > 0);
  assert.ok(/loadBinId: autoSwapped \? null : activeIdAtLoad/.test(src));
  assert.ok(/allowShrink: !!autoSwapped/.test(src));
  const refusals = afterSwap.match(/return \{ success: false,[^\n]*\n?/g).filter((l) => /bin arrays|Pre-submit recheck failed|crash checkpoint/.test(l));
  assert.ok(refusals.length >= 4);
  for (const l of refusals) assert.ok(/unwindAutoSwap\(\)/.test(l), l.slice(0, 80));
});

// ─── Opus 5.5 review fixes ────────────────────────────────────────
test("A: reconcile skips in-flight and young attempts; compare-and-set; clear refuses in-flight", async () => {
  const id = cp.beginAttempt({ pool: "PIF", mint: "MIF", position: "POS_INFLIGHT_1" });
  cp.trackInFlightAttempt(id);
  // periodic reconcile with positionExists -> false must NOT touch the in-flight attempt
  const res = await cp.reconcileAttempts({ positionExists: async () => false, log: () => {}, minAgeMs: 10 * 60_000 });
  assert.ok(!res.some((x) => x.attempt.id === id));
  assert.equal(cp.getUnresolvedAttempts().find((a) => a.id === id).status, "submitting");
  // even without the age filter (manual), in-flight is skipped
  const res2 = await cp.reconcileAttempts({ positionExists: async () => false, log: () => {} });
  assert.ok(!res2.some((x) => x.attempt.id === id));
  // clear force refuses in-flight
  assert.equal(cp.clearAttempt(id), null);
  assert.equal(cp.isAttemptInFlight(id), true);
  // young attempt not in flight (e.g. another writer): skipped by age filter, reconciled at boot (minAge 0)
  const young = cp.beginAttempt({ pool: "PYG", position: "POS_YOUNG_1" });
  const rp = await cp.reconcileAttempts({ positionExists: async () => false, log: () => {}, minAgeMs: 10 * 60_000 });
  assert.ok(!rp.some((x) => x.attempt.id === young));
  const old = cp.beginAttempt({ pool: "POLD", position: "POS_OLD_1", now: Date.now() - 20 * 60_000 });
  const ro = await cp.reconcileAttempts({ positionExists: async () => false, log: () => {}, minAgeMs: 10 * 60_000 });
  assert.ok(ro.some((x) => x.attempt.id === old && x.outcome === "absent"), "old unresolved attempt is reconciled");
  // release -> now reconcilable/clearable
  cp.releaseInFlightAttempt(id);
  assert.ok(cp.clearAttempt(id));
  cp.clearAttempt(young);
});

test("A: reconcile is compare-and-set (a deploy write during the RPC await is not overwritten)", async () => {
  const id = cp.beginAttempt({ pool: "PCAS", position: "POS_CAS_1", now: Date.now() - 30 * 60_000 });
  const res = await cp.reconcileAttempts({
    positionExists: async () => { cp.markAttempt(id, "uncertain", { error: "deploy wrote this during the await" }); return false; },
    log: () => {},
  });
  assert.ok(!res.some((x) => x.attempt.id === id), "no outcome reported for a changed attempt");
  const a = cp.getUnresolvedAttempts().find((x) => x.id === id);
  assert.equal(a.status, "uncertain", "stale reconcile did not overwrite uncertain with reconciled_absent");
  assert.equal(cp.markAttemptIf(id, "submitting", "failed"), false);
  assert.equal(cp.markAttemptIf(id, "uncertain", "failed"), true);
});

test("A: source wires in-flight tracking and the periodic min age", () => {
  const dl = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  assert.ok(/trackInFlightAttempt\(attemptId\)/.test(dl) && /finally \{\s*releaseInFlightAttempt\(attemptId\)/.test(dl));
  const ix = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.ok(/minAgeMs: source === "periodic"/.test(ix) && /isAttemptInFlight/.test(ix));
});

test("B: screen drift is drop-only; entry-move gate drop-only for SOL-only, symmetric otherwise", async () => {
  assert.equal(g.checkScreenPriceDrift({ screenPrice: 1, freshPrice: 2, maxDropPct: 12 }).pass, true);
  assert.equal(g.checkScreenPriceDrift({ screenPrice: 1, freshPrice: 2, maxDropPct: 12 }).rose, true);
  assert.equal(g.checkScreenPriceDrift({ screenPrice: 1, freshPrice: 0.87, maxDropPct: 12 }).pass, false);
  assert.equal(g.checkScreenPriceDrift({ screenPrice: 1, freshPrice: 0.5, maxDropPct: 0 }).pass, true);
  // bin step 100 (1%/bin): +10 bins = +10.5%, -10 bins = -9.5%
  const up = { binStep: 100, fromBinId: 100, toBinId: 110, maxMovePct: 5 };
  assert.equal(g.checkEntryPriceMove(up).pass, false, "symmetric by default (two-sided)");
  assert.equal(g.checkEntryPriceMove({ ...up, dropOnly: true }).pass, true, "rise ok when SOL-only");
  assert.equal(g.checkEntryPriceMove({ ...up, toBinId: 90, dropOnly: true }).pass, false, "drop still refused");
  const gate = (extra) => g.preSubmitGate({ refetch: async () => {}, getActiveId: () => 110, readFreeSol: async () => 5, binStep: 100, loadBinId: 100, anchorBinId: 100, maxMovePct: 5, reserve: 0.2, amount: 1, totalBins: 60, ...extra });
  assert.equal((await gate({ dropOnly: true })).pass, true);
  assert.equal((await gate({})).pass, false);
  assert.equal(config.safety.maxScreenToDeployDropPct, 12);
});

test("C: GMGN-only candidate in both mode never records a comparable screen price", async () => {
  g.clearScreenedPrices();
  const screening = await import("../tools/screening.js");
  const src = fs.readFileSync(new URL("../tools/screening.js", import.meta.url), "utf8");
  assert.ok(screening && /noteUncomparableScreenPrice\(p\.pool\)/.test(src));
  // behaviour: an uncomparable marker blocks both the code price and any model-supplied screen_price
  g.noteUncomparableScreenPrice("GMGN_ONLY_POOL");
  assert.equal(g.getScreenedPrice("GMGN_ONLY_POOL"), null);
  assert.equal(g.isScreenPriceUncomparable("GMGN_ONLY_POOL"), true);
  await withConfig({ source: "both" }, async () => {
    // fresh pool_price is SOL-per-token (5e-6); the model echoes the USD price 4.6e-4 (88x) -> must not refuse
    ex.__setDeployRecheckFetch(async () => ({ ...goodPool(), pool_price: 0.00000523 }));
    const r = await ex.checkDeploySafetyGuards({ pool_address: "GMGN_ONLY_POOL", screen_price: 0.000462 });
    assert.equal(r.pass, true);
    // a Pool Discovery candidate in both mode is still compared
    g.noteScreenedPrice("MET_POOL", 0.00001);
    const r2 = await ex.checkDeploySafetyGuards({ pool_address: "MET_POOL" });
    assert.equal(r2.pass, false, "drop of ~48% from a recorded Pool Discovery price refuses");
  });
  g.clearScreenedPrices();
});

test("D: unwind failure fires onFail; unthrown-after-swap paths unwind (source)", async () => {
  let failed = null;
  await g.swapBackAfterRefusal({ swapFn: async () => ({ success: false, error: "no route" }), baseMint: "M", amount: 1, solMint: "S", onFail: (r) => { failed = r; } });
  assert.match(failed.note, /remains in the wallet/);
  let okCalled = false;
  await g.swapBackAfterRefusal({ swapFn: async () => ({ success: true }), baseMint: "M", amount: 1, solMint: "S", onFail: () => { okCalled = true; } });
  assert.equal(okCalled, false);
  const dl = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  assert.ok(/Invalid strategy[^\n]*unwindAutoSwap\(\)/.test(dl));
  assert.ok(/token Y decimals[^\n]*unwindAutoSwap\(\)/.test(dl) && /token X decimals[^\n]*unwindAutoSwap\(\)/.test(dl));
  assert.ok(/txMaybeSent \? "" : await unwindAutoSwap\(\)/.test(dl), "outer catch unwinds when no tx could have been sent");
  assert.ok(/emit\("swap_unwind_failed"/.test(dl));
  const ui = fs.readFileSync(new URL("../telegram-ui.js", import.meta.url), "utf8");
  assert.ok(/swap_unwind_failed: \(d\) =>/.test(ui));
});

test("E: screen_active_bin is gone from the model-facing tool and the deploy path", () => {
  const defs = fs.readFileSync(new URL("../tools/definitions.js", import.meta.url), "utf8");
  const dl = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  assert.equal(defs.includes("screen_active_bin"), false);
  assert.equal(dl.includes("screen_active_bin"), false);
});

test("F: instance lock path comparison uses realpath and folds case on darwin", () => {
  const { samePath } = lockMod;
  const real = fs.mkdtempSync(path.join(tmp, "Real-"));
  fs.writeFileSync(path.join(real, "index.js"), "");
  const link = path.join(tmp, "link-dir");
  fs.symlinkSync(real, link);
  const file = path.join(real, "index.js");
  assert.equal(samePath(path.join(link, "index.js"), file), true, "symlinked dir resolves to the same file");
  if (process.platform === "darwin") assert.equal(samePath(file.replace("Real-", "REAL-"), file, "darwin"), true, "canonical casing on case-insensitive disk");
  // case-fold: fake non-existent paths differ only by case
  assert.equal(samePath("/Users/x/Projects/meridian/index.js", "/Users/x/projects/meridian/index.js", "darwin"), true);
  assert.equal(samePath("/Users/x/Projects/meridian/index.js", "/Users/x/projects/meridian/index.js", "linux"), false);
  assert.equal(samePath("/Users/x/a/index.js", "/Users/x/b/index.js", "darwin"), false);
  // through isLiveInstance: absolute token differing only by case / via symlink is "us"
  const m = (cmd, entry) => isLiveInstance(10, { exists: () => true, entry, command: () => cmd, cwdOf: () => null });
  assert.equal(m(`node ${path.join(link, "index.js")}`, file), true);
});

// ─── Final Opus review (PR #134): L1 bounded recheck fetch ────────────
test("L1: fetchPoolForRecheck passes an 8s abort signal and fails closed when the fetch aborts", async () => {
  let opts;
  const ok = async (_u, o) => { opts = o; return { ok: true, status: 200, statusText: "x", json: async () => ({ data: [] }) }; };
  await g.fetchPoolForRecheck("POOLX", "5m", ok);
  assert.ok(opts?.signal instanceof AbortSignal);
  assert.equal(g.RECHECK_FETCH_TIMEOUT_MS, 8000);
  const hung = (_u, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(new DOMException("aborted", "TimeoutError"))));
  const ac = AbortSignal.timeout; // shrink the timeout for the test only
  AbortSignal.timeout = () => ac.call(AbortSignal, 30);
  try {
    await assert.rejects(g.fetchPoolForRecheck("POOLX", "5m", hung), /abort/i);
  } finally { AbortSignal.timeout = ac; }
});

// ─── L2: everything after the auto-swap is inside the unwind-protected try ───
test("L2: refetch / bin-array window / SOL price / decimals all sit inside the try whose catch unwinds the auto-swap", () => {
  const src = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  const tryAt = src.indexOf("L2: everything after the auto-swap");
  const open = src.indexOf("  try {\n", tryAt);
  const refetch = src.indexOf("await pool.refetchStates();\n  const activeBin", tryAt);
  const window = src.indexOf("await initializedBinArrayWindow(", tryAt);
  const price = src.indexOf("await getSolPrice()", tryAt);
  const catchAt = src.indexOf("  } catch (error) {\n    log(\"deploy_error\"", tryAt);
  assert.ok(tryAt > 0 && open > tryAt && catchAt > open);
  for (const at of [refetch, window, price]) assert.ok(at > open && at < catchAt, "await is inside the protected try");
  const catchBody = src.slice(catchAt, catchAt + 600);
  assert.match(catchBody, /unwindAutoSwap\(\)/);
});
