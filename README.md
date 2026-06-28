# Meridian

Autonomous Meteora DLMM liquidity management agent for Solana.

Meridian screens pools, deploys capital, manages open positions, records lessons, and can evolve both thresholds and prompt behavior over time. It is designed to run continuously with a web dashboard, REPL, and optional Telegram control surface.

## What It Runs

Meridian has three LLM-facing agent roles:

| Agent | Purpose | Typical schedule |
| --- | --- | --- |
| `SCREENER` | Finds candidates, studies pools, decides whether to deploy | every `screeningIntervalMin` |
| `MANAGER` | Reviews live positions, claims fees, closes or holds | every `managementIntervalMin` |
| `GENERAL` | Chat and command handling | on demand |

There is also an autoresearch subsystem that tests prompt changes after real closes and keeps or reverts them based on later performance.

## LLM Providers

Meridian supports five provider modes. Set via `LLM_PROVIDER` in `.env` or `llmProvider` in `user-config.json`:

| Provider | How it works | Auth | Cost |
| --- | --- | --- | --- |
| `claude` | Runs model turns through `claude -p` (Claude Code CLI) | OAuth login (`claude` CLI) | Uses your Claude Pro/Max subscription |
| `codex` | Runs model turns through `codex exec` (Codex CLI) | OAuth login (`codex login`) | Uses your Codex/OpenAI subscription |
| `openrouter` | Direct HTTP API calls to any model | `OPENROUTER_API_KEY` | Pay-per-token via OpenRouter |
| `deepseek` | Direct HTTP API calls | `DEEPSEEK_API_KEY` | Pay-per-token via DeepSeek |
| `minimax` | Direct HTTP API calls to MiniMax's OpenAI-compatible API | `MINIMAX_API_KEY` | Uses your MiniMax Token Plan or pay-as-you-go key |

### Claude Provider (recommended)

Uses `claude -p` (Claude Code print mode) with your existing Claude subscription. No API key billing — runs on your OAuth login. Supports per-role model selection:

```json
{
  "llmProvider": "claude",
  "screeningModel": "opus",
  "managementModel": "haiku",
  "generalModel": "sonnet",
  "autoresearchModel": "opus"
}
```

Available model aliases: `opus` (Opus 4.6), `sonnet` (Sonnet 4.6), `haiku` (Haiku 4.5).

### Codex Provider

Uses `codex exec` with your OpenAI/Codex subscription. Same CLI harness pattern as Claude but with OpenAI models.

### OpenRouter Provider

Uses the OpenRouter API to access any model (minimax, qwen, etc.). Requires `OPENROUTER_API_KEY` in `.env`. Good for cheap models like `minimax/minimax-m2.7` or free models like `qwen/qwen3.6-plus:free`.

### MiniMax Provider

Uses MiniMax's OpenAI-compatible API directly at `https://api.minimax.io/v1`. This is the right option if you want to use a MiniMax Token Plan key directly instead of routing MiniMax through OpenRouter.

Typical models:

- `MiniMax-M2.7`
- `MiniMax-M2.7-highspeed`
- `MiniMax-M2.5`

All providers use the same ReAct loop with your custom tools — the provider only affects which LLM processes the prompts.

## Architecture

```
LLM provider -> ReAct loop -> tools -> Meteora / Helius / Jupiter / LP Agent
                  |             |
                  |             +-- wallet, pools, token info, deploy, close, swap
                  |
                  +-- Screener
                  +-- Manager
                  +-- General chat
                  +-- Autoresearch prompt optimizer
```

## Quick Start

### Requirements

- Node.js 18+
- A Solana wallet private key in base58 format
- A Solana RPC URL, ideally Helius
- Codex CLI login if using `codex`
- LP Agent API key if you want LP overview / top LPer study
- Telegram bot token if you want Telegram control and notifications

### Install

```bash
git clone https://github.com/fciaf420/meridian.git
cd meridian
npm install
cd web && npm install && npm run build && cd ..
```

Nuggets (holographic memory) is bundled in `packages/nuggets/` — no separate repo needed.

### Provider Setup

Choose your provider:

**Claude (recommended — uses your Claude subscription):**
```bash
# Make sure claude CLI is installed and logged in
claude --version
```

**Codex (uses your OpenAI/Codex subscription):**
```bash
codex login
```

**OpenRouter (pay-per-token, any model):**
Add `OPENROUTER_API_KEY=sk-or-...` to `.env`

**MiniMax Token Plan (direct MiniMax access):**
Add `MINIMAX_API_KEY=...` to `.env`

Then run:

```bash
npm run setup
```

