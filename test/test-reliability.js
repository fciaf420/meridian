/**
 * Reliability: graceful shutdown drain, crash handlers, atomic JSON writes,
 * the corrupt-state.json guard, and syncOpenPositions merging instead of
 * clobbering concurrent updates.
 *
 * state.js reads/writes ./state.json relative to the cwd, so this test chdirs
 * into a temp dir BEFORE importing it — it must never touch the live state file.
 * No network: fetch is stubbed to fail, so the LP Agent lookup in the sync
 * returns an empty map.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const REPO = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-reliability-"));
process.chdir(TMP);
process.env.DRY_RUN = "true";
for (const k of Object.keys(process.env)) if (k.startsWith("LPAGENT")) delete process.env[k];
delete process.env.HEALTHCHECK_URL;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("network disabled in test"); };
test.after(() => {
  globalThis.fetch = realFetch;
  process.chdir(REPO);
  fs.rmSync(TMP, { recursive: true, force: true });
});

const { writeFileAtomicSync, writeJsonAtomicSync } = await import(new URL("../atomic-write.js", import.meta.url));
const { createShutdownController, createCrashHandler, drainTimeoutMsFromEnv } = await import(new URL("../shutdown.js", import.meta.url));
const state = await import(new URL("../state.js", import.meta.url));
const session = await import(new URL("../session.js", import.meta.url));

// ─── Drain ───────────────────────────────────────────────────────

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; await new Promise((r) => setImmediate(r)); } };
}

function harness({ pending, timeoutMs = 90_000 }) {
  const clock = fakeClock();
  const exits = [];
  const logs = [];
  let intakeStopped = 0;
  const ctl = createShutdownController({
    stopIntake: () => { intakeStopped++; },
    getPending: () => pending(),
    exit: (code) => exits.push(code),
    log: (cat, msg) => logs.push(`${cat}: ${msg}`),
    timeoutMs,
    pollMs: 1_000,
    sleep: clock.sleep,
    now: clock.now,
  });
  return { ctl, exits, logs, clock, intake: () => intakeStopped };
}

test("drain stops intake, waits for in-flight work, then exits 0", async () => {
  let inflight = ["close 7xKXabcd", "management cycle"];
  const h = harness({ pending: () => inflight });
  const done = h.ctl.handleSignal("SIGTERM");
  assert.equal(h.intake(), 1, "intake stopped immediately");
  // Let several poll rounds pass with work still in flight.
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.exits, [], "no exit while work is in flight");
  assert.ok(h.logs.some((l) => l.includes("Waiting for: close 7xKXabcd, management cycle")), "logs what it waits for");

  inflight = ["management cycle"];
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.exits, []);
  inflight = [];
  await done;
  assert.deepEqual(h.exits, [0]);
  assert.ok(h.logs.some((l) => l.includes("Drained after")));
});

test("drain gives up after the timeout and still exits 0", async () => {
  const h = harness({ pending: () => ["screening cycle"], timeoutMs: 5_000 });
  await h.ctl.handleSignal("SIGINT");
  assert.deepEqual(h.exits, [0]);
  assert.ok(h.clock.now() >= 5_000);
  assert.ok(h.logs.some((l) => l.includes("Drain timed out") && l.includes("screening cycle")));
});

test("a second signal during the drain forces an immediate exit(1)", async () => {
  const h = harness({ pending: () => ["deploy_position"] });
  const done = h.ctl.handleSignal("SIGTERM");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.exits, []);
  h.ctl.handleSignal("SIGINT");
  assert.deepEqual(h.exits, [1], "forced exit, immediately");
  await done; // the drain loop notices and stops without a second exit
  assert.deepEqual(h.exits, [1]);
});

test("a non-signal trigger (stdin closed) never counts as the forcing second signal", async () => {
  let inflight = ["close abc"];
  const h = harness({ pending: () => inflight });
  const done = h.ctl.handleSignal("SIGTERM");
  h.ctl.handleSignal("stdin closed", { force: false });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.exits, []);
  inflight = [];
  await done;
  assert.deepEqual(h.exits, [0]);
});

test("drain timeout is configurable via SHUTDOWN_DRAIN_TIMEOUT_SEC", () => {
  assert.equal(drainTimeoutMsFromEnv({}), 90_000);
  assert.equal(drainTimeoutMsFromEnv({ SHUTDOWN_DRAIN_TIMEOUT_SEC: "30" }), 30_000);
  assert.equal(drainTimeoutMsFromEnv({ SHUTDOWN_DRAIN_TIMEOUT_SEC: "junk" }), 90_000);
});

test("draining flag lives in session.js", () => {
  assert.equal(session.isDraining(), false);
  session.setDraining(true);
  assert.equal(session.isDraining(), true);
  session.setDraining(false);
});

test("trackInflightOp lists an operation until it settles (resolve or reject)", async () => {
  let resolveA, rejectB;
  const a = session.trackInflightOp("close_position", new Promise((r) => { resolveA = r; }));
  const b = session.trackInflightOp("deploy_position", new Promise((_, j) => { rejectB = j; }));
  assert.deepEqual(session.getInflightOps().sort(), ["close_position", "deploy_position"]);
  resolveA({ success: true });
  await a;
  rejectB(new Error("boom"));
  await assert.rejects(b, /boom/);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(session.getInflightOps(), []);
});

// ─── Crash handler ───────────────────────────────────────────────

test("crash handler logs, alerts, then exits 1 (once)", async () => {
  const exits = [];
  const logs = [];
  const alerts = [];
  const onCrash = createCrashHandler({
    alert: async (msg) => { alerts.push(msg); },
    exit: (c) => exits.push(c),
    log: (cat, msg) => logs.push(`${cat}: ${msg}`),
  });
  await onCrash("uncaughtException", new Error("kaboom"));
  await onCrash("unhandledRejection", new Error("second")); // ignored: already crashing
  assert.deepEqual(exits, [1]);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /kaboom/);
  assert.ok(logs.some((l) => l.startsWith("crash_error: uncaughtException") && l.includes("kaboom")));
});

test("crash handler still exits when the alert hangs", async () => {
  const exits = [];
  const onCrash = createCrashHandler({
    alert: () => new Promise(() => {}), // never settles
    exit: (c) => exits.push(c),
    log: () => {},
    alertTimeoutMs: 20,
  });
  await onCrash("unhandledRejection", "plain string reason");
  assert.deepEqual(exits, [1]);
});

// ─── Atomic writes ───────────────────────────────────────────────

test("writeJsonAtomicSync writes the file and leaves no temp files", () => {
  const dir = fs.mkdtempSync(path.join(TMP, "aw-"));
  const f = path.join(dir, "x.json");
  writeJsonAtomicSync(f, { a: 1 });
  writeJsonAtomicSync(f, { a: 2, b: [1, 2] });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { a: 2, b: [1, 2] });
  assert.equal(fs.readFileSync(f, "utf8"), JSON.stringify({ a: 2, b: [1, 2] }, null, 2));
  assert.deepEqual(fs.readdirSync(dir), ["x.json"]);
});

test("writeFileAtomicSync keeps the existing file's permission bits", () => {
  const f = path.join(TMP, "secret.json");
  fs.writeFileSync(f, "{}");
  fs.chmodSync(f, 0o600);
  writeFileAtomicSync(f, '{"k":1}');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(f, "utf8"), '{"k":1}');
});

test("a failed atomic write throws, cleans its temp file and leaves the target untouched", () => {
  const dir = fs.mkdtempSync(path.join(TMP, "aw-fail-"));
  const target = path.join(dir, "target");
  fs.mkdirSync(target); // rename(file -> existing directory) fails
  fs.writeFileSync(path.join(target, "keep"), "x");
  assert.throws(() => writeFileAtomicSync(target, "data"));
  assert.deepEqual(fs.readdirSync(dir), ["target"], "no temp file left behind");
  assert.equal(fs.readFileSync(path.join(target, "keep"), "utf8"), "x");
});

// ─── Corrupt state.json ──────────────────────────────────────────

function track(position, extra = {}) {
  state.trackPosition({
    position,
    pool: "Pool111111111111111111111111111111111111111",
    pool_name: "TEST-SOL",
    strategy: "bid_ask",
    amount_sol: 1,
    active_bin: 100,
    bin_step: 100,
    ...extra,
  });
}

test("a corrupt state.json is backed up, never wiped, and saves resume once it is fixed", () => {
  const corrupt = '{"positions": {"Keep1": {"position": "Keep1"}'; // truncated mid-write
  fs.writeFileSync("state.json", corrupt);

  // A read enters degraded mode and returns an empty (usable) state.
  assert.deepEqual(state.getTrackedPositions(), []);
  assert.equal(state.isStateDegraded(), true);
  const backups = fs.readdirSync(".").filter((f) => f.startsWith("state.json.corrupt-"));
  assert.equal(backups.length, 1, "exactly one backup");
  assert.equal(fs.readFileSync(backups[0], "utf8"), corrupt);

  // Writers must not persist the empty state over the recoverable file.
  track("NewPos1111");
  state.setScreeningPaused(true);
  assert.equal(fs.readFileSync("state.json", "utf8"), corrupt, "file untouched while degraded");
  assert.equal(fs.readdirSync(".").filter((f) => f.startsWith("state.json.corrupt-")).length, 1, "no backup spam");

  // Operator restores the file: degraded mode clears and saves work again.
  fs.writeFileSync("state.json", JSON.stringify({ positions: { Keep1: { position: "Keep1", notes: [] } } }));
  assert.equal(state.isStateDegraded(), false);
  track("NewPos2222");
  const saved = JSON.parse(fs.readFileSync("state.json", "utf8"));
  assert.ok(saved.positions.Keep1, "restored data kept");
  assert.ok(saved.positions.NewPos2222, "new save landed");

  for (const b of fs.readdirSync(".").filter((f) => f.startsWith("state.json.corrupt-"))) fs.unlinkSync(b);
  fs.unlinkSync("state.json");
});

// ─── syncOpenPositions merge ─────────────────────────────────────

test("syncOpenPositions merges its close into the current file instead of clobbering concurrent updates", async () => {
  if (fs.existsSync("state.json")) fs.unlinkSync("state.json");
  const old = new Date(Date.now() - 60 * 60_000).toISOString();
  track("GonePos111", { deployed_at: old });
  track("OpenPos111", { deployed_at: old });

  // Sync: GonePos111 is no longer on-chain. Its first await (the LP Agent
  // lookup) happens before any save, so the updates below land "during" it.
  const sync = state.syncOpenPositions(["OpenPos111"]);
  track("Deployed22", { deployed_at: new Date().toISOString() });  // concurrent deploy
  state.setPositionInstruction("OpenPos111", "hold until 5%");     // concurrent update
  await sync;

  const saved = JSON.parse(fs.readFileSync("state.json", "utf8"));
  assert.equal(saved.positions.GonePos111.closed, true, "sync's own change landed");
  assert.ok(saved.positions.GonePos111.notes.some((n) => n.includes("Auto-closed during state sync")));
  assert.ok(saved.positions.Deployed22, "concurrently deployed position survived the sync save");
  assert.equal(saved.positions.OpenPos111.instruction, "hold until 5%", "concurrent instruction survived");
  assert.ok(!saved.positions.OpenPos111.closed);
});

test("syncOpenPositions keeps a concurrent close's own closed_at", async () => {
  fs.unlinkSync("state.json");
  const old = new Date(Date.now() - 60 * 60_000).toISOString();
  track("Racing111", { deployed_at: old });
  const sync = state.syncOpenPositions([]);
  state.recordClose("Racing111", "stop loss");
  const closedAt = JSON.parse(fs.readFileSync("state.json", "utf8")).positions.Racing111.closed_at;
  await sync;
  const saved = JSON.parse(fs.readFileSync("state.json", "utf8"));
  assert.equal(saved.positions.Racing111.closed, true);
  assert.equal(saved.positions.Racing111.closed_at, closedAt, "recordClose's timestamp kept");
  assert.ok(saved.positions.Racing111.notes.some((n) => n.includes("stop loss")), "recordClose's note kept");
});

test("overlapping syncOpenPositions calls share one run", async () => {
  const a = state.syncOpenPositions([]);
  const b = state.syncOpenPositions([]);
  assert.equal(a, b);
  await a;
});

// ─── PnL watcher: drain + dead-man switch ────────────────────────

const watcher = await import(new URL("../pnl-watcher.js", import.meta.url));

test("the PnL watcher starts no new tick while draining", async () => {
  let positionReads = 0;
  watcher._setPnlWatcherDepsForTest({
    isDraining: () => true,
    getMyPositions: async () => { positionReads++; return { positions: [] }; },
  });
  await watcher.runPnlWatcher();
  assert.equal(positionReads, 0);
  assert.equal(watcher.isPnlTickRunning(), false);
  watcher._setPnlWatcherDepsForTest(null);
});

test("HEALTHCHECK_URL is pinged every N ticks, fire-and-forget", async () => {
  const pings = [];
  process.env.HEALTHCHECK_URL = "https://hc-ping.example/abc";
  process.env.HEALTHCHECK_EVERY_TICKS = "3";
  watcher._resetHealthcheckForTest();
  watcher._setPnlWatcherDepsForTest({
    isDraining: () => false,
    isBusy: () => true, // tick exits early; the ping still counts the tick
    fetch: (url, opts) => { pings.push({ url, opts }); return Promise.reject(new Error("offline")); },
  });
  try {
    for (let i = 0; i < 7; i++) await watcher.runPnlWatcher();
    assert.equal(pings.length, 3, "ticks 1, 4 and 7");
    assert.equal(pings[0].url, "https://hc-ping.example/abc");
    assert.equal(pings[0].opts.method, "GET");
    assert.ok(pings[0].opts.signal, "request has a timeout signal");
    await new Promise((r) => setImmediate(r)); // rejected ping is swallowed

    delete process.env.HEALTHCHECK_URL;
    watcher._resetHealthcheckForTest();
    await watcher.runPnlWatcher();
    assert.equal(pings.length, 3, "no URL, no ping");
  } finally {
    delete process.env.HEALTHCHECK_URL;
    delete process.env.HEALTHCHECK_EVERY_TICKS;
    watcher._setPnlWatcherDepsForTest(null);
  }
});
