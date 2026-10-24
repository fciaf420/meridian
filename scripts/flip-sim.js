#!/usr/bin/env node
/**
 * Bid-Ask flip MAINNET SIMULATION harness. Never signs, never sends.
 *
 *   node scripts/flip-sim.js --position <pubkey> [--fallback] [--env <path/.env>]
 *        [--fill-pct 0] [--band-top <binId>] [--deposited-sol <n>] [--json <out.json>]
 *        [--last-flip-active <binId> [--flips 1]]   (simulate a re-flip of the fresh tranche only)
 *        [--fallback | --fallback-only]              (also simulate the 2-tx fallback for comparison)
 *
 * Loads the position + pool, plans the flip (by default with fillPct 0 so the
 * mechanics are exercised regardless of the live trigger), builds the atomic
 * rebalance_liquidity instruction(s) with fee payer = the position owner, and
 * runs simulateTransaction({ sigVerify:false, replaceRecentBlockhash:true })
 * reading back post-state for: the owner, the owner's token-X ATA, the owner's
 * WSOL ATA, the position, and every bin array covering the position. Per-bin
 * before/after amounts are decoded from those accounts (position liquidity
 * share × bin amount / bin supply).
 *
 * Only RPC_URL / HELIUS_API_KEY are read from the env file (dotenv.parse; the
 * file is never loaded into process.env and no key material is touched).
 */

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import BN from "bn.js";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  planBidAskFlip, normalizeBins, buildAtomicFlipIxs, buildFallbackFlipTxs, simulateFlipIxs, token2022Blocker, formatFlipPlan,
} from "../tools/bidask-flip.js";

const args = process.argv.slice(2);
const arg = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(`--${k}`);