The setup wizard saves a starter `user-config.json`. It asks for:

- wallet and RPC
- risk preset
- deploy size and limits
- screening and management cadence
- provider selection
- a default model ID
- dry-run vs live mode

### First Dry Run

Before live trading:

```bash
npm run dev
```

This runs the full bot with `DRY_RUN=true`. The agent still screens, manages, chats, updates the dashboard, and runs cron jobs, but real transactions are not broadcast.

When you are satisfied:

```bash
npm start
```

This is live mode.

## Operator Checklist

Before a real run, verify:

- `dryRun` in `user-config.json` is what you expect
- wallet key is set
- RPC URL works
- `llmProvider` is correct
- if using `codex`, `codex login` has already been done on this machine
- the dashboard loads
- the first screening and management cycles complete without errors
- Telegram is registered if you enabled it

## How Config Is Resolved

Meridian uses both `.env` and `user-config.json`.

Resolution order:

1. `.env` is loaded first.
2. `user-config.json` backfills key env values only when the env var is missing.
3. Runtime config is built from `user-config.json`, then env fallbacks, then code defaults.

In practice:

- `rpcUrl` can populate `RPC_URL`
- `walletKey` can populate `WALLET_PRIVATE_KEY`
- `llmProvider` can populate `LLM_PROVIDER`
- `llmModel` can populate `LLM_MODEL`
- `dryRun` can populate `DRY_RUN`

Per-role model precedence:

1. `managementModel` / `screeningModel` / `generalModel`
2. `LLM_MODEL`
3. provider default

So `LLM_MODEL` is only a global fallback. The main live settings are the per-role model fields in `user-config.json`.

## Core Files

- `.env`: secrets and optional overrides
- `user-config.json`: primary runtime settings
- `user-config.example.json`: reference config shape
- `autoresearch.json`: prompt experiment state
- `lessons.json`: performance-derived lessons

## Environment Variables

Typical `.env`:

```env
LLM_PROVIDER=claude
RPC_URL=https://...helius-rpc.com
WALLET_PRIVATE_KEY=your_base58_key
HELIUS_API_KEY=your_helius_key
OPENROUTER_API_KEY=sk-or-...
DEEPSEEK_API_KEY=sk-...
MINIMAX_API_KEY=...
LPAGENT_API_KEY=key1,key2
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=
DRY_RUN=true
```

Notes:

- `LLM_PROVIDER` can be `claude`, `codex`, `openrouter`, `deepseek`, or `minimax`
- `OPENROUTER_API_KEY` is only needed when provider is `openrouter`
- `DEEPSEEK_API_KEY` is only needed when provider is `deepseek`
- `MINIMAX_API_KEY` is only needed when provider is `minimax`
- `claude` and `codex` providers use OAuth login, no API key needed
- `TELEGRAM_CHAT_ID` can be left empty; Meridian can register it automatically
- `DRY_RUN=true` is the safest default until you validate behavior

## Runtime Modes

### Interactive TTY

If you run Meridian in a normal terminal, it starts:

- the web server
- cron jobs
- the PnL watcher
- the REPL

On startup it may preload candidate pools. In that interactive flow:

- entering `1`, `2`, `3`, and so on deploys into the numbered startup candidate
- `go` starts autonomous mode without an immediate manual deploy

### Non-TTY

If Meridian is started without an interactive terminal, it still:

- starts the web server
- starts cron jobs
- starts the PnL watcher

It simply skips the REPL prompt.

### Startup Sequence

On launch Meridian typically:

1. loads env and config
2. initializes Nuggets memory
3. deduplicates lessons
4. restores any active autoresearch experiment
5. starts the web server
6. starts Telegram polling if configured
7. starts the PnL watcher
8. starts management and screening cron cycles

## Scheduler and Concurrency Rules

Meridian is intentionally conservative about overlapping work.

- management and screening cycles do not run on top of each other
- management can defer if another action is already in progress
- screening can skip if max positions are reached
- screening can skip if wallet balance is too low
- management can skip when there are no open positions
- the PnL watcher runs independently from the main cycles

If the bot looks idle, check logs for `skipped`, `deferred`, or balance / max-position guards before assuming it is broken.

## Commands

### REPL

Common commands:

- `1`, `2`, `3` ... deploy into numbered startup candidate
- `go` start autonomous mode without manual deploy
- `/status` show wallet and open positions
- `/candidates` show current top candidates
- `/briefing` show performance briefing
- `/thresholds` show screening thresholds
- `/learn` run pool study
- `/evolve` evolve screening thresholds
- `/stop` graceful shutdown
- `<wallet_address>` inspect another wallet
- free-form text chat with the general agent

