#!/usr/bin/env node
/**
 * Hybrid-shape MAINNET SIMULATION harness. Never signs, never sends.
 *
 *   node scripts/hybrid-sim.js [--env <path/.env>] [--payer <pubkey>] [--sol 1] [--bid-ask-pct 60]
 *        [--pools addr:bins,addr:bins,...] [--out <report.md>] [--json <out.json>]
 *
 * For each pool it builds the REAL hybrid deploy transactions (tools/hybrid-build.js, the same
 * builders deployPosition uses) with a throwaway generated position keypair and a fee payer that
 * is a funded wallet that is NOT ours, then runs simulateTransaction({ sigVerify:false,
 * replaceRecentBlockhash:true }) and reads back the post-state of the payer and every bin array
 * in the range. Per-bin on-chain deltas (post - pre of each bin's amountY) are compared with the
 * SDK's per-leg distribution math to show the combined shape is Bid-Ask + Spot.
 *
 *   - <=69 bins: the single atomic tx (initialize + Bid-Ask + Spot) is simulated directly, next to a
 *     pure Bid-Ask baseline tx so the CU / size cost of the second layer is visible.
 *   - wide: createExtendedEmptyPosition txs cannot be chained in simulation (each needs the previous
 *     state), so the FIRST create tx is simulated for real; each per-chunk dual-leg tx needs the
 *     extended position to exist, so it is simulated through a "chunk twin": a standard 70-bin
 *     position initialised over exactly that chunk's bins is prepended in the same simulated tx.
 *     The deposit instructions (both layers, merged exactly as deployPosition merges them) are
 *     the real ones; only the position's creation differs (documented in the report).
 *
 * Only RPC_URL / HELIUS_API_KEY are read from the env file (dotenv.parse; the file is never loaded
 * into process.env). WALLET_PRIVATE_KEY is never read.
 */
