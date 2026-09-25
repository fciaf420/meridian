<!--
  EDIT ME. This file is the research direction for Meridian's autoresearch
  generator, the human-written half of the loop (after karpathy/autoresearch's
  program.md). autoresearch.js pastes everything below this comment into the
  generator's system prompt on every run, so write it for the generator.
  Keep it short, and rewrite it whenever the strategy or your priorities change.
  The mechanical limits (protected HARD/MUST/NEVER lines, diff size, eligible
  sections) are enforced in code and don't need restating here.
-->

# Research direction: Evil Panda era (seeded 2026-09, edit freely)

## What the bot does now
- Strategy: Evil Panda, single-sided SOL `spot` with an 80% downside range (bins below the active bin only, `bins_above = 0`).
- Code enforces the entry gate: GMGN token volume24h >= $750k, market cap >= $200k, 5m Supertrend green with price above it. Code also pre-filters low `global_fees_sol` and top-10 holder concentration > 60%.
- Code enforces the exits: the stop loss and trailing take-profit live in pnl-watcher. The Evil Panda exit (positive PnL plus RSI(2) > 90 with BB-upper or MACD confluence) is in the manager prompt.
- So the only thing you edit is the **screener heuristics**: which of the gate-passing candidates the agent picks.

## What we're trying to learn
1. **Simplify first.** The screener text has picked up filters over time. If a rule isn't clearly earning its keep, try removing or loosening it. Equal performance with a shorter prompt is a win.
2. **Avoid the losses that hurt Evil Panda.** For a single-sided-below position, a real loss is price falling through the range (downside OOR, then the stop loss): rugs, dev dumps, exit liquidity. Favor heuristics that separate durable tokens (real narrative, spread-out holders, organic flow, smart-money presence) from pump-and-dump setups.
3. **OOR upside is not the enemy here.** The entry gate requires an uptrend, so price running above the range is an expected outcome, and the SOL is still intact. Don't "fix" it with filters that reject tokens that are going up.

## Don't
- Don't add "skip if the token is up X% in the last hour" style filters. They contradict the Supertrend-green entry requirement, and the old bid_ask-era loop ratcheted one down to 0.5%.
- Don't steer the agent toward two-sided spot or `sol_split_pct < 100`. Evil Panda rejects that in code.
- Don't change range width; it's fixed at 80% for Evil Panda.

## Ideas worth one experiment each
- Drop or relax one narrative requirement and see whether win rate holds.
- Reword the smart-wallet / GMGN confirmation so it's weighed as a signal, not a gate.
- Remove a duplicated instruction (for example, something code already enforces).