### Web UI

The web UI exposes the same chat surface and a command palette.

### Telegram

Telegram supports the same command style once configured.

Important ownership rule:

- the first Telegram chat to message the bot becomes the registered owner
- that chat ID is persisted into `user-config.json`
- messages from other chats are ignored

Telegram can receive:

- deploy notifications
- close notifications
- out-of-range alerts
- PnL watcher auto-close alerts
- management cycle reports
- screening cycle reports
- daily briefing messages

## Web Dashboard

Default dashboard URL:

```text
http://localhost:3737
```

The dashboard is websocket-driven and live-updated. On connect it receives an initial payload, then refreshes wallet, positions, timers, candidates, and activity as the bot runs.

Main areas:

- status bar with timers and wallet state
- chat panel
- dashboard tab for wallet, LP overview, and positions
- candidates tab
- activity tab

If the dashboard does not load in normal bot mode, make sure the frontend was built:

```bash
cd web
npm install
npm run build
cd ..
```

`npm run dev:web` is for frontend development only. It is not required for normal bot operation.

## Market Maker (DLMM Limit Orders)

A standalone, configurable market maker for a single Meteora DLMM pool, built on
Meteora's **DLMM Limit Order** feature. It is independent of the autonomous LP
agent above — run it on its own with `npm run mm`.

### How it works

A DLMM limit order places token liquidity at chosen bins so it behaves like an
on-chain order: a **bid** (token Y placed at/below the active bin) buys the base
token as price falls into it; an **ask** (token X placed at/above the active bin)
sells the base token as price rises into it. The market maker keeps a two-sided
ladder of these orders around the active bin and, as orders fill or price drifts
past the ladder, cancels the stale side (harvesting filled proceeds + unfilled
deposits) and re-quotes recentered on the new active bin.

**Profit model:** `net P&L = bid/ask spread captured + limit-order fee share −
adverse selection − gas`. Filled limit-order liquidity earns a 50% share of the
limit-order portion of swap fees (`LIMIT_ORDER_FEE_SHARE`). The main risk is
adverse selection — a trending market sweeps one side at progressively worse
prices — which is bounded by the spread, inventory caps, and a volatility pause.

> The target pool **must be limit-order-enabled** (`isSupportLimitOrder`). Most
> standard liquidity-mining pools are not; the runner refuses to start otherwise.

### Run it

```bash
# Dry run first — logs intended places/cancels, sends no transactions
npm run mm:dry -- --pool <LIMIT_ORDER_POOL_ADDRESS>

# Live
npm run mm -- --pool <LIMIT_ORDER_POOL_ADDRESS> --mode two_sided --levels 3 --spread-bins 1
```

`RPC_URL` and `WALLET_PRIVATE_KEY` are read from `.env` (same as the agent).
`Ctrl-C` cancels and closes all open orders before exiting, so funds are never
left stranded in orders.

### Config (`config.marketMaker`, all overridable via CLI flags)

| Field (`user-config.json`) | CLI flag | Default | Purpose |
| --- | --- | --- | --- |
| `mmMode` | `--mode` | `two_sided` | `two_sided`, `bid_only`, or `ask_only` |
| `mmLevels` | `--levels` | `3` | Orders (bins) per side |
| `mmSpreadBins` | `--spread-bins` | `1` | Bins from active to the nearest quote (the spread) |
| `mmStepBins` | `--step-bins` | `1` | Bins between successive levels |
| `mmOrderSizeQuote` | `--order-size-quote` | `null` | Quote (Y) per bid order; `null` = 25% of balance |
| `mmOrderSizeBase` | `--order-size-base` | `null` | Base (X) per ask order; `null` = 25% of balance |
| `mmMaxInventoryBase` | `--max-inventory-base` | `null` | Pause bids once base held ≥ this |
| `mmMaxInventoryQuote` | `--max-inventory-quote` | `null` | Pause asks once quote held ≥ this |
| `mmDriftBins` | `--drift-bins` | `2` | Requote when active drifts > this from ladder center |
| `mmRequoteFillPct` | `--requote-fill-pct` | `50` | Requote a side once it is ≥ this % filled |
| `mmVolatilityPauseBins` | `--volatility-pause-bins` | `null` | Pull quotes if active jumps > this in one tick |
| `mmMaxActiveBinSlippage` | `--max-active-bin-slippage` | `3` | On-chain active-bin slippage guard at placement |
| `mmTickIntervalSec` | `--tick` | `15` | Loop interval |
| `mmMinRequoteIntervalSec` | `--min-requote-sec` | `30` | Per-side anti-thrash throttle |

