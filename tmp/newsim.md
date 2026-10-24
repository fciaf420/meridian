# Hybrid shape: mainnet simulation report

Generated 2026-10-24T19:39:56.084Z by `scripts/hybrid-sim.js` (branch feat/hybrid-shape). **Nothing was signed or sent**: every transaction was run through `simulateTransaction` (sigVerify:false, replaceRecentBlockhash:true) with a throwaway position keypair.

- Simulated fee payer (public, NOT ours): `5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9` (1548999.0 SOL at run time)
- Deposit: 1 SOL single-sided; mix 60% Bid-Ask / 40% Spot => legs 600000000 + 400000000 = 1000000000 lamports
- SDK: @meteora-ag/dlmm 1.9.14; size limit 1232 bytes

## nxPq…pump-SOL  (pool `31viZ3y3pWyiH6dC1G3NpHSDkgtLeX7hUSVQutu2F65S`)

bin step 80, active bin -290, range -358..-290 = **69 bins** (standard: one atomic tx), token X program Token-2022, bin arrays 2 (all initialized)

| tx | size (bytes) | CU consumed | result |
|:--|---:|---:|:--|
| **hybrid** (init + Bid-Ask + Spot, 1 tx) | 1134 (+52 for CU ixs) | 542753 | OK |
| baseline pure Bid-Ask (init + add, 1 tx) | 980 | 267474 | OK |

Per-bin distribution (every 5th bin; bins at/below the active bin -290; amounts in lamports of SOL):

| bin | Bid-Ask leg (SDK) | Spot leg (SDK) | sum | on-chain Δ (sim) | shape |
|---:|---:|---:|---:|---:|:--|
| -358 | 17142843 | 5797101 | 22939944 | 22939958 | ████████████████████████ |
| -353 | 15900608 | 5797101 | 21697709 | 21697722 | ██████████████████████ |
| -348 | 14658373 | 5797101 | 20455474 | 20455486 | █████████████████████ |
| -343 | 13416138 | 5797101 | 19213239 | 19213250 | ████████████████████ |
| -338 | 12173903 | 5797101 | 17971004 | 17971014 | ██████████████████ |
| -333 | 10931668 | 5797101 | 16728769 | 16728778 | █████████████████ |
| -328 | 9689433 | 5797101 | 15486534 | 15486541 | ████████████████ |
| -323 | 8447198 | 5797101 | 14244299 | 14244305 | ██████████████ |
| -318 | 7204963 | 5797101 | 13002064 | 13002069 | █████████████ |
| -313 | 5962728 | 5797101 | 11759829 | 11759833 | ████████████ |
| -308 | 4720493 | 5797101 | 10517594 | 10517597 | ███████████ |
| -303 | 3478258 | 5797101 | 9275359 | 9275361 | █████████ |
| -298 | 2236023 | 5797101 | 8033124 | 8033125 | ████████ |
| -293 | 993788 | 5797101 | 6790889 | 6790889 | ███████ |
| -290 | 248447 | 5797101 | 6045548 | 6041632 | ██████ |

- on-chain total Δ = **999996019** lamports vs deposit 1000000000 (SDK sum of both legs = 999999474); max per-bin |on-chain − (BidAsk+Spot)| = **3916** lamports
- Bid-Ask-like tilt (non-increasing toward the active bin): **true**; smallest bin = 6041632 lamports (> 0 means the Spot floor lifts every bin, i.e. the combined shape is Bid-Ask + Spot, not pure Bid-Ask)

- position account rent (simulated post-state lamports): **0.04190 SOL**, refundable on close; bin-array rent: none (all arrays already initialized)

<details><summary>last program logs</summary>

```
Program log: Instruction: TransferChecked
Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb consumed 2857 of 1141822 compute units
Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 112 of 1136936 compute units
Program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo consumed 772 of 1134370 compute units
Program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo consumed 238793 of 1371429 compute units
Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 201 of 1132486 compute units
Program log: Instruction: AddLiquidityByStrategy2
Program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo consumed 772 of 869973 compute units
Program log: Instruction: TransferChecked
Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb consumed 2857 of 866551 compute units
Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 112 of 861665 compute units
Program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo consumed 772 of 859099 compute units
Program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo consumed 274920 of 1132285 compute units
Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 118 of 857365 compute units
```
</details>

