#!/usr/bin/env node
/**
 * Probe the 6027 InvalidBinArray risk on a REAL extended position (read + simulate only; never signs/sends).
 *
 *   node scripts/hybrid-wide-real-sim.js [--env <.env>] [--sol 0.01] [--widths 90,100,...]
 *
 * 1. Find extended PositionV2 accounts on the Meteora DLMM program by account size (280 + 112*width bytes).
 * 2. Keep SOL-quoted pools whose position can take a single-sided SOL deposit over >=71 bins below the active bin.
 * 3. As the position's OWNER (fee payer, sigVerify:false, replaceRecentBlockhash), simulate the SDK's
 *    addLiquidityByStrategyChunkable for a tiny amount, for the Bid-Ask layer and then the Spot layer, and
 *    report any instruction error (6027 = InvalidBinArray).
 * Only RPC_URL / HELIUS_API_KEY are read from the env file (dotenv.parse). WALLET_PRIVATE_KEY is never read.
 */
import fs from "fs";
import dotenv from "dotenv";
import BN from "bn.js";
import DLMMmod, { StrategyType, chunkBinRange } from "@meteora-ag/dlmm";
import { Connection, PublicKey } from "@solana/web3.js";

const DLMM = DLMMmod.default ?? DLMMmod;
const args = process.argv.slice(2);
const arg = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const envPath = arg("env", "/Users/frankciafardini/Projects/meridian/.env");
const SOL = Number(arg("sol", "0.01"));
const WIDTHS = arg("widths", "80,90,100,110,120,130,140,150,161,175,200").split(",").map(Number);
const MAX_POOLS = Number(arg("max", "6"));
const WSOL = "So11111111111111111111111111111111111111112";
const PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const env = dotenv.parse(fs.readFileSync(envPath));
const url = env.RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
const conn = new Connection(url, "confirmed");
const short = (k) => `${String(k).slice(0, 4)}…${String(k).slice(-4)}`;
const out = [];
const say = (s) => { console.log(s); out.push(s); };

const found = [];
for (const w of WIDTHS) {
  try {
    const accs = await conn.getProgramAccounts(PROGRAM, { dataSlice: { offset: 8, length: 64 }, filters: [{ dataSize: 280 + 112 * w }] });
    say(`width ${w}: ${accs.length} extended accounts of that size`);
    for (const a of accs) found.push({ pubkey: a.pubkey, lbPair: new PublicKey(a.account.data.subarray(0, 32)), owner: new PublicKey(a.account.data.subarray(32, 64)), width: w });
  } catch (e) { say(`width ${w}: ${String(e.message).replace(/https?:\/\/\S+/g, "<rpc>").slice(0, 100)}`); }
  if (found.length >= 40) break;
}
say(`candidates: ${found.length}`);

const pools = new Map();
const results = [];
for (const c of found) {
  if (results.length >= MAX_POOLS) break;
  try {
    const key = c.lbPair.toBase58();
    if (!pools.has(key)) pools.set(key, await DLMM.create(conn, c.lbPair));
    const pool = pools.get(key);
    if (pool.lbPair.tokenYMint.toBase58() !== WSOL) continue; // SOL-quoted only
    const pos = await pool.getPosition(c.pubkey);
    const lower = pos.positionData.lowerBinId, upper = pos.positionData.upperBinId, active = pool.lbPair.activeId;
    const maxBin = Math.min(upper, active - 1);
    if (maxBin - lower + 1 < 71) continue;
    const bal = await conn.getBalance(c.owner);
    results.push({ c, pool, lower, upper, active, maxBin, bal });
  } catch (e) { /* skip */ }
}
say(`usable (SOL-quoted, >=71 bins below active): ${results.length}`);
for (const r of results) {
  const { c, pool, lower, maxBin } = r;
  say(`\nposition ${short(c.pubkey)} pool ${short(c.lbPair)} owner ${short(c.owner)} (owner balance ${(r.bal / 1e9).toFixed(3)} SOL) bins ${lower}..${r.upper} active ${r.active} -> deposit range ${lower}..${maxBin} (${maxBin - lower + 1} bins)`);
  for (const [name, type] of [["bid-ask", StrategyType.BidAsk], ["spot", StrategyType.Spot]]) {
    try {
      const txs = await pool.addLiquidityByStrategyChunkable({ positionPubKey: c.pubkey, user: c.owner, totalXAmount: new BN(0), totalYAmount: new BN(Math.round(SOL * 1e9)), strategy: { minBinId: lower, maxBinId: maxBin, strategyType: type }, slippage: 5 });
      const arr = Array.isArray(txs) ? txs : [txs];
      const ranges = chunkBinRange(lower, maxBin);
      for (let i = 0; i < arr.length; i++) {
        const tx = arr[i];
        const sim = await conn.simulateTransaction(tx, undefined, undefined).catch(async () => null);
        let value = sim?.value;
        if (!value) {
          tx.feePayer = c.owner;
          const raw = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true }).catch((e) => ({ value: { err: `rpc: ${String(e.message).slice(0, 80)}` } }));
          value = raw.value;
        }
        const err = value.err ? JSON.stringify(value.err) : "OK";
        const logs = (value.logs || []).filter((l) => /Error|0x1773|InvalidBinArray|insufficient/i.test(l)).slice(-2).join(" | ");
        say(`  ${name} chunk ${i + 1}/${arr.length} bins ${ranges[i]?.lowerBinId}..${ranges[i]?.upperBinId}: ${err}${value.unitsConsumed ? ` CU ${value.unitsConsumed}` : ""}${logs ? `  [${logs.slice(0, 200)}]` : ""}`);
      }
    } catch (e) { say(`  ${name}: build/sim threw: ${String(e.message).replace(/https?:\/\/\S+/g, "<rpc>").slice(0, 160)}`); }
  }
}
fs.writeFileSync(arg("out", "tmp/hybrid-wide-real-sim.txt"), out.join("\n") + "\n");