A limit order spans at most 50 bins (`MAX_BIN_PER_LIMIT_ORDER`); the runner
rejects a ladder whose `spreadBins + (levels-1)*stepBins + 1` exceeds that.

### Inventory skew (no perp hedge)

Unlike order-book market makers (e.g. Wagyu on Hyperliquid) that stay delta-neutral
by hedging inventory with a **short perp**, this MM does **not** use perps. Instead it
manages inventory in software: hard caps (`maxInventoryBase/Quote`), a volatility pause,
configurable spread, and **inventory skew**. When the book gets heavy on one asset, the
ladder is biased to unwind it — heavy base → asks move closer + larger and bids move
further + smaller (mirrored when heavy quote) — mean-reverting toward `targetBaseRatio`
(0.5 = balanced by value). Tune with `inventorySkew` (on/off), `targetBaseRatio`,
`maxSkewBins`, `maxSkewSizePct`.

### Per-pool config file

Settings live per pool in `market-maker-config.json` (gitignored, user-specific):

```json
{ "pools": { "<POOL_ADDRESS>": { "label": "SOL/USDC", "mode": "two_sided", "levels": 4, "spreadBins": 2 } } }
```

Resolution order is **global defaults (`config.marketMaker`) ← per-pool file ← CLI/UI
overrides**, so a pool entry only sets what differs. Both the CLI (`--pool`) and the
control panel read and write this file, so they share configuration.

### Control panel UI (standalone)

A self-contained web panel — **independent of the agent dashboard** (its own server +
page, own port, no shared code):

```bash
DRY_RUN=true npm run mm:panel:dry      # simulated
npm run mm:panel                        # live
# → open http://127.0.0.1:3838
```

The panel lets you create/edit/delete per-pool configs, **Start/Stop** a market maker
per pool (each runs as its own in-process loop), and watch **live status** (active bin,
open bid/ask orders, requote count, skew strength, uptime). Env: `MM_PANEL_PORT`
(default 3838), `MM_PANEL_HOST` (default `127.0.0.1`), and an optional `MM_PANEL_TOKEN`
— if set, mutating actions require the matching `x-mm-token` (enter it in the panel's
token field). On shutdown the panel stops every running loop, which cancels and closes
all open orders.

## Configuration Reference

Everything in `user-config.json` is optional, but these are the main knobs.

### Core Live-Run Fields

| Field | Purpose |
| --- | --- |
| `rpcUrl` | Solana RPC URL |
| `walletKey` | Solana wallet private key |
| `dryRun` | Simulate or trade live |
| `llmProvider` | `claude`, `codex`, `openrouter`, `deepseek`, or `minimax` |
| `managementModel` | manager model |
| `screeningModel` | screener model |
| `generalModel` | chat model |
| `autoresearchModel` | prompt-optimizer model |

### Screening

| Field | Meaning |
| --- | --- |
| `minFeeActiveTvlRatio` | minimum fee / active TVL |
| `minTvl`, `maxTvl` | TVL bounds |
| `minVolume` | minimum pool volume |
| `minOrganic` | minimum organic score |
| `minHolders` | minimum holder count |
| `minMcap`, `maxMcap` | market-cap bounds |
| `minBinStep`, `maxBinStep` | bin-step bounds |
| `maxVolatility` | volatility ceiling |
| `maxPriceChangePct` | price-change ceiling |
| `timeframe` | screening timeframe |
| `category` | discovery bucket |
| `minTokenFeesSol` | anti-bundle / anti-spam floor |
| `athTopThresholdPct` | ATH proximity threshold |

### Management

| Field | Meaning |
| --- | --- |
| `deployAmountSol` | baseline SOL per deploy |
| `maxPositions` | maximum concurrent positions |
| `minSolToOpen` | minimum wallet balance to allow new deploy |
| `gasReserve` | reserve left for gas |
| `positionSizePct` | dynamic sizing fraction |
| `minClaimAmount` | minimum amount worth claiming |
| `outOfRangeBinsToClose` | OOR threshold in bins |
| `outOfRangeWaitMinutes` | OOR hold time before action |
| `minVolumeToRebalance` | minimum volume to justify rebalance logic |
| `emergencyPriceDropPct` | emergency-drop cutoff |
| `stopLossPct` | stop-loss threshold |
| `takeProfitFeePct` | take-profit threshold |
| `trailingTakeProfit` | enable trailing exits |
| `trailingTriggerPct` | trailing activation point |
| `trailingDropPct` | trailing giveback threshold |
| `priorityFeeLevel` | transaction fee preset |
| `pnlUnit` | `sol` or `usd` display |