## DEW9…8WDP-SOL  (pool `AG1EhPjsBrkxQWkViuLXF6pQnHwfr9f9sdNneeoykcEJ`)

bin step 100, active bin -235, range -395..-235 = **161 bins** (WIDE: chunked path), token X program Token-2022, bin arrays 3 (all initialized)

Create phase: `createExtendedEmptyPosition` returns **1 tx(s)**; tx 1 simulated: size 478 bytes, CU 19432, OK. Later create txs (and every add tx) depend on the position existing, which a simulation cannot persist, so they are not chained.

Add phase: **3 chunk tx(s) per layer** = 6 add txs (Bid-Ask layer first, then Spot layer).

| chunk | bins | Bid-Ask layer twin-sim (CU / size) | Spot layer twin-sim (CU / size) | est. merged CU (why layers are not merged) |
|---:|:--|:--|:--|---:|
| 1/3 | -395..-326 | 684554 / 1114 B | 684602 / 1114 B | 1369156 |
| 2/3 | -325..-256 | 682859 / 1114 B | 682857 / 1114 B | 1365716 |
| 3/3 | -255..-235 | 338258 / 1058 B | 338274 / 1058 B | 676532 |

Per-bin distribution (every 12th bin; bins at/below the active bin -235; amounts in lamports of SOL):

| bin | Bid-Ask leg (SDK) | Spot leg (SDK) | sum | on-chain Δ (sim) | shape |
|---:|---:|---:|---:|---:|:--|
| -395 | 7407288 | 2484472 | 9891760 | 9891760 | ████████████████████████ |
| -383 | 6855192 | 2484472 | 9339664 | 9339664 | ██████████████████████ |
| -371 | 6303096 | 2484472 | 8787568 | 8787568 | █████████████████████ |
| -359 | 5751000 | 2484472 | 8235472 | 8235472 | ███████████████████ |
| -347 | 5198904 | 2484472 | 7683376 | 7683376 | ██████████████████ |
| -335 | 4646808 | 2484472 | 7131280 | 7131280 | █████████████████ |
| -323 | 4094712 | 2484472 | 6579184 | 6579184 | ███████████████ |
| -311 | 3542616 | 2484472 | 6027088 | 6027088 | ██████████████ |
| -299 | 2990520 | 2484472 | 5474992 | 5474992 | █████████████ |
| -287 | 2438424 | 2484472 | 4922896 | 4922896 | ███████████ |
| -275 | 1886328 | 2484472 | 4370800 | 4370800 | ██████████ |
| -263 | 1334232 | 2484472 | 3818704 | 3818704 | █████████ |
| -251 | 782136 | 2484472 | 3266608 | 3266608 | ███████ |
| -239 | 230040 | 2484472 | 2714512 | 2714512 | ██████ |
| -235 | 46008 | 2484472 | 2530480 | 2528212 | ██████ |

- on-chain total Δ = **999988052** lamports vs deposit 1000000000 (SDK sum of both legs = 999990320); max per-bin |on-chain − (BidAsk+Spot)| = **2268** lamports
- Bid-Ask-like tilt (non-increasing toward the active bin): **true**; smallest bin = 2528212 lamports (> 0 means the Spot floor lifts every bin, i.e. the combined shape is Bid-Ask + Spot, not pure Bid-Ask)


## Findings

- Design: `initialize_position` + Bid-Ask `add_liquidity_by_strategy2` + Spot `add_liquidity_by_strategy2` share ONE transaction (instruction-level merge), so the narrow path is atomic and costs a single fee. The wide path creates the extended position first, then sends the Bid-Ask layer's chunk txs, reconciles them on-chain, then the Spot layer's.
- Not covered by simulation (cannot be, simulation cannot persist state): chaining wide create txs 2..N, and the chunk txs against the REAL extended position (twin position used instead).