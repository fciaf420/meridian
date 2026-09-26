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
LPAGENT_API_KEY=your_lpagent_key
LPAGENT_RPM=5
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=
TELEGRAM_ALLOWLIST=
DRY_RUN=true
```

Notes:

- `LPAGENT_API_KEY` accepts a comma-separated list, but use a single key. LPAgent's [Terms of Service §7](https://docs.lpagent.io/terms-of-service.md) prohibits creating multiple accounts to circumvent restrictions, so rotating keys from several accounts to get around the rate limit risks termination. If you need more throughput, upgrade the plan (Basic 5, Premium 10, Enterprise 20 requests/min) and set `LPAGENT_RPM` to match. The two-sided spot deploy gate needs a Premium or Enterprise key (`/pools/{id}/top-lpers`); without one, two-sided spot stays blocked.
- `LLM_PROVIDER` can be `claude`, `codex`, `openrouter`, `deepseek`, or `minimax`
- `OPENROUTER_API_KEY` is only needed when provider is `openrouter`
- `DEEPSEEK_API_KEY` is only needed when provider is `deepseek`
- `MINIMAX_API_KEY` is only needed when provider is `minimax`
- `claude` and `codex` providers use OAuth login, no API key needed
- `TELEGRAM_CHAT_ID` should be your own chat id. If it (and `telegramChatId` in user-config) is empty, the first private chat to message the bot is registered once, with a loud warning in the log
- `TELEGRAM_ALLOWLIST` (optional) is a comma-separated list of Telegram user ids allowed to act inside the owner chat; needed when the owner chat is a group
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
2. deduplicates lessons
3. restores any active autoresearch experiment
4. starts the web server
5. starts Telegram polling if configured
6. starts the PnL watcher
7. starts management and screening cron cycles

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

Send `/menu` (or `/start`, or tap the persistent 🏠 Menu button) for the button menu: Status · Positions · Candidates · Wallet · Settings · Bot controls · Trading settings. Views edit the same message in place and have Refresh / Back buttons. Every text command from the REPL still works (`/status`, `/candidates`, `/settings`, `/usdc`, `/autoresearch …`, `/help`, …).

Deploying a candidate (the 🚀 Deploy button, or replying with its number after `/candidates`) opens a short picker in the same message: choose **Bid-Ask** or **Spot** (both single-sided SOL; ✓ marks your configured strategy), then a range: **Auto** (with `rangeDepthMode: "ohlcv"`, the default, the pool's candle-based depth with its basis, e.g. "Auto 62% (1m·full life 5.5h drawdown 48% ×1.3, gmgn)"; otherwise the pool's volatility), **25%**, **50%** or **80%**. `deploy_position` enforces a 35% minimum range and, in ohlcv mode, widens any range shallower than the candle depth, so narrower presets are labelled with the depth they widen to; a preset that would fall under the 20-bin minimum at the pool's bin step is hidden. The confirmation card then shows the strategy, range, approximate bin count and amount. Two-sided spot is not offered. Under `activeStrategy: "evil_panda"` the picker is skipped (fixed Evil Panda spot plan), and in USDC mode only Bid-Ask is offered.

Token lookup: paste a token mint (or send `/token <mint>` / `/lookup <mint>`) and the bot answers with a card instead of sending it to the chat agent. The card lists up to 5 of the token's SOL-quoted Meteora DLMM pools (by fee/active-TVL, then TVL) in the Candidates format, the GMGN token signals (mcap, holders, age, 1h/24h change, smart money / KOL, supertrend / RSI), and ✅/❌ lines for your current screening filters (bin step, TVL, volatility, fee/aTVL, mcap, holders, organic, token age when configured). Each pool has a Deploy button into the same strategy/range picker and confirmation card; a manual entry may proceed when filters fail, and the ❌ lines are repeated on the confirmation card. Every deploy_position safety check still applies, including the bin-step range, max positions and the balance checks. Blacklisted tokens and non-SOL pools get no Deploy button. If GMGN is slow or rate-limited, the card still renders with "GMGN data unavailable"; the lookup is capped at about 15s.

Trading settings (⚙️ Trading settings, from the main menu or Settings): preset buttons for take profit (3–20%), stop loss (−5 to −20% or Off), trailing TP (on/off, trigger 3/5/8/10%, drop 2/3/4/6%), out-of-range wait (5–60 min), deploy size (0.5/1.1/1.5/2 SOL or Custom…, 0.1–10 SOL; sets `deployAmountSol` and `maxDeployAmount` together for a fixed size, and raises `minSolToOpen` to at least size + gas reserve), max positions (1–4) and the PnL watcher interval (15/30/60s). ✅ marks the current value. A tap saves to `user-config.json` and applies to the running bot at once (a new PnL watcher interval reschedules the watcher). Changes that raise risk (stop loss Off or wider, a bigger deploy size, more positions, trailing TP off) need a second tap on a 60s single-use confirm; the rest apply in one tap. Every change shows old → new and is logged. Stop loss Off is stored as `0`. The agent's `update_config` can still change these keys either way.

All settings (⚙️ Settings → 🧾 All settings) is the complete editor; Trading settings and 🛡 Entry filters stay as the quick preset screens. It lists every key `config.js` reads from `user-config.json` and `gmgn-config.json` (derived from config.js itself, so new keys appear automatically), grouped as Mode / Capital & sizing / Exits / Strategy / Screening (Meteora) / Screening (GMGN) / Entry filters / Schedule / LLM / Learning / USDC mode / Other, with current values. Secrets (wallet key, RPC URL, API keys, chat ids, anything in `.env`) and the locked keys are never listed. Tap a key: booleans get On/Off, enums get their valid values, numbers and text take your next message (validated for type, range and allowed values; `/cancel` aborts; the prompt expires after 60s). `dryRun` needs a second tap in both directions and warns clearly before going LIVE (if `.env` sets `DRY_RUN`, `.env` wins again after a restart). Risk-raising edits (bigger size, more positions, wider or off stop loss, trailing TP off, an entry guard off, a lower gas reserve, USDC mode on/off) also need the second tap. Changes save to the right file and apply live where the running config supports it; `llmProvider` and `webPort` apply after a restart.

Wallet (💰, read-only) shows the true total: SOL, USDC and every token worth more than $0.10 in the wallet (Helius prices), plus each open DLMM position's value (SOL side, token side, unclaimed fees; LP Agent / Meteora values, which exclude fees, so fees are added) with a subtotal, and the combined total in SOL and USD at the SOL price shown. A position whose value is unknown is listed as "value unknown" and left out of the total. Refresh forces a fresh position scan.

Bot controls: pause/resume scheduled screening (persisted in `state.json`; management and the PnL watcher keep running), run a screening cycle now, autoresearch status/list/approve/reject, and the last ERROR/WARN log lines (redacted).

Access and confirmation rules:

- only the owner chat (`telegramChatId` in `user-config.json`, else `TELEGRAM_CHAT_ID`) can control the bot; the sender must be that chat or listed in `TELEGRAM_ALLOWLIST`. Other chats are logged and ignored, never answered
- with no owner configured, the first private chat is registered once (logged loudly) and persisted to `user-config.json`
- anything that moves funds (close, deploy, number-reply deploy, `auto`, run screening now) shows a confirmation card first. Confirm carries a single-use nonce that expires after 60s; it executes through the same `executeTool` path the agent uses, so DRY_RUN and every safety check still apply

Telegram alerts only fire when something happened: deploys, closes, stop-loss / take-profit auto-closes, partial deploys, out-of-range (once per 6h per pair), gas low and cycle errors, with Positions / Close (confirmation) buttons, plus the daily briefing. A management or screening report is sent only when a close rule fired or funds moved; routine "all HOLD" or "nothing deployed" cycles are silent and show under Status instead.

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

`screeningSource` picks where candidates come from: `"meteora"` (default, Meteora pool discovery with the thresholds below), `"gmgn"` (GMGN token pipeline, filters in `gmgn-config.json`), or `"both"`. With `"both"`, the two run in parallel and the bot keeps going on one if the other fails. Results are deduped to one pool per token (higher fee/active-TVL, then higher TVL). GMGN-only pools must also pass `minBinStep`/`maxBinStep`, `minTvl`/`maxTvl` and `maxVolatility`, and pools found by both sources rank first. Invalid values fall back to `"meteora"`.

| Field | Meaning |
| --- | --- |
| `screeningSource` | `meteora`, `gmgn`, or `both` |
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
| `deployAmountSol` | minimum SOL per deploy (floor; a smaller computed size skips the deploy) |
| `maxPositions` | maximum concurrent positions |
| `minSolToOpen` | minimum wallet balance to allow new deploy |
| `gasReserve` | reserve left for gas |
| `positionSizePct` | dynamic sizing fraction |
| `positionSizeBase` | `total` (default) or `wallet`: what `positionSizePct` is a fraction of (see Deploy sizing below) |
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

#### Deploy sizing

With no explicit amount, each SOL deploy is sized as:

```
base   = total SOL           (positionSizeBase "total": free wallet SOL + SOL value of every open DLMM position, unclaimed fees included once)
       | free wallet SOL     (positionSizeBase "wallet")