### Scheduling

| Field | Meaning |
| --- | --- |
| `managementIntervalMin` | management cycle cadence |
| `screeningIntervalMin` | screening cycle cadence |
| `healthCheckIntervalMin` | health-check cadence |
| `pnlWatcherIntervalSec` | watcher cadence |
| `maxSteps` | max ReAct steps per agent turn |

### LLM

| Field | Meaning |
| --- | --- |
| `temperature` | generation temperature |
| `maxTokens` | max tokens per turn |
| `managementFallbackModel` | optional manager fallback |
| `screeningFallbackModel` | optional screener fallback |
| `generalFallbackModel` | optional general fallback |

### Autoresearch

| Field | Meaning |
| --- | --- |
| `autoresearch` | enable prompt experiments |
| `autoresearchModel` | model used for prompt edits |
| `autoresearchReasoningEffort` | Codex reasoning effort for autoresearch |
| `autoresearchMinCloses` | closes required per trial |
| `autoresearchImprovementPct` | keep threshold |
| `autoresearchDeclinePct` | revert threshold |
| `autoresearchCooldownCloses` | cooldown between experiments |

### Darwinian Weighting

| Field | Meaning |
| --- | --- |
| `darwinianWeights` | enable adaptive signal weights |
| `darwinianWindowDays` | lookback window |
| `darwinianBoostFactor` | positive adjustment multiplier |
| `darwinianDecayFactor` | negative adjustment multiplier |
| `darwinianWeightFloor` | lower bound |
| `darwinianWeightCeiling` | upper bound |
| `darwinianMinSamples` | minimum sample count |

## Learning Systems

### Lessons

Every closed position can produce a structured lesson in `lessons.json`. Lessons are deduplicated and injected into prompts by role.

Prompt budget shape:

- pinned lessons up to 10
- role-matched lessons up to 15
- recent lessons fill the remaining budget up to 35 total

### Nuggets Memory

Nuggets provides persistent cross-session memory in `data/nuggets/`. Meridian uses multiple recall channels during management context building, including pool name, strategy plus bin step, strategy only, volatility bucket, and general lesson recall.

High-hit facts can be promoted into longer-lived memory context. The dashboard also exposes structured nugget stats so the memory system is inspectable, not opaque.

### Threshold Evolution

Meridian can evolve screening thresholds from real performance and lesson history. These changes persist back into `user-config.json`.

### Autoresearch

Autoresearch is prompt optimization driven by real closes.

It:

1. waits until there is enough close history
2. identifies the weakest prompt section
3. proposes one targeted prompt change
4. runs that change over later closes
5. keeps, reverts, or discards it based on trial performance

Current section targets:

- `screener_criteria`
- `manager_logic`
- `range_selection`

Important safeguards:

- it requires a minimum data gate before starting
- if the first 3 trial closes are all losses, it reverts early
- keep / revert uses a composite score based on win rate and average PnL
- kept overrides persist across restarts in `autoresearch.json`

Autoresearch is experimental. Results can be confounded if other adaptive systems, such as Darwinian weighting, also change behavior during the same evaluation window.

## LP Agent and External Data

Meridian uses:

- Meteora DLMM SDK for on-chain positions and transactions
- Meteora discovery / PnL endpoints for pool and position data
- Helius RPC for chain access
- Jupiter for token data and swaps
- LP Agent for overview, history, and top-LPer study

## Project Structure

```text
meridian/
  index.js
  agent.js
  prompt.js
  config.js
  state.js
  lessons.js
  autoresearch.js
  memory.js
  server.js
  telegram.js
  llm-provider.js
  tools/
  web/
```

## Troubleshooting

### "Wallet not configured"

Set either:

- `WALLET_PRIVATE_KEY` in `.env`
- or `walletKey` in `user-config.json`

### Codex provider is selected but calls fail

Verify:

```bash
codex login
codex exec --model gpt-5.4 "Reply with OK"
```

If the direct CLI call fails, Meridian will fail too.

### Dashboard does not load

Build the frontend:

```bash
cd web
npm install
npm run build
cd ..
```

### The bot looks idle

Check for:

- `dryRun`
- max-position guard
- low SOL balance
- deferred management or screening
- no open positions for management

### Telegram bot responds in one chat but not another

Only the first registered chat is accepted. Clear `telegramChatId` in `user-config.json` if you want to rebind ownership.

## Disclaimer

This software is provided as-is, without warranty. Running an autonomous trading agent carries real financial risk and can lose funds. Start in dry run, validate behavior, and size capital conservatively.
