# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Live funds — read first

Meridian signs real Solana transactions. `npm start` (`node index.js`) trades live whenever `DRY_RUN` isn't `"true"`, and both `user-config.json` and `user-config.example.json` ship with `"dryRun": false`. Use `npm run dev` (`DRY_RUN=true`) for anything exploratory. Ask before running a command that could run live: `npm start`, `node index.js` without `DRY_RUN=true`, or scripts that call deploy, close or swap tools. A PreToolUse hook in `.claude/settings.json` enforces this for the entry point.

`DRY_RUN` is checked as the string `=== "true"` in several places (tools/dlmm.js, tools/wallet.js, tools/usdc-mode.js). Any new fund-moving code path needs the same guard.

Swaps go through Jupiter Swap API v2 (`/swap/v2/order` + `/execute`, auto slippage), with the Swap v1 quote/swap path as fallback. An ambiguous `/execute` result (5xx, signature without `Success`) is settled by checking the signature on-chain and must never fall back to v1, which could double-swap.

## Commands

- `npm run dev`: full agent in dry-run mode.
- `npm run test:runtime`: the `node:test` suite (runtime fixes, LPAgent, autoresearch, wallet swaps). Unit-only: every network, RPC and LLM call is mocked.
- `npm run settings` (or Telegram `/settings`): shows the effective config and which file each value comes from. Check it before assuming what the bot is running with.
- `node test/test-usdc-mode.js`: unit tests with plain `assert`. Forces DRY_RUN and has no npm script.
- `npm run test:screen` hits the live Meteora API. `npm run test:agent` runs a real LLM agent loop, which spends API credits, though it's dry-run.
- `npm run lint` (flat config in `eslint.config.js`) has a pre-existing baseline of errors. Judge your change by whether it adds new lint errors, not by a clean run.
- `postinstall` runs `scripts/patch-anchor.js`, which patches `@coral-xyz/anchor` and `@meteora-ag/dlmm` inside `node_modules` for Node 24 ESM. Re-run it if those packages are reinstalled or updated.
- `web/` (Vite dashboard) has its own package.json: `npm run dev:web` / `npm run build:web`. `server.js` serves `web/dist`.

## Config and state

- Resolution order: `.env`, then `user-config.json` (backfills env with `||=`, config.js:20-28), then code defaults. `gmgn-config.json` takes precedence for the GMGN key. All three are gitignored; `.env.example` and `user-config.example.json` are the documented templates.
- The app rewrites `user-config.json` at runtime (threshold evolution, lessons, autoresearch, Telegram chat ID), so expect it to change underneath you.
- Runtime state is JSON in the repo root (state.json, lessons.json, pool-memory.json, and others) and is gitignored. One tracked file is also rewritten at runtime: `autoresearch.json`. Leave its runtime changes out of commits unless asked.
- Memory layers: `pool-memory.json` (history by pool address), `lessons.json` (plus `add_pool_note`) and the knowledge base in `knowledge/`. The nuggets layer was removed, so don't reintroduce free-form model-written memory into the system prompt.
- Telegram: the first chat to message the bot becomes its owner (telegram.js:105).
- `screeningSource` is `meteora` (default), `gmgn` or `both`. `both` (tools/screening-both.js) runs the two in parallel, dedupes to one pool per token, applies the Meteora bin-step/TVL/volatility filters to GMGN-only pools, and ranks `confirmed_by_both` first.

## Prompts and autoresearch

System prompts are built in `prompt.js`. `autoresearch.js` (inspired by karpathy/autoresearch) tests one prompt section at a time as a concurrent A/B experiment: control and candidate arms, at least `autoresearchMinClosesPerArm` (100) closes per arm, and a bootstrap confidence-interval verdict. A passing candidate becomes a proposal that the operator approves with `/autoresearch approve` (Telegram or REPL), unless `autoresearchAutoKeep` is set. Its research direction lives in `autoresearch-program.md`, which is human-edited.

Overrides in `autoresearch.json` → `kept_overrides` apply to the prompt only while autoresearch is enabled. The old overrides are in `quarantined_overrides`: they came from invalid 7-vs-7 experiments. When autoresearch is on, a kept override shadows that section's default in `prompt.js`, so editing the default changes nothing live until the override is reverted (`/autoresearch revert <section>`). Under `activeStrategy: "evil_panda"`, the Evil Panda range text takes precedence over any `range_selection` override. Override text keeps `${deployAmount}` / `${currentBalanceSol}` as literal placeholders, and `fillSectionPlaceholders()` fills them when the prompt is built.

## Git

Work on a feature branch and open a PR against `feature/upstream-merge`, the active line; `main` is updated by merging `feature/upstream-merge` into it. Commits are conventional with scopes, e.g. `feat(screening): ...`, `fix(prompt): ...`.
