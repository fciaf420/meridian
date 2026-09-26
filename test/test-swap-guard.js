/**
 * Fund-safety guards:
 * - child-env.js: the Codex / Claude / gmgn CLIs get an allowlisted env, never
 *   the wallet key or API keys (checked on real spawns of stand-in CLIs).
 * - tools/swap-guard.js + executor: an LLM swap_token may only sell what a
 *   recent close left unsold, never buy with SOL, never run while that close's
 *   swap may still land.
 * - close-swap.js exposure record, state.js persistence.
 * Everything is local: stand-in CLI scripts, mocked balance reads, a temp cwd
 * for state.json. No network, no RPC, no transactions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

const REPO = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-swapguard-"));
const SENTINEL = "SENTINEL_SECRET_VALUE_7f3a";
process.env.MERIDIAN_USER_CONFIG_PATH = path.join(TMP, "user-config.json");
fs.writeFileSync(process.env.MERIDIAN_USER_CONFIG_PATH, "{}");
process.env.WALLET_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
process.env.RPC_URL = "http://127.0.0.1:9"; // never reached: balance reads are mocked
process.env.DRY_RUN = "true";
delete process.env.TELEGRAM_BOT_TOKEN;
process.chdir(TMP);
test.after(() => { process.chdir(REPO); fs.rmSync(TMP, { recursive: true, force: true }); });

const { buildCliEnv } = await import("../child-env.js");
const { runCodexExec, runClaudeCli, codexPermissionArgs } = await import("../llm-provider.js");
const { gmgnSpawnOptions } = await import("../tools/gmgn.js");
const { checkAgentSwap, CLOSE_EXPOSURE_WINDOW_MS, AMBIGUOUS_SWAP_WINDOW_MS, SOL_MINT } = await import("../tools/swap-guard.js");
const { swapBackWithdrawnBase } = await import("../tools/close-swap.js");
const state = await import("../state.js");
const { executeTool } = await import("../tools/executor.js");

const MINT = "2PENPmfgJfq6CG3k4byj4oWwHf8SerqakmYHMkUupump";
const OTHER = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEC = 6;

const SECRET_ENV = {
  WALLET_PRIVATE_KEY: SENTINEL,
  RPC_URL: `https://rpc.example/?api-key=${SENTINEL}`,
  HELIUS_API_KEY: SENTINEL,
  JUPITER_API_KEY: SENTINEL,
  LPAGENT_API_KEY: SENTINEL,
  DEEPSEEK_API_KEY: SENTINEL,
  OPENROUTER_API_KEY: SENTINEL,
  MINIMAX_API_KEY: SENTINEL,
  GMGN_API_KEY: SENTINEL,
  SOLANATRACKER_API_KEY: SENTINEL,
  TELEGRAM_BOT_TOKEN: SENTINEL,
  TELEGRAM_CHAT_ID: SENTINEL,
  DASHBOARD_TOKEN: SENTINEL,
  CLAUDECODE: "1",
  CLAUDE_CODE_MESSAGING_TOKEN: SENTINEL,
  ANTHROPIC_API_KEY: SENTINEL,
  OPENAI_API_KEY: SENTINEL,
  LC_SECRET_KEY: SENTINEL,
};

// ─── Child-process env allowlist ───────────────────────────────

test("buildCliEnv keeps the process basics and drops every secret", () => {
  const src = { PATH: "/usr/bin", HOME: "/home/u", USER: "u", LANG: "en_US.UTF-8", LC_ALL: "C", TMPDIR: "/tmp", TERM: "xterm", ...SECRET_ENV };
  for (const cli of ["codex", "claude"]) {
    const env = buildCliEnv(cli, src, "darwin");
    for (const k of ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "TERM"]) assert.equal(env[k], src[k], `${cli} keeps ${k}`);
    assert.ok(!Object.values(env).includes(SENTINEL), `${cli} env carries no secret value`);
    assert.ok(!Object.values(env).some((v) => v.includes(SENTINEL)), `${cli} env carries no secret inside a value`);
    assert.equal(env.WALLET_PRIVATE_KEY, undefined);
    assert.equal(env.CLAUDECODE, undefined, "parent Claude Code session markers are not inherited");
  }
});

test("each CLI gets only its own login/config variables", () => {
  const src = { PATH: "/usr/bin", CODEX_HOME: "/c", CLAUDE_CONFIG_DIR: "/d", CLAUDE_CODE_OAUTH_TOKEN: "oauth", GMGN_API_KEY: "gmgn", WALLET_PRIVATE_KEY: SENTINEL };
  assert.deepEqual(buildCliEnv("codex", src, "darwin"), { PATH: "/usr/bin", CODEX_HOME: "/c" });
  assert.deepEqual(buildCliEnv("claude", src, "darwin"), { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/d", CLAUDE_CODE_OAUTH_TOKEN: "oauth" });
  assert.deepEqual(buildCliEnv("gmgn", src, "darwin"), { PATH: "/usr/bin", GMGN_API_KEY: "gmgn" });
  // Windows env names are case-insensitive.
  assert.deepEqual(buildCliEnv("codex", { Path: "C:\\x", SystemRoot: "C:\\Windows", WALLET_PRIVATE_KEY: SENTINEL }, "win32"), { Path: "C:\\x", SystemRoot: "C:\\Windows" });
  assert.throws(() => buildCliEnv("nope", src));
});

/** Stand-in CLI: reads stdin, reports its env keys and whether any value holds the sentinel. */
function fakeCli(kind) {
  const file = path.join(TMP, `fake-${kind}.mjs`);
  fs.writeFileSync(file, `#!/usr/bin/env node
let d = "";
process.stdin.on("data", (c) => { d += c; });
process.stdin.on("end", () => {
  const text = JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), keys: Object.keys(process.env), leaked: Object.values(process.env).some((v) => String(v).includes(${JSON.stringify(SENTINEL)})) });
  if (${JSON.stringify(kind)} === "codex") console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
  else console.log(JSON.stringify({ type: "result", result: text }));
});
`);
  fs.chmodSync(file, 0o755);
  return file;
}