import fs from "fs";
import dotenv from "dotenv";
import BN from "bn.js";
import { Connection, PublicKey, Keypair, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { splitHybridLamports } from "../hybrid-mix.js";
import { buildHybridStandardTx } from "../tools/hybrid-build.js";
import { legacyTxSize, MAX_TX_BYTES } from "../tools/tx-send.js";

const args = process.argv.slice(2);
const arg = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const WSOL = "So11111111111111111111111111111111111111112";
const envPath = arg("env", "/Users/frankciafardini/Projects/meridian/.env");
const SOL = Number(arg("sol", "1"));
const BID_ASK_PCT = Number(arg("bid-ask-pct", "60"));
const OUT = arg("out", "/Users/frankciafardini/.aside/u/0/sessions/2026-10-24_pYniY4tjawKnwzoA/artifacts/meridian-review/hybrid-test-report.md");
// Default: 2 narrow (<=69 bins, bin step 80) + 1 wide (bin step 100, 161 bins). All SOL-quoted (token Y = SOL).
const DEFAULT_POOLS = "31viZ3y3pWyiH6dC1G3NpHSDkgtLeX7hUSVQutu2F65S:69,C8Gr6AUuq9hEdSYJzoEpNcdjpojPZwqG5MtQbeouNNwg:69,AG1EhPjsBrkxQWkViuLXF6pQnHwfr9f9sdNneeoykcEJ:161";
const POOLS = arg("pools", DEFAULT_POOLS).split(",").map((s) => { const [a, n] = s.split(":"); return { address: a, bins: Number(n) }; });
// Public wallets known to hold large SOL balances (exchange hot wallets). Only used as a simulated fee payer.
const PAYER_CANDIDATES = [arg("payer"), "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9", "2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS"].filter(Boolean);

function rpcUrl() {
  if (process.env.HYBRID_SIM_RPC_URL) return process.env.HYBRID_SIM_RPC_URL;
  const env = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {};
  if (env.RPC_URL) return env.RPC_URL;
  if (env.HELIUS_API_KEY) return `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
  throw new Error("no RPC_URL / HELIUS_API_KEY in env file");
}
const short = (k) => { const s = String(k); return `${s.slice(0, 4)}…${s.slice(-4)}`; };
const redact = (s) => String(s).replace(/https?:\/\/[^\s"')]+/g, "<rpc>").replace(/api-key=[\w-]+/g, "api-key=<redacted>");

function decodeErr(err, idl) {
  const ie = err?.InstructionError;
  if (!ie) return JSON.stringify(err);
  const [idx, e] = ie;
  if (e?.Custom != null) { const hit = (idl?.errors || []).find((x) => x.code === e.Custom); return `ix ${idx}: Custom ${e.Custom}${hit ? ` ${hit.name} (${hit.msg})` : ""}`; }
  return `ix ${idx}: ${JSON.stringify(e)}`;
}

async function simulate(conn, tx, accounts) {
  const body = {
    jsonrpc: "2.0", id: 1, method: "simulateTransaction",
    params: [tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
      { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: accounts.map(String) } }],
  };
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((res) => setTimeout(res, 600 * (attempt + 1))); // be gentle: this RPC is shared with the live bot
    // pre-state read immediately before the simulation (a live pool moves between reads; keep the gap to ~1 round trip)
    const pre = await conn.getMultipleAccountsInfo(accounts.map((a) => new PublicKey(a)), "confirmed");
    const r = await fetch(conn.rpcEndpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 429) continue;
    const j = await r.json();
    if (j.error) throw new Error(`RPC: ${redact(JSON.stringify(j.error))}`);
    return { ...j.result.value, pre };
  }
  throw new Error("RPC: 429 after retries");
}

const isCuLimit = (ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2;
const withCu = (tx, units = 1_400_000) => { // exactly one CU-limit ix (a duplicate is rejected by the runtime)
  tx.instructions = tx.instructions.filter((ix) => !isCuLimit(ix));
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units }));
  return tx;
};
const freshTx = (payer, ixs) => new Transaction({ feePayer: payer, blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }).add(...ixs);

async function binDeltas(sdk, pool, lo, hi, simAccounts, pre) {
  const dec = (data) => pool.program.coder.accounts.decode("binArray", data);
  const mapOf = (infos) => {
    const m = new Map();
    infos.forEach((info, i) => {
      if (!info) return;
      const ba = dec(info.data);
      const base = ba.index.toNumber() * 70;
      ba.bins.forEach((b, k) => m.set(base + k, BigInt(b.amountY.toString())));
    });
    return m;
  };
  const post = mapOf(simAccounts.map((a) => (a ? { data: Buffer.from(a.data[0], "base64") } : null)));
  const before = mapOf(pre);
  const out = [];
  for (let b = lo; b <= hi; b++) out.push({ binId: b, delta: (post.get(b) ?? 0n) - (before.get(b) ?? 0n) });
  return out;
}

/** Per-leg expected distribution from the SDK's own strategy math (same calls the chunked path uses). */
function expectedLeg(sdk, pool, strategyType, totalY, lo, hi) {
  const activeId = pool.lbPair.activeId;
  const minD = new BN(lo - activeId), maxD = new BN(hi - activeId);
  const p = sdk.buildLiquidityStrategyParameters(new BN(0), totalY, minD, maxD, new BN(pool.lbPair.binStep), false, new BN(activeId), sdk.getLiquidityStrategyParameterBuilder(strategyType));
  const bins = sdk.toAmountIntoBins(new BN(activeId), minD, maxD, p.deltaX, p.deltaY, p.x0, p.y0, new BN(pool.lbPair.binStep), false);
  const m = new Map();
  bins.forEach((b, i) => m.set(lo + i, BigInt(b.amountY.toString())));
  return m;
}

function table(rows, step) {
  const maxV = rows.reduce((m, r) => (r.total > m ? r.total : m), 1n);
  const bar = (v) => "█".repeat(Math.max(0, Number((v * 24n) / maxV)));
  const lines = ["| bin | Bid-Ask leg (SDK) | Spot leg (SDK) | sum | on-chain Δ (sim) | shape |", "|---:|---:|---:|---:|---:|:--|"];
  rows.filter((_, i) => i % step === 0 || i === rows.length - 1).forEach((r) => lines.push(`| ${r.binId} | ${r.ba} | ${r.sp} | ${r.total} | ${r.chain} | ${bar(r.chain)} |`));
  return lines.join("\n");
}

async function main() {
  const sdk = await import("@meteora-ag/dlmm");
  const DLMM = sdk.default;
  const conn = new Connection(rpcUrl(), "confirmed");
  let payer = null, payerSol = 0;
  for (const c of PAYER_CANDIDATES) {
    const bal = (await conn.getBalance(new PublicKey(c), "confirmed")) / 1e9;
    if (bal >= SOL + 5) { payer = new PublicKey(c); payerSol = bal; break; }
  }
  if (!payer) throw new Error("no funded payer candidate with enough SOL");
  const total = new BN(Math.round(SOL * 1e9));
  const legs = splitHybridLamports(total, BID_ASK_PCT);
  const md = [];
  const P = (s = "") => md.push(s);
  const results = [];

  P("# Hybrid shape: mainnet simulation report");
  P("");
  P(`Generated ${new Date().toISOString()} by \`scripts/hybrid-sim.js\` (branch feat/hybrid-shape). **Nothing was signed or sent**: every transaction was run through \`simulateTransaction\` (sigVerify:false, replaceRecentBlockhash:true) with a throwaway position keypair.`);
  P("");
  P(`- Simulated fee payer (public, NOT ours): \`${payer.toBase58()}\` (${payerSol.toFixed(1)} SOL at run time)`);
  P(`- Deposit: ${SOL} SOL single-sided; mix ${BID_ASK_PCT}% Bid-Ask / ${100 - BID_ASK_PCT}% Spot => legs ${legs.bidAsk.toString()} + ${legs.spot.toString()} = ${legs.bidAsk.add(legs.spot).toString()} lamports`);
  P(`- SDK: @meteora-ag/dlmm 1.9.14; size limit ${MAX_TX_BYTES} bytes`);
  P("");

  for (const spec of POOLS) {
    const poolPk = new PublicKey(spec.address);
    const pool = await DLMM.create(conn, poolPk);
    await pool.refetchStates();
    const idl = pool.program.idl;
    const binStep = Number(pool.lbPair.binStep);
    const activeId = Number(pool.lbPair.activeId);
    if (pool.lbPair.tokenYMint.toBase58() !== WSOL) throw new Error(`${spec.address}: token Y is not SOL`);
    const name = `${short(pool.lbPair.tokenXMint)}-SOL`;
    const minBinId = activeId - (spec.bins - 1), maxBinId = activeId;
    const wide = spec.bins > 69;
    const position = Keypair.generate();
    const common = { pool, StrategyType: sdk.StrategyType, BN, positionPubKey: position.publicKey, user: payer, minBinId, maxBinId, slippage: 5 };
    const covIdx = sdk.getBinArrayIndexesCoverage(new BN(minBinId), new BN(maxBinId));
    const binArrayPks = covIdx.map((i) => sdk.deriveBinArray(poolPk, i, pool.program.programId)[0]);
    const preInfos = await conn.getMultipleAccountsInfo(binArrayPks);
    const missing = covIdx.filter((_, i) => !preInfos[i]).map((i) => i.toString());

    P(`## ${name}  (pool \`${spec.address}\`)`);
    P("");
    P(`bin step ${binStep}, active bin ${activeId}, range ${minBinId}..${maxBinId} = **${spec.bins} bins** (${wide ? "WIDE: chunked path" : "standard: one atomic tx"}), token X program ${pool.tokenX.owner.toBase58() === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" ? "SPL Token" : "Token-2022"}, bin arrays ${covIdx.length} (${missing.length ? `${missing.length} UNINITIALIZED: ${missing.join(",")} (deployPosition would trim the range / refuse; included here so rent is shown)` : "all initialized"})`);
    P("");
    const row = { pool: spec.address, name, bins: spec.bins, binStep, wide };

    const expBA = expectedLeg(sdk, pool, sdk.StrategyType.BidAsk, legs.bidAsk, minBinId, maxBinId);
    const expSP = expectedLeg(sdk, pool, sdk.StrategyType.Spot, legs.spot, minBinId, maxBinId);
    let deltas = null;

    if (!wide) {
      const built = await buildHybridStandardTx({ ...common, legs });
      const base = await pool.initializePositionAndAddLiquidityByStrategy({ positionPubKey: position.publicKey, user: payer, totalXAmount: new BN(0), totalYAmount: total, strategy: { minBinId, maxBinId, strategyType: sdk.StrategyType.BidAsk }, slippage: 5 });
      if (!built.tx) { P(`**Merged tx does not fit**: ${built.reason}. deployPosition would fall back to the chunked path.`); row.fits = false; results.push(row); continue; }
      const tx = withCu(built.tx);
      const baseTx = withCu(freshTx(payer, base.instructions.filter((i) => i.programId.toBase58() !== ComputeBudgetProgram.programId.toBase58())));
      const accts = [payer, position.publicKey, ...binArrayPks];
      const sim = await simulate(conn, tx, accts);
      const baseSim = await simulate(conn, baseTx, accts);
      const size = legacyTxSize(tx), baseSize = legacyTxSize(baseTx);
      P(`| tx | size (bytes) | CU consumed | result |`);
      P(`|:--|---:|---:|:--|`);
      P(`| **hybrid** (init + Bid-Ask + Spot, 1 tx) | ${size} (+52 for CU ixs) | ${sim.unitsConsumed ?? "n/a"} | ${sim.err ? "ERROR " + decodeErr(sim.err, idl) : "OK"} |`);
      P(`| baseline pure Bid-Ask (init + add, 1 tx) | ${baseSize} | ${baseSim.unitsConsumed ?? "n/a"} | ${baseSim.err ? "ERROR " + decodeErr(baseSim.err, idl) : "OK"} |`);
      P("");
      Object.assign(row, { size, cu: sim.unitsConsumed, err: sim.err ? decodeErr(sim.err, idl) : null, baseCu: baseSim.unitsConsumed, baseSize, baseErr: baseSim.err ? decodeErr(baseSim.err, idl) : null, txs: 1 });
      if (!sim.err) {
        row.positionRentSol = (sim.accounts[1]?.lamports ?? 0) / 1e9;
        deltas = await binDeltas(sdk, pool, minBinId, maxBinId, sim.accounts.slice(2), sim.pre.slice(2));
      }
      row.logs = (sim.logs || []).filter((l) => /Instruction:|consumed|failed|Error/i.test(l)).slice(-14);
    } else {
      // 1) real create txs (first one simulated for real)
      const createTxs = await pool.createExtendedEmptyPosition(minBinId, maxBinId, position.publicKey, payer);
      const createArr = Array.isArray(createTxs) ? createTxs : [createTxs];
      const csim = await simulate(conn, withCu(createArr[0]), [payer, position.publicKey]);
      P(`Create phase: \`createExtendedEmptyPosition\` returns **${createArr.length} tx(s)**; tx 1 simulated: size ${legacyTxSize(createArr[0])} bytes, CU ${csim.unitsConsumed ?? "n/a"}, ${csim.err ? "ERROR " + decodeErr(csim.err, idl) : "OK"}. Later create txs (and every add tx) depend on the position existing, which a simulation cannot persist, so they are not chained.`);
      P("");
      Object.assign(row, { createTxs: createArr.length, createCu: csim.unitsConsumed, createErr: csim.err ? decodeErr(csim.err, idl) : null });
      // 2) the chunked path sends the Bid-Ask layer's chunk txs, reconciles, then the Spot layer's (two sets, NOT merged:
      //    a merged chunk would need ~1.37M CU / ~1.15 KB). A simulation cannot create the extended position, so each
      //    layer's chunk tx is simulated through a "twin": a standard position initialised over that chunk's bins is
      //    prepended in the same simulated tx. The deposit instructions are the SDK's real chunk txs.
      const chunkRanges = sdk.chunkBinRange(minBinId, maxBinId);
      const layerTxs = {};
      for (const [k, st, amt] of [["bidAsk", sdk.StrategyType.BidAsk, legs.bidAsk], ["spot", sdk.StrategyType.Spot, legs.spot]]) {
        const r = await pool.addLiquidityByStrategyChunkable({ positionPubKey: position.publicKey, user: payer, totalXAmount: new BN(0), totalYAmount: amt, strategy: { minBinId, maxBinId, strategyType: st }, slippage: 5 });
        layerTxs[k] = Array.isArray(r) ? r : [r];
      }
      P(`Add phase: **${layerTxs.bidAsk.length} chunk tx(s) per layer** = ${layerTxs.bidAsk.length + layerTxs.spot.length} add txs (Bid-Ask layer first, then Spot layer).`);
      P("");
      P("| chunk | bins | Bid-Ask layer twin-sim (CU / size) | Spot layer twin-sim (CU / size) | est. merged CU (why layers are not merged) |");
      P("|---:|:--|:--|:--|---:|");
      row.chunks = [];
      const perLayer = { bidAsk: new Map(), spot: new Map() };
      for (let i = 0; i < layerTxs.bidAsk.length; i++) {
        const r = chunkRanges[i];
        const layerTxt = {};
        const rec = { i: i + 1, bins: `${r.lowerBinId}..${r.upperBinId}`, layers: {} };
        for (const k of ["bidAsk", "spot"]) {
          const twinPos = Keypair.generate();
          const initIx = await pool.program.methods.initializePosition(r.lowerBinId, r.upperBinId - r.lowerBinId + 1).accountsPartial({ payer, position: twinPos.publicKey, lbPair: poolPk, owner: payer, rent: new PublicKey("SysvarRent111111111111111111111111111111111") }).instruction();
          const swapPk = (ix) => { ix.keys = ix.keys.map((kk) => (kk.pubkey.equals(position.publicKey) ? { ...kk, pubkey: twinPos.publicKey } : kk)); return ix; };
          const ixs = [initIx, ...layerTxs[k][i].instructions.filter((x) => x.programId.toBase58() !== ComputeBudgetProgram.programId.toBase58()).map(swapPk)];
          const tx = withCu(freshTx(payer, ixs));
          const size = legacyTxSize(tx);
          let sim = null; let err;
          try { sim = await simulate(conn, tx, [payer, twinPos.publicKey, ...binArrayPks]); err = sim.err ? decodeErr(sim.err, idl) : null; } catch (e) { err = String(e.message).slice(0, 120); }
          layerTxt[k] = err ? `ERROR ${err}` : `${sim?.unitsConsumed} / ${size} B`;
          rec.layers[k] = { cu: sim?.unitsConsumed ?? null, size, err };
          if (sim && !sim.err) {
            const d = await binDeltas(sdk, pool, r.lowerBinId, r.upperBinId, sim.accounts.slice(2), sim.pre.slice(2));
            d.forEach((x) => perLayer[k].set(x.binId, x.delta));
          }
        }
        const est = (rec.layers.bidAsk.cu ?? 0) + (rec.layers.spot.cu ?? 0);
        P(`| ${i + 1}/${layerTxs.bidAsk.length} | ${r.lowerBinId}..${r.upperBinId} | ${layerTxt.bidAsk} | ${layerTxt.spot} | ${est} |`);
        row.chunks.push(rec);
      }
      P("");
      deltas = [];
      for (let b = minBinId; b <= maxBinId; b++) if (perLayer.bidAsk.has(b) && perLayer.spot.has(b)) deltas.push({ binId: b, delta: perLayer.bidAsk.get(b) + perLayer.spot.get(b) });
      row.txs = createArr.length + layerTxs.bidAsk.length + layerTxs.spot.length;
    }

    if (deltas && deltas.length) {
      const rows = deltas.map((d) => { const ba = expBA.get(d.binId) ?? 0n, sp = expSP.get(d.binId) ?? 0n; return { binId: d.binId, ba, sp, total: ba + sp, chain: d.delta }; });
      const sumChain = rows.reduce((s, r) => s + r.chain, 0n), sumExp = rows.reduce((s, r) => s + r.total, 0n);
      const maxDiff = rows.reduce((m, r) => { const d = r.chain > r.total ? r.chain - r.total : r.total - r.chain; return d > m ? d : m; }, 0n);
      const monotone = rows.filter((r) => r.binId < activeId).every((r, i, a) => i === 0 || a[i - 1].chain >= r.chain);
      const floor = rows.reduce((m, r) => (r.chain < m ? r.chain : m), rows[0].chain);
      P(`Per-bin distribution (every ${Math.max(1, Math.round(rows.length / 14))}th bin; bins at/below the active bin ${activeId}; amounts in lamports of SOL):`);
      P("");
      P(table(rows, Math.max(1, Math.round(rows.length / 14))));
      P("");
      const noisy = rows.filter((x) => { const d = x.chain > x.total ? x.chain - x.total : x.total - x.chain; return d * 1000n > x.total; }).map((x) => x.binId);
      P(`- on-chain total Δ = **${sumChain}** lamports vs deposit ${total.toString()} (SDK sum of both legs = ${sumExp}); max per-bin |on-chain − (BidAsk+Spot)| = **${maxDiff}** lamports`);
      if (noisy.length) P(`- bins whose on-chain Δ differs from the SDK math by >0.1% (live pool activity between the pre-read and the simulation, mostly the active bin): ${noisy.join(", ")}`);
      P(`- Bid-Ask-like tilt (non-increasing toward the active bin): **${monotone}**; smallest bin = ${floor} lamports (> 0 means the Spot floor lifts every bin, i.e. the combined shape is Bid-Ask + Spot, not pure Bid-Ask)`);
      P("");
      Object.assign(row, { sumChain: sumChain.toString(), sumExp: sumExp.toString(), maxDiff: maxDiff.toString(), monotone, floor: floor.toString() });
    }
    if (row.positionRentSol != null) P(`- position account rent (simulated post-state lamports): **${row.positionRentSol.toFixed(5)} SOL**, refundable on close; bin-array rent: ${missing.length ? "NOT refundable, see above" : "none (all arrays already initialized)"}`);
    if (row.logs?.length) { P(""); P("<details><summary>last program logs</summary>\n\n```"); row.logs.forEach((l) => P(l)); P("```\n</details>"); }
    P("");
    results.push(row);
  }

  P("## Findings");
  P("");
  P("- Design: `initialize_position` + Bid-Ask `add_liquidity_by_strategy2` + Spot `add_liquidity_by_strategy2` share ONE transaction (instruction-level merge), so the narrow path is atomic and costs a single fee. The wide path creates the extended position first, then sends the Bid-Ask layer's chunk txs, reconciles them on-chain, then the Spot layer's.");
  P("- Not covered by simulation (cannot be, simulation cannot persist state): chaining wide create txs 2..N, and the chunk txs against the REAL extended position (twin position used instead).");
  fs.mkdirSync(OUT.replace(/\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(OUT, md.join("\n"));
  if (arg("json")) fs.writeFileSync(arg("json"), JSON.stringify(results, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`report written: ${OUT}`);
  console.log(JSON.stringify(results.map((r) => ({ name: r.name, bins: r.bins, cu: r.cu, baseCu: r.baseCu, size: r.size, err: r.err, maxDiff: r.maxDiff, monotone: r.monotone, chunks: r.chunks?.map((c) => [c.cu, c.err]) })), null, 1));
}

main().catch((e) => { console.error("hybrid-sim failed:", redact(e.stack || e.message)); process.exit(1); });