size   = min(maxDeployAmount, positionSizePct × (base − gasReserve))
amount = min(size, free wallet SOL − gasReserve)      # never more than the SOL actually free to deploy
amount < deployAmountSol  →  skip, e.g. "size 0.62 below floor 1.1"   # the floor is never forced
```

On the `total` basis, if any open position's value is unknown or the positions/price lookup fails, the size falls back to the free-wallet basis (smaller, never inflated) and the fallback is logged. `minSolToOpen` still gates screening on free SOL as before. The Telegram deploy card and the agent's deploy instruction show the basis, e.g. `1.13 SOL = 45% of (2.61 SOL total − 0.1 reserve)`. USDC mode sizes in USD (`deployAmountUsd`) and is unaffected.

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
| `autoresearchMinClosesPerArm` | closes needed in each A/B arm before a verdict (default 100) |
| `autoresearchMinEffectPct` | minimum size-weighted mean PnL gain, in pp, to pass (default 1.5) |
| `autoresearchMaxExperimentDays` | time cap; at the cap the result is inconclusive and the candidate is discarded (default 14) |
| `autoresearchAutoKeep` | keep a passing candidate without operator approval (default false) |
| `autoresearchMaxDiffPct` | reject candidates that change more than this % of the section's lines (default 30) |
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

### Pool Memory

`pool-memory.json` records every deploy and close per pool **address** (PnL, range efficiency, strategy, close reason, win rate) plus mid-position snapshots. Management and screening prompts get it as `POOL CONTEXT`; the agent can read it with `get_pool_memory` and annotate a pool with `add_pool_note`.

The earlier Nuggets memory layer was removed. If an older install still has `data/nuggets/`, it is ignored and can be deleted.

### Threshold Evolution

Meridian can evolve screening thresholds from real performance and lesson history. These changes persist back into `user-config.json`.

- A close is a win above +1% PnL and a loss below −1%. Anything in between is break-even and doesn't count toward wins or losses. The same classifier (`learning-data.js`) drives lessons, pool-memory win rates and signal weights.
- Every evolution rule needs at least `MIN_RULE_SAMPLES` (5) of the closes it relies on before it moves a setting. A rule that compares winners with losers needs 5 on each side it uses.
- Records flagged `exclude_from_learning` or `corrupt`, records marked `corrected`, and the known-bad list in `learning-data.js` are never learned from.
- On the exit side, evolution tunes only the trailing take profit, one 0.5 step per run: `trailingTriggerPct` (1.5–15) and `trailingDropPct` (1–8). It learns only from closes with a known peak that ran under the current value. `takeProfitFeePct` and `stopLossPct` are left to you.

### Autoresearch

Autoresearch is prompt optimization driven by real closes, inspired by karpathy/autoresearch. Live PnL is a noisy, non-stationary metric, so it runs as a concurrent A/B test and a human approves any change.

It:

1. waits until there is enough close history, off the close path (never blocks a close)
2. attributes recent losses to a prompt section that is active for the current strategy
3. asks the generator for one small change, steered by the human-edited `autoresearch-program.md`
4. rejects candidates that touch HARD RULE / HARD SKIP / MUST / NEVER lines or change too much
5. alternates screener runs between the control text and the candidate, tagging each deploy with its arm
6. after `autoresearchMinClosesPerArm` closes per arm, passes only if the bootstrap 95% CI of the size-weighted mean PnL difference is above 0 and the gain is at least `autoresearchMinEffectPct`
7. turns a pass into a pending proposal for the operator (`/autoresearch approve | reject`), unless `autoresearchAutoKeep` is on

Section targets: `screener_criteria`, plus `range_selection` when the strategy isn't `evil_panda`. `manager_logic` can't be split into concurrent arms, so it isn't targeted.

Kept overrides persist in `autoresearch.json` and are applied only while autoresearch is enabled. `/autoresearch list | show | revert | restore` manage them from Telegram or the REPL. The legacy overrides from the pre-A/B loop are quarantined there.

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
  pool-memory.js
  unified-memory.js
  server.js
  telegram.js        # Bot API transport + owner-only access control
  telegram-ui.js     # menus, views, confirmations, alerts
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

Only the owner chat is accepted (`telegramChatId` in `user-config.json`, else `TELEGRAM_CHAT_ID`). Change `telegramChatId` to rebind ownership. In a group owner chat, add the members' user ids to `TELEGRAM_ALLOWLIST`; ignored updates are logged as `TELEGRAM_WARN`.

## Disclaimer

This software is provided as-is, without warranty. Running an autonomous trading agent carries real financial risk and can lose funds. Start in dry run, validate behavior, and size capital conservatively.