test("the env handed to the real Codex/Claude spawns never contains WALLET_PRIVATE_KEY or API keys", { skip: process.platform === "win32" }, async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, SECRET_ENV);
    process.env.CODEX_PATH = fakeCli("codex");
    process.env.CLAUDE_PATH = fakeCli("claude");
    const codex = JSON.parse(await runCodexExec("m", "hi", { cwd: TMP, timeoutMs: 20_000 }));
    const claude = JSON.parse(await runClaudeCli("m", "hi", { timeoutMs: 20_000 }));
    for (const [name, seen] of [["codex", codex], ["claude", claude]]) {
      assert.equal(seen.leaked, false, `${name} saw a secret value`);
      for (const k of Object.keys(SECRET_ENV)) assert.ok(!seen.keys.includes(k), `${name} got ${k}`);
      assert.ok(seen.keys.includes("PATH") && seen.keys.includes("HOME"), `${name} keeps PATH/HOME`);
    }
    // Codex runs from an empty private temp dir, never the repo or the caller's cwd.
    assert.notEqual(fs.realpathSync(codex.cwd), fs.realpathSync(REPO));
    assert.notEqual(fs.realpathSync(codex.cwd), fs.realpathSync(TMP));
    assert.match(path.basename(codex.cwd), /^meridian-codex-/);
    assert.deepEqual(fs.readdirSync(codex.cwd), []);
    if (process.platform === "darwin") {
      // Read-restricting permission profile instead of the read-anything read-only sandbox.
      assert.ok(codex.argv.includes('default_permissions="meridian_llm"'));
      assert.ok(!codex.argv.includes("--sandbox"));
      const perms = codex.argv.find((a) => a.startsWith("permissions.meridian_llm="));
      assert.ok(perms.includes('":minimal"="read"'));
      assert.ok(perms.includes(JSON.stringify(codex.cwd)));
      assert.ok(!perms.includes(JSON.stringify(REPO)));
    }
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("codexPermissionArgs grants reads only to :minimal, the work dir and the codex binary dirs", () => {
  const bin = process.execPath; // any real absolute executable
  const args = codexPermissionArgs(bin, "/tmp/meridian-codex-x", { platform: "darwin" });
  assert.equal(args[0], "-c");
  assert.equal(args[1], 'default_permissions="meridian_llm"');
  const fsSpec = args[3];
  assert.match(fsSpec, /^permissions\.meridian_llm=\{filesystem=\{":minimal"="read", /);
  assert.ok(fsSpec.includes('"/tmp/meridian-codex-x"="read"'));
  assert.ok(fsSpec.includes(`${JSON.stringify(path.dirname(bin))}="read"`));
  assert.ok(!/"write"|"\/"=/.test(fsSpec), "no write grants, no whole-disk read");
  // Other platforms and an unlocatable binary fall back to --sandbox read-only.
  assert.equal(codexPermissionArgs(bin, "/tmp/x", { platform: "linux" }), null);
  assert.equal(codexPermissionArgs("codex", "/tmp/x", { platform: "darwin", locate: () => null }), null);
});

test("gmgn-cli gets GMGN_API_KEY only and runs outside the repo (no .env pickup)", () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, SECRET_ENV, { GMGN_API_KEY: "gmgn-key" });
    const opts = gmgnSpawnOptions();
    assert.equal(opts.env.GMGN_API_KEY, "gmgn-key");
    assert.equal(opts.env.WALLET_PRIVATE_KEY, undefined);
    assert.ok(!Object.values(opts.env).some((v) => v.includes(SENTINEL)));
    assert.notEqual(path.resolve(opts.cwd), path.resolve(REPO));
    assert.equal(fs.existsSync(path.join(opts.cwd, ".env")), false);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

// ─── swap-guard (pure, injected deps) ──────────────────────────

const NOW = Date.parse("2026-09-26T12:00:00Z");
function exposure(over = {}) {
  return {
    position: "POS1",
    mint: MINT,
    decimals: DEC,
    pre_raw: "5000000",          // 5 tokens held before the close
    unsold_raw: "721233237",     // 721.233237 left unsold by the close
    agent_sold_raw: "0",
    recorded_at: new Date(NOW - 60_000).toISOString(),
    ambiguous_until: null,
    ...over,
  };
}
function guardDeps({ exp = exposure(), balanceRaw = 5000000n + 721233237n, readError = null } = {}) {
  const reads = [];
  return {
    reads,
    deps: {
      now: () => NOW,
      findExposure: (mint, { windowMs }) => {
        assert.equal(windowMs, CLOSE_EXPOSURE_WINDOW_MS);
        return exp && exp.mint === mint ? exp : null;
      },
      readBalance: async (mint) => {
        reads.push(mint);
        if (readError) throw readError;
        return { raw: balanceRaw, decimals: DEC, accounts: 1 };
      },
    },
  };
}

test("an LLM swap of an unrelated token is refused", async () => {
  const g = guardDeps();
  const r = await checkAgentSwap({ input_mint: OTHER, output_mint: "SOL", amount: 10 }, g.deps);
  assert.equal(r.pass, false);
  assert.match(r.reason, /no unsold exposure from a close/);
  assert.equal(g.reads.length, 0);
});

test("SOL→token buys and non-SOL outputs are refused for the LLM", async () => {
  const g = guardDeps();
  for (const input of ["SOL", SOL_MINT, "So11111111111111111111111111111111111111111"]) {
    const r = await checkAgentSwap({ input_mint: input, output_mint: MINT, amount: 0.5 }, g.deps);
    assert.equal(r.pass, false);
    assert.match(r.reason, /may not buy tokens with SOL/);
  }
  const toUsdc = await checkAgentSwap({ input_mint: MINT, output_mint: OTHER, amount: 1 }, g.deps);
  assert.equal(toUsdc.pass, false);
  assert.match(toUsdc.reason, /output_mint must be SOL/);
  assert.equal((await checkAgentSwap({ input_mint: MINT, amount: 1 }, g.deps)).pass, false);
});

test("a swap within the recorded exposure is allowed unchanged", async () => {
  const g = guardDeps();
  const r = await checkAgentSwap({ input_mint: MINT, output_mint: "SOL", amount: 700 }, g.deps);
  assert.equal(r.pass, true);
  assert.equal(r.args.amount, 700);
  assert.equal(r.args.output_mint, SOL_MINT);
  assert.equal(r.guard.clamped, false);
  assert.equal(r.guard.sell_raw, "700000000");
  assert.equal(r.guard.position, "POS1");
  assert.deepEqual(g.reads, [MINT]);
});

test("a swap over the exposure is clamped to it", async () => {
  const g = guardDeps();
  const r = await checkAgentSwap({ input_mint: MINT, output_mint: "SOL", amount: 5000 }, g.deps);
  assert.equal(r.pass, true);
  assert.equal(r.guard.clamped, true);
  assert.equal(r.args.amount, "721.233237");
  assert.equal(r.guard.sell_raw, "721233237");
});

test("the sellable amount shrinks to what is still on-chain above the pre-close balance, and to what the agent already sold", async () => {
  // Only 100 of the unsold 721.23 is still above the pre-close balance (e.g. a late swap landed).
  let r = await checkAgentSwap({ input_mint: MINT, output_mint: "SOL", amount: 721 }, guardDeps({ balanceRaw: 5000000n + 100000000n }).deps);
  assert.equal(r.args.amount, "100");
  // Balance back at (or under) the pre-close level: nothing left to sell.
  r = await checkAgentSwap({ input_mint: MINT, output_mint: "SOL", amount: 1 }, guardDeps({ balanceRaw: 5000000n }).deps);
  assert.equal(r.pass, false);
  assert.match(r.reason, /no longer in the wallet/);
  // The agent already sold 700 against this close.
  r = await checkAgentSwap({ input_mint: MINT, output_mint: "SOL", amount: 721 }, guardDeps({ exp: exposure({ agent_sold_raw: "700000000" }) }).deps);
  assert.equal(r.args.amount, "21.233237");
  r = await checkAgentSwap({ input_mint: MINT, output_mint: "SOL", amount: 1 }, guardDeps({ exp: exposure({ agent_sold_raw: "721233237" }) }).deps);
  assert.equal(r.pass, false);
  // Nothing attributable recorded (pre-close balance unknown / withdrawal never seen).
  r = await checkAgentSwap({ input_mint: MINT, output_mint: "SOL", amount: 1 }, guardDeps({ exp: exposure({ unsold_raw: "0", pre_raw: null, decimals: null }) }).deps);
  assert.equal(r.pass, false);
  assert.match(r.reason, /no attributable unsold amount/);
});

test("an ambiguous in-flight swap blocks any sale until its window has passed", async () => {
  const inFlight = exposure({ ambiguous_until: new Date(NOW + 45_000).toISOString() });
  const g = guardDeps({ exp: inFlight });
  const r = await checkAgentSwap({ input_mint: MINT, output_mint: "SOL", amount: 1 }, g.deps);
  assert.equal(r.pass, false);
  assert.match(r.reason, /may still land \(~45s left\)/);
  assert.equal(g.reads.length, 0, "no balance read while in flight");
  // Window over: allowed again, bounded by the on-chain balance.
  const after = await checkAgentSwap({ input_mint: MINT, output_mint: "SOL", amount: 1 }, guardDeps({ exp: exposure({ ambiguous_until: new Date(NOW - 1).toISOString() }) }).deps);
  assert.equal(after.pass, true);
});

test("a failed balance read or a bad amount refuses", async () => {
  let r = await checkAgentSwap({ input_mint: MINT, output_mint: "SOL", amount: 1 }, guardDeps({ readError: new Error("rpc down") }).deps);
  assert.equal(r.pass, false);
  assert.match(r.reason, /could not read/);
  for (const amount of [0, -1, "abc", undefined]) {
    r = await checkAgentSwap({ input_mint: MINT, output_mint: "SOL", amount }, guardDeps().deps);
    assert.equal(r.pass, false, `amount ${amount}`);
  }
});

// ─── close-swap exposure record ────────────────────────────────

function closeHarness({ balances, swapResults }) {
  let i = 0;
  let n = 0;
  return {
    readBalance: async () => ({ raw: BigInt(balances[Math.min(i++, balances.length - 1)]), decimals: DEC, accounts: 1 }),
    getPrice: async () => null,
    swap: async () => swapResults[Math.min(n++, swapResults.length - 1)],
    sleep: async () => {},
    log: () => {},
  };
}

test("close-swap records the attributable unsold amount and whether its swap is ambiguous", async () => {
  // Ambiguous swap: not retried, exposure flagged ambiguous, clamped to expected (+2%) not the whole delta.
  const amb = await swapBackWithdrawnBase(
    { baseMint: MINT, preRaw: 5000000n, expectedRaw: 100000000n },
    closeHarness({ balances: [5000000 + 150000000], swapResults: [{ success: false, ambiguous: true, error: "outcome unknown" }] }),
  );
  assert.equal(amb.exposureFlag, true);
  assert.deepEqual(amb.exposure, { mint: MINT, decimals: DEC, pre_raw: "5000000", unsold_raw: "102000000", ambiguous: true });
  assert.equal(amb.swapOutcome.exposure_ui, "102");

  // Plain failure: exposure is the unsold delta, not ambiguous.
  const fail = await swapBackWithdrawnBase(
    { baseMint: MINT, preRaw: 0n, expectedRaw: 721233237n },
    closeHarness({ balances: [721233237], swapResults: [{ success: false, error: "No route found" }] }),
  );
  assert.equal(fail.exposure.unsold_raw, "721233237");
  assert.equal(fail.exposure.ambiguous, false);

  // Unknown pre-close balance: nothing attributable.
  const unk = await swapBackWithdrawnBase({ baseMint: MINT, preRaw: null, expectedRaw: 1n }, closeHarness({ balances: [1], swapResults: [] }));
  assert.equal(unk.exposure.unsold_raw, "0");

});

test("close swap-backs ask for the close price-impact cap; a refusal above it stays exposure, logged with the impact", async () => {
  const calls = [];
  const logs = [];
  const h = closeHarness({ balances: [721233237], swapResults: [{ success: false, price_impact_refused: true, price_impact_pct: 31.2, max_price_impact_pct: 25, price_impact_cap_key: "maxCloseSwapPriceImpactPct", error: "Swap refused: price impact 31.20% exceeds maxCloseSwapPriceImpactPct 25%" }] });
  const swap = h.swap;
  h.swap = async (a, opts) => { calls.push(opts); return swap(a); };
  h.log = (cat, msg) => logs.push({ cat, msg });
  const r = await swapBackWithdrawnBase({ baseMint: MINT, symbol: "BAG", preRaw: 0n, expectedRaw: 721233237n }, h);
  assert.deepEqual(calls, [{ impactCap: "close" }], "one attempt, with the close cap; no retries");
  assert.equal(r.exposureFlag, true);
  assert.equal(r.exposure.unsold_raw, "721233237");
  assert.equal(r.swapOutcome.price_impact_refused, true);
  assert.equal(r.swapOutcome.price_impact_pct, 31.2);
  assert.equal(r.swapOutcome.max_price_impact_pct, 25);
  assert.ok(logs.some((l) => l.cat === "close_warn" && /REFUSED on price impact: 31\.2% > maxCloseSwapPriceImpactPct 25% for 721\.233237 BAG.*success_with_exposure/.test(l.msg)));

  // Under the close cap (e.g. the live 5.307% exit), the swap-back simply succeeds.
  const ok = await swapBackWithdrawnBase({ baseMint: MINT, preRaw: 0n, expectedRaw: 721233237n }, closeHarness({ balances: [721233237, 0], swapResults: [{ success: true, tx: "S" }] }));
  assert.equal(ok.exposureFlag, false);
});

test("the LLM can't change either price-impact cap through update_config", async () => {
  const { config } = await import("../config.js");
  const before = { ...config.risk };
  const r = await executeTool("update_config", { changes: { maxSwapPriceImpactPct: 50, maxCloseSwapPriceImpactPct: 90 }, reason: "test" });
  assert.equal(r.success, false);
  assert.deepEqual(r.unknown.sort(), ["maxCloseSwapPriceImpactPct", "maxSwapPriceImpactPct"]);
  assert.equal(config.risk.maxSwapPriceImpactPct, before.maxSwapPriceImpactPct);
  assert.equal(config.risk.maxCloseSwapPriceImpactPct, 25);
});

// ─── state.js persistence ──────────────────────────────────────

test("state records a close exposure, finds it for 2h only, and books agent swaps", () => {
  state.trackPosition({ position: "POSX", pool: "POOL", pool_name: "TEST-SOL", strategy: "spot", amount_sol: 1, active_bin: 1, bin_step: 100, base_mint: MINT });
  const t0 = Date.parse("2026-09-26T10:00:00Z");
  const rec = state.recordCloseExposure("POSX", { mint: MINT, decimals: DEC, pre_raw: "0", unsold_raw: "1000000", ambiguous: true }, { now: t0 });
  assert.equal(rec.ambiguous_until, new Date(t0 + AMBIGUOUS_SWAP_WINDOW_MS).toISOString());
  assert.equal(state.findRecentCloseExposure(MINT, { now: t0 + 60_000 }).position, "POSX");
  assert.equal(state.findRecentCloseExposure(OTHER, { now: t0 + 60_000 }), null);
  assert.equal(state.findRecentCloseExposure(MINT, { now: t0 + CLOSE_EXPOSURE_WINDOW_MS + 1 }), null, "expires after 2h");

  state.noteAgentExposureSwap("POSX", { soldRaw: "400000" });
  state.noteAgentExposureSwap("POSX", { soldRaw: "100000" });
  assert.equal(state.findRecentCloseExposure(MINT, { now: t0 + 60_000 }).agent_sold_raw, "500000");
  state.noteAgentExposureSwap("POSX", { ambiguous: true }, { now: t0 + 120_000 });
  assert.equal(state.findRecentCloseExposure(MINT, { now: t0 + 120_000 }).ambiguous_until, new Date(t0 + 120_000 + AMBIGUOUS_SWAP_WINDOW_MS).toISOString());
});

// ─── executeTool integration ───────────────────────────────────

test("executeTool blocks LLM swaps of unrelated tokens and SOL buys before swapToken runs", async () => {
  const unrelated = await executeTool("swap_token", { input_mint: OTHER, output_mint: "SOL", amount: 5 });
  assert.equal(unrelated.blocked, true);
  assert.match(unrelated.reason, /no unsold exposure/);
  const buy = await executeTool("swap_token", { input_mint: "SOL", output_mint: MINT, amount: 0.5 });
  assert.equal(buy.blocked, true);
  assert.match(buy.reason, /may not buy tokens with SOL/);
});

test("owner-initiated (manual) swap_token skips the agent guard (DRY_RUN sends nothing)", async () => {
  const r = await executeTool("swap_token", { input_mint: OTHER, output_mint: "SOL", amount: 5 }, { manual: true });
  assert.equal(r.blocked, undefined);
  assert.equal(r.dry_run, true);
});