const envPath = arg("env", "/Users/frankciafardini/Projects/meridian/.env");
const statePath = arg("state", "/Users/frankciafardini/Projects/meridian/state.json");
function rpcUrl() {
  if (process.env.FLIP_SIM_RPC_URL) return process.env.FLIP_SIM_RPC_URL;
  const env = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {};
  if (env.RPC_URL) return env.RPC_URL;
  if (env.HELIUS_API_KEY) return `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
  throw new Error("no RPC_URL / HELIUS_API_KEY in env file");
}
const short = (k) => { const s = String(k); return `${s.slice(0, 4)}…${s.slice(-4)}`; };

function decodeAnchorErr(err, idl) {
  const ie = err?.InstructionError;
  if (!ie) return JSON.stringify(err);
  const [idx, e] = ie;
  if (e?.Custom != null) {
    const hit = (idl?.errors || []).find((x) => x.code === e.Custom);
    return `ix ${idx}: Custom ${e.Custom}${hit ? ` ${hit.name} (${hit.msg})` : ""}`;
  }
  return `ix ${idx}: ${JSON.stringify(e)}`;
}

async function main() {
  const posArg = arg("position");
  if (!posArg) throw new Error("--position <pubkey> required");
  const sdk = await import("@meteora-ag/dlmm");
  const DLMM = sdk.default;
  const spl = await import("@solana/spl-token");
  const conn = new Connection(rpcUrl(), "confirmed");
  const positionPk = new PublicKey(posArg);

  const posInfo = await conn.getAccountInfo(positionPk);
  if (!posInfo) throw new Error("position account not found (closed?)");
  const lbPair = new PublicKey(posInfo.data.subarray(8, 40));
  const pool = await DLMM.create(conn, lbPair);
  await pool.refetchStates();
  const lbPos = await pool.getPosition(positionPk);
  const pd = lbPos.positionData;
  const owner = pd.owner;
  const binStep = Number(pool.lbPair.binStep);
  const activeId = Number(pool.lbPair.activeId);
  const decX = pool.tokenX.mint.decimals;
  const decY = pool.tokenY.mint.decimals;

  let tracked = null;
  try { tracked = JSON.parse(fs.readFileSync(statePath, "utf8")).positions?.[posArg] || null; } catch { /* optional */ }
  const bandTop = arg("band-top") != null ? Number(arg("band-top")) : (tracked?.bin_range?.max ?? Number(pd.upperBinId));
  const bins = normalizeBins(pd.positionBinData);
  const plan = planBidAskFlip({
    bins, activeId, lowerBinId: Number(pd.lowerBinId), upperBinId: Number(pd.upperBinId), bandTop,
    strategy: "bid_ask", binsAbove: 0,
    quoteIsSol: pool.tokenY.publicKey.toBase58() === "So11111111111111111111111111111111111111112",
    decimalsX: decX, decimalsY: decY,
    depositedSol: arg("deposited-sol") != null ? Number(arg("deposited-sol")) : (tracked?.amount_sol ?? null),
    flipState: arg("last-flip-active") != null ? { flips: Number(arg("flips", 1)), last_flip_active_bin: Number(arg("last-flip-active")) } : {}, cfg: { mode: "shadow", fillPct: Number(arg("fill-pct", 0)), reflipStepPct: Number(arg("reflip-step", 20)), minTrancheSol: Number(arg("min-tranche", 0)) },
    exitReason: null, costFloorMult: Number(arg("cost-floor-mult", 0)), tokenBlocker: await token2022Blocker(pool.tokenX),
  });

  const report = {
    position: posArg, pair: `${pool.tokenX.publicKey.toBase58()}/${pool.tokenY.publicKey.toBase58()}`, lbPair: lbPair.toBase58(),
    owner: owner.toBase58(), tracked: !!tracked, binStep, activeId, lowerBinId: Number(pd.lowerBinId), upperBinId: Number(pd.upperBinId),
    width: Number(pd.upperBinId) - Number(pd.lowerBinId) + 1, bandTop, tokenXProgram: pool.tokenX.owner.toBase58(),
    planLine: formatFlipPlan(short(pool.tokenX.publicKey), posArg, plan),
    plan: { action: plan.action, reason: plan.reason, fillPct: plan.fill?.fillPct, depositedSol: plan.fill?.depositedSol, depositedSource: plan.fill?.depositedSource,
      trancheSol: plan.trancheSol, trancheBins: plan.trancheBins, layout: plan.layout, depositX: plan.depositX?.toString(), trancheX: plan.trancheX?.toString(),
      chunks: (plan.chunks || []).map((c) => ({ withdraw: c.withdraw, deposit: c.deposit, bins: c.bins, depositX: c.depositX.toString() })) },
  };
  console.log(report.planLine);
  if (plan.action !== "flip") { finish(report); return; }
  // The owner pays the fee in the simulated tx, so it must be a plain wallet
  // (system-owned, no data). Positions owned by program PDAs (vault bots) can't
  // be simulated this way and aren't representative of this bot anyway.
  const ownerInfo = await conn.getAccountInfo(owner);
  if (!ownerInfo || ownerInfo.owner.toBase58() !== "11111111111111111111111111111111" || ownerInfo.data.length > 0) {
    report.skipped = `owner ${short(owner)} is not a plain wallet (owned by ${ownerInfo?.owner?.toBase58() ?? "nothing"}) — cannot be fee payer`;
    finish(report);
    return;
  }

  // ── accounts to read back ──
  const ataX = spl.getAssociatedTokenAddressSync(pool.tokenX.publicKey, owner, true, pool.tokenX.owner);
  const ataY = spl.getAssociatedTokenAddressSync(pool.tokenY.publicKey, owner, true, pool.tokenY.owner);
  const lo = Number(pd.lowerBinId); const hi = Number(pd.upperBinId);
  const arrIdx = [];
  for (let i = sdk.binIdToBinArrayIndex(new BN(lo)).toNumber(); i <= sdk.binIdToBinArrayIndex(new BN(hi)).toNumber(); i++) arrIdx.push(i);
  const arrKeys = arrIdx.map((i) => sdk.deriveBinArray(lbPair, new BN(i), pool.program.programId)[0]);
  const addrs = [owner, ataX, ataY, positionPk, ...arrKeys];
  const preInfos = await conn.getMultipleAccountsInfo(addrs, "confirmed");

  function decodeState(infos) {
    const [ownerI, ataXI, ataYI, posI, ...arrs] = infos;
    const tok = (i) => (i && i.data?.length >= 72 ? spl.AccountLayout.decode(i.data).amount.toString() : null);
    const wrap = posI ? sdk.wrapPosition(pool.program, positionPk, posI) : null;
    const binArrays = arrs.map((a) => (a ? sdk.decodeAccount(pool.program, "binArray", a.data) : null));
    const perBin = new Map();
    if (wrap) {
      const shares = wrap.liquidityShares();
      const l = wrap.lowerBinId().toNumber();
      shares.forEach((share, k) => {
        const binId = l + k;
        const ai = arrIdx.indexOf(sdk.binIdToBinArrayIndex(new BN(binId)).toNumber());
        const ba = binArrays[ai];
        if (!ba) return;
        const bin = sdk.getBinFromBinArray(binId, ba);
        const s = new BN(share.toString());
        const sup = new BN(bin.liquiditySupply.toString());
        const x = sup.isZero() ? new BN(0) : s.mul(new BN(bin.amountX.toString())).div(sup);
        const y = sup.isZero() ? new BN(0) : s.mul(new BN(bin.amountY.toString())).div(sup);
        perBin.set(binId, { x: BigInt(x.toString()), y: BigInt(y.toString()) });
      });
    }
    return { lamports: ownerI?.lamports ?? null, ataX: tok(ataXI), ataY: tok(ataYI), lower: wrap?.lowerBinId().toNumber(), upper: wrap?.upperBinId().toNumber(), perBin };
  }

  function binDiff(pre, post, lowBin, highBin) {
    const rows = [];
    for (let b = lowBin; b <= highBin; b++) {
      const a = pre.perBin.get(b) || { x: 0n, y: 0n };
      const z = post.perBin.get(b) || { x: 0n, y: 0n };
      rows.push({ binId: b, xBefore: a.x, xAfter: z.x, yBefore: a.y, yAfter: z.y });
    }
    return rows;
  }

  async function simulateAndReport(label, ixs, depRange = null) {
    const sim = await simulateFlipIxs(conn, ixs, owner, { accounts: { encoding: "base64", addresses: addrs.map((k) => k.toBase58()) } });
    const v = sim.value;
    const out = { label, err: v.err ? decodeAnchorErr(v.err, sdk.IDL) : null, cu: v.unitsConsumed ?? null, logsTail: (v.logs || []).slice(-8) };
    if (!v.err && v.accounts) {
      const postInfos = v.accounts.map((a) => (a ? { lamports: a.lamports, data: Buffer.from(a.data[0], "base64") } : null));
      const pre = decodeState(preInfos);
      const post = decodeState(postInfos);
      const rows = binDiff(pre, post, Math.min(pre.lower ?? lo, post.lower ?? lo), Math.max(pre.upper ?? hi, post.upper ?? hi));
      const below = rows.filter((r) => r.binId < plan.activeId);
      const ask = rows.filter((r) => r.binId > plan.activeId);
      const sum = (rs, k) => rs.reduce((s, r) => s + r[k], 0n);
      const askAfter = ask.filter((r) => r.xAfter > 0n);
      // Top-weighting: value (x·P) should rise with bin id across the ask.
      const valueSeries = ask.filter((r) => !depRange || (r.binId >= depRange.minBinId && r.binId <= depRange.maxBinId)).map((r) => Number(r.xAfter) * (1 + binStep / 1e4) ** r.binId);
      let monotone = true;
      for (let i = 1; i < valueSeries.length; i++) if (valueSeries[i] + 1e-6 * valueSeries[i] < valueSeries[i - 1] * 0.999) monotone = false;
      out.post = {
        positionRange: [post.lower, post.upper], rangeUnchanged: pre.lower === post.lower && pre.upper === post.upper,
        solBinsBelowActiveUntouched: below.every((r) => r.yBefore === r.yAfter && r.xBefore === r.xAfter),
        activeBin: rows.find((r) => r.binId === plan.activeId) || null,
        askXBefore: sum(ask, "xBefore").toString(), askXAfter: sum(ask, "xAfter").toString(),
        askYAfter: sum(ask, "yAfter").toString(),
        askBinsWithX: askAfter.length, askTopBin: askAfter.at(-1)?.binId ?? null, askValueTopWeighted: monotone,
        totalYBefore: sum(rows, "yBefore").toString(), totalYAfter: sum(rows, "yAfter").toString(),
        ownerTokenXNetRaw: (BigInt(post.ataX ?? "0") - BigInt(pre.ataX ?? "0")).toString(),
        ownerTokenXAtaExistedBefore: pre.ataX != null,
        ownerWsolAta: [pre.ataY, post.ataY],
        ownerLamportsDelta: post.lamports != null && pre.lamports != null ? post.lamports - pre.lamports : null,
        sampleBins: [...ask.slice(0, 2), ...ask.slice(-3)].map((r) => ({ binId: r.binId, xBefore: r.xBefore.toString(), xAfter: r.xAfter.toString() })),
      };
    }
    return out;
  }

  if (!flag("fallback-only")) {
    report.atomic = { chunks: [] };
    for (const chunk of plan.chunks) {
      try {
        const built = await buildAtomicFlipIxs({ pool, positionPk, positionData: pd, plan, chunk, rentPayer: owner, sdk });
        report.atomic.chunks.push({
          withdraw: chunk.withdraw, deposit: chunk.deposit,
          ixCount: built.ixs.length, rentalCostLamports: built.rentalCostLamports, binArrayCount: built.binArrayCount,
          sdkSim: {
            xWithdrawnNet: built.sim.actualAmountXWithdrawn.toString(), xDepositedNet: built.sim.actualAmountXDeposited.toString(),
            xDepositedGross: built.sim.amountXDeposited.toString(), yDepositedGross: built.sim.amountYDeposited.toString(),
          },
          ...(await simulateAndReport(`atomic chunk [${chunk.withdraw.minBinId}..${chunk.withdraw.maxBinId}]`, built.ixs, chunk.deposit)),
        });
      } catch (e) {
        report.atomic.chunks.push({ withdraw: chunk.withdraw, buildError: e.message || String(e) });
      }
    }
    const cs = report.atomic.chunks;
    report.atomic.ok = cs.length > 0 && cs.every((c) => !c.buildError && !c.err);
    report.atomic.cu = cs.map((c) => c.cu ?? null);
  }
  if (flag("fallback") || flag("fallback-only")) {
    try {
      if (plan.layout !== "global") throw new Error("fallback comparison only for single-tx (global) flips");
      const { removeTxs, addTx } = await buildFallbackFlipTxs({ pool, positionPk, owner, plan, sdk });
      const strip = (tx) => tx.instructions.filter((ix) => ix.programId.toBase58() !== "ComputeBudget111111111111111111111111111111");
      const removeIxs = removeTxs.flatMap(strip);
      report.fallback = { removeTxCount: removeTxs.length };
      report.fallback.removeOnly = await simulateAndReport("fallback remove", removeIxs);
      try {
        // Combining two txs into one for comparison: drop the remove tx's trailing
        // WSOL CloseAccount (unwrap), otherwise the add ix finds user_token_y
        // closed (Anchor 3012 AccountNotInitialized). As separate txs the add is
        // built after the remove lands and re-creates the ATA itself.
        const isClose = (ix) => ix.programId.equals(spl.TOKEN_PROGRAM_ID) && ix.data?.[0] === 9;
        report.fallback.combined = await simulateAndReport("fallback remove+add (as one tx, for comparison)", [...removeIxs.filter((ix) => !isClose(ix)), ...strip(addTx)], plan.deposit);
      } catch (e) {
        report.fallback.combined = { error: e.message };
      }
    } catch (e) {
      report.fallback = { buildError: e.message || String(e) };
    }
  }
  finish(report);
}

function finish(report) {
  const out = arg("json");
  const txt = JSON.stringify(report, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  if (out) fs.writeFileSync(path.resolve(out), txt);
  console.log(txt);
}

main().catch((e) => { console.error("flip-sim failed:", e.stack || e.message); process.exit(1); });
