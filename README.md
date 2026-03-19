# Meridian

**Autonomous Meteora DLMM liquidity management agent for Solana.**

Meridian screens pools, deploys capital, manages positions, learns from every trade, and evolves its own strategy — all without human intervention. Two specialized LLM agents run on independent schedules: one hunts for yield, the other protects your capital.

---

## Architecture

```
                    +-----------------------+
                    |      LLM Engine       |
                    |   (DeepSeek / Claude)  |
                    +----------+------------+
                               |
                    +----------v------------+
                    |    ReAct Agent Loop    |
                    |  reason → tool → act   |
                    +----------+------------+
                               |
          +--------------------+--------------------+
          |                    |                    |
  +-------v-------+   +-------v-------+   +-------v-------+
  |   Screener    |   |   Manager     |   |   General     |
  |  (Hunter)     |   |  (Healer)     |   |   (Chat)      |
  |  every 30m    |   |  every 3-10m  |   |  on demand    |
  +-------+-------+   +-------+-------+   +-------+-------+
          |                    |                    |
  +-------v--------------------v--------------------v-------+
  |                      Tool Layer                         |
  |  positions | wallet | pools | deploy | close | swap     |
  |  study LPers | token info | holders | smart wallets     |
  |  pool memory | lessons | strategy library | config      |
  +-----+-----------+-----------+-----------+---------------+
        |           |           |           |
  +-----v---+ +----v----+ +----v----+ +----v----+
  | Meteora | | Helius  | | Jupiter | |LP Agent |
  |  SDK    | |  RPC    | | Swap/   | |  API    |
  |  DLMM   | | Solana  | | Price   | | Study   |
  +---------+ +---------+ +---------+ +---------+
```

### Agent Roles

| Agent | Schedule | Mission |
|-------|----------|---------|
| **Screener** | Every 30 min | Find high-yield pools, study top LPers, deploy capital |
| **Manager** | Every 3–10 min | Monitor positions, enforce exit rules, claim fees, close/hold |
| **General** | On demand | Answer questions, execute commands via chat |

Management interval auto-adjusts based on pool volatility: high volatility (>5) = 3 min, medium (2-5) = 5 min, low (<2) = 10 min.

Cycles never overlap — if management is running when screening fires, screening defers to the next tick.

---

## Features

### Autonomous LP Management
- **Screen** — scans Meteora pools against configurable thresholds (fee/TVL, organic score, holders, mcap, bin step, volume)
- **Deploy** — opens DLMM positions with dynamic sizing (scales with wallet balance)
- **Manage** — monitors PnL, fees, range status; decides STAY / CLOSE / REBALANCE
- **Close** — claims fees, removes liquidity, swaps dust tokens back to SOL
- **Learn** — derives lessons from every closed position, deduplicates similar rules
- **Evolve** — auto-adjusts screening thresholds based on win rate and PnL history

### Strategy Intelligence
- **bid_ask** — single-sided SOL below active bin. Safe default for meme tokens.
- **spot** — uniform distribution. SOL-only, token-only, or two-sided with configurable conviction ratio.
- Strategy library — save, compare, and switch between named strategies
- On-chain strategy detection — reads bin liquidity distribution via RPC to identify strategy type

### Exit Rules
- **Stop Loss** — close if PnL drops below threshold (default: -40%)
- **Trailing Take Profit** — activates at +5% PnL, closes if PnL drops 4% from peak
- **Fixed Take Profit** — close when total PnL exceeds threshold (default: 10%)
- **Out of Range** — configurable wait time before closing OOR positions

### Memory Systems

**Nuggets (Holographic Memory)**
Cross-session learning via HRR-based vector memory. Facts are key-value pairs superposed into fixed-size complex vectors — multiple facts coexist in one mathematical object but remain individually retrievable in ~1ms.

- `remember` — bind a fact into the holographic vector
- `recall` — unbind and decode via cosine similarity
- `forget` — subtract a binding from the superposition
- `promote` — facts recalled 3+ times get written to permanent context

Five recall channels per management cycle: pool name, strategy+bin_step, strategy alone, volatility bucket, and general lessons. More recall paths = faster promotion of useful facts.

**Lessons (Performance-Derived Rules)**
Every closed position generates a structured lesson with tags and outcome classification. Lessons are deduplicated on creation (tag+outcome matching and normalized key matching). Injected into agent prompts via a 3-tier system:
1. **Pinned** (up to 10) — critical rules, always present
2. **Role-matched** (up to 15) — tagged for the current agent role
3. **Recent fill** (remaining) — newest lessons up to 35 total

**Pool Memory**
Per-pool deploy history with PnL, strategy, and notes. The agent checks pool memory before deploying — if a pool has a bad track record, it skips.

### Position Auto-Adoption
Manually opened positions are automatically detected and adopted by the management cycle. The agent:
1. Discovers untracked positions via on-chain scan
2. Infers strategy from bin liquidity distribution (on-chain RPC)
3. Fetches pool metadata (name, bin step, volatility, organic score)
4. Creates tracked entry with full management (exit rules, nuggets, lessons)

Externally closed positions are also handled — `syncOpenPositions` detects missing positions, fetches final PnL from LP Agent historical API, and records performance.

### LP Agent Integration
Real performance data from LP Agent API replaces local tracking for display:
- **Overview endpoint** — lifetime PnL, fees, win rate, ROI, avg hold time
- **Historical endpoint** — per-position final PnL for externally closed positions
- **Revenue endpoint** — daily/weekly PnL breakdown
- **Study endpoint** — top LPer analysis per pool (multi-key rotation for rate limits)

### Smart Wallet Tracking
Track proven LPers and KOLs. Before deploying, the agent checks if tracked wallets have active positions in the pool — a strong signal. Wallet types:
- `lp` — checked for LP positions (LPers/whales)
- `holder` — checked for token holdings only (KOLs/traders)

---

## Web Dashboard

Real-time monitoring at `http://localhost:3737` with WebSocket updates.

### Layout
- **StatusBar** — connection, cycle countdowns, wallet balance (SOL + USD), busy indicator
- **Chat Panel** (55%) — message agent, queue messages while busy, lightChat for fast responses
- **Data Sidebar** (45%) — three tabs: Dashboard, Candidates, Activity

### Dashboard Tab
- **Wallet Card** — SOL balance, USD value, SOL price
- **LP Performance Card** — total PnL, fees, win rate, closed positions, avg hold, ROI (from LP Agent)
- **Position Cards** — per-position with PnL, fees, age, in-range/OOR badge
- **Bin Range Chart** — per-position visualization: blue (SOL) / purple (token), bid_ask wedge or spot uniform shape, active bin glow

### Candidates Tab
- Ranked pool table with fee/TVL, volume, organic score, active bin %
- Shows eligible/screened counts

### Activity Tab
- Real-time notification feed: deploys, closes, OOR alerts, cycle reports, briefings

### Command Palette (Ctrl+K)
Quick access to all commands + natural language suggestions.

---

## Setup

### Requirements
- Node.js 18+
- Solana wallet (base58 private key)
- [DeepSeek](https://platform.deepseek.com) API key (or any OpenAI-compatible provider)
- [Helius](https://helius.dev) RPC URL (recommended)
- LP Agent API key (optional, for study/overview)
- Telegram bot token (optional, for notifications)

### Install

```bash
git clone https://github.com/fciaf420/meridian.git
cd meridian
npm install
cd web && npm install && npm run build && cd ..
```

### Configure

```bash
node setup.js
```

Interactive wizard with three presets:

| Preset | Deploy | Positions | Fee Target | Volatility | Interval |
|--------|--------|-----------|------------|------------|----------|
| **Degen** | 0.5 SOL | 5 | 10% | Any | 5 min |
| **Moderate** | 1.0 SOL | 3 | 5% | Max 8 | 10 min |
| **Safe** | 2.0 SOL | 2 | 3% | Max 5 | 15 min |

Or configure manually via `.env` + `user-config.json`.

### Environment Variables

```env
DEEPSEEK_API_KEY=sk-...              # LLM inference (required)
WALLET_PRIVATE_KEY=your_base58_key   # Solana wallet (required)
RPC_URL=https://...helius-rpc.com    # Solana RPC (recommended: Helius)
LPAGENT_API_KEY=key1,key2            # LP Agent (optional, comma-separated for rotation)
TELEGRAM_BOT_TOKEN=123456:ABC...     # Telegram notifications (optional)
DRY_RUN=true                         # Simulate mode — no on-chain transactions
```

### Run

```bash
npm run dev     # dry run — simulates all transactions
npm start       # live mode — real on-chain execution
```

On startup: fetches wallet balance, scans open positions, loads lessons, deduplicates stale rules, initializes nuggets memory, starts cron schedules, opens web dashboard at port 3737.

---

## Configuration

All fields optional. Edit `user-config.json` or use `update_config` via chat.

### Screening

| Field | Default | Description |
|-------|---------|-------------|
| `minFeeActiveTvlRatio` | `0.05` | Minimum fee/active-TVL ratio (%) |
| `minTvl` / `maxTvl` | `10000` / `150000` | TVL range (USD) |
| `minOrganic` | `65` | Minimum organic score (0–100) |
| `minHolders` | `500` | Minimum token holder count |
| `minMcap` | `150000` | Minimum market cap (USD) |
| `minVolume` | `10000` | Minimum volume |
| `minBinStep` / `maxBinStep` | `20` / `125` | Bin step range |
| `timeframe` | `1h` | Screening candle timeframe |
| `category` | `trending` | Pool category filter |

### Management

| Field | Default | Description |
|-------|---------|-------------|
| `deployAmountSol` | `0.5` | SOL per position (dynamic with compounding) |
| `maxPositions` | `3` | Maximum concurrent positions |
| `positionSizePct` | `0.35` | Position size as % of deployable balance |
| `gasReserve` | `0.2` | SOL reserved for gas |
| `takeProfitFeePct` | `10` | Close at this total PnL % |
| `stopLossPct` | `-20` | Close if PnL drops below this % |
| `trailingTakeProfit` | `true` | Enable trailing take profit |
| `trailingTriggerPct` | `3` | Trailing TP activates at this PnL % |
| `trailingDropPct` | `1.5` | Close when PnL drops this % from peak |
| `outOfRangeWaitMinutes` | `30` | Minutes OOR before acting |

### Scheduling

| Field | Default | Description |
|-------|---------|-------------|
| `managementIntervalMin` | `10` | Management cycle interval (auto-adjusted by volatility) |
| `screeningIntervalMin` | `30` | Screening cycle interval |
| `maxSteps` | `20` | Maximum agent loop steps per cycle |

### LLM

| Field | Default | Description |
|-------|---------|-------------|
| `managementModel` | `deepseek-chat` | Model for position management |
| `screeningModel` | `deepseek-reasoner` | Model for pool screening |
| `generalModel` | `deepseek-chat` | Model for chat / commands |
| `pnlUnit` | `sol` | Display PnL in `sol` or `usd` |

---

## Commands

### REPL (Terminal)

```
[manage: 8m 12s | screen: 24m 3s]
>
```

| Command | Action |
|---------|--------|
| `1`, `2`, `3` ... | Deploy into numbered candidate pool |
| `auto` | Agent picks best pool and deploys |
| `/status` | Wallet balance + open positions |
| `/candidates` | Current top pool candidates |
| `/briefing` | 24h performance briefing |
| `/thresholds` | Screening thresholds + performance stats |
| `/learn` | Study top LPers across all candidates |
| `/evolve` | Evolve thresholds from performance data |
| `/stop` | Graceful shutdown |
| `<wallet_address>` | Look up any wallet's DLMM positions |
| `<anything>` | Free-form chat with session history |

### Web UI (Ctrl+K Command Palette)

Same commands plus natural language: "Show my positions", "What pools look good?", "Close all positions", "Deploy 0.5 SOL into Gerald".

### Telegram

Send any message to your bot to auto-register. Same command interface as REPL. Receives automatic notifications for deploys, closes, OOR alerts, and cycle reports.

---

## How It Learns

### Per-Position Lessons
Every closed position generates a tagged lesson:
```
[FAILED] [2026-03-19 00:31] FAILED: Downald-SOL, strategy=bid_ask,
bin_step=125, volatility=15.59 → PnL -5%, range efficiency 40%.
Reason: agent decision.
```

Lessons are deduplicated — same tags+outcome or same normalized rule text updates the existing entry instead of creating duplicates. Lessons are injected into the agent prompt for the relevant role.

### Threshold Evolution
After 5+ closed positions, `/evolve` analyzes win/loss patterns and adjusts screening thresholds (organic score, fee/TVL, holders, etc.) by up to 20% per step. Changes persist to `user-config.json` immediately.

### Nuggets Memory
Cross-session holographic memory stores pool outcomes, strategy effectiveness, volatility patterns, and management insights. Facts recalled frequently get promoted to permanent context. Memory persists across restarts at `data/nuggets/`.

### Daily Briefing
At 1 AM UTC, a briefing is generated with:
- 24h activity (positions opened/closed)
- Performance from LP Agent API (real PnL, fees, win rate)
- Top 5 most recent lessons
- Current portfolio state

---

## Data Sources

| Source | Used For |
|--------|----------|
| **Meteora DLMM SDK** | On-chain positions, deploy/close transactions, bin data, active bin |
| **Meteora PnL API** | Position yield, fee accrual, real-time PnL |
| **Meteora Pool Discovery API** | Pool screening, fee/TVL ratios, volume, organic scores |
| **Helius RPC** | Wallet balances, token accounts, position scanning |
| **Jupiter** | Token swaps (fee token → SOL), price feeds, token info |
| **LP Agent API** | Top LPer analysis, historical PnL, revenue overview, pool intel |
| **DeepSeek / Claude** | LLM reasoning for all agent decisions |

---

## Project Structure

```
meridian/
  index.js              Entry point — cron schedules, REPL, startup
  agent.js              ReAct agent loop + lightChat fast path
  prompt.js             Role-based system prompt builder
  config.js             Config loading with user-config overlay
  state.js              Position tracking, sync, exit rule checks
  lessons.js            Learning system, dedup, threshold evolution
  memory.js             Nuggets holographic memory integration
  briefing.js           Daily performance briefing
  server.js             Express + WebSocket server (port 3737)
  telegram.js           Telegram bot integration
  notifier.js           Internal event pub/sub
  session.js            Session state (history, busy flags)
  setup.js              Interactive setup wizard
  tools/
    definitions.js      All 30+ agent tool definitions
    executor.js         Tool dispatch + dry-run handling
    dlmm.js             Meteora SDK: positions, deploy, close, PnL
    screening.js        Pool discovery + scoring
    wallet.js           Wallet balances + Jupiter swaps
    study.js            LP Agent: top LPer analysis
    token.js            Jupiter: token info, holders, narratives
    lp-overview.js      LP Agent: performance overview + history
  web/
    src/
      App.tsx                   Main layout
      hooks/useWebSocket.ts     Real-time data hook
      components/
        StatusBar.tsx           Connection + timers + wallet
        ChatPanel.tsx           Agent chat interface
        DataSidebar.tsx         Tabbed sidebar container
        DashboardTab.tsx        Wallet + LP perf + positions
        CandidatesTab.tsx       Pool ranking table
        ActivityTab.tsx         Notification feed
        PositionCard.tsx        Per-position card
        BinRangeChart.tsx       Bin liquidity visualization
        CommandPalette.tsx      Ctrl+K command search
        ui/                     shadcn components (tabs, card, table, etc.)
```

---

## Disclaimer

This software is provided as-is, with no warranty. Running an autonomous trading agent carries real financial risk — you can lose funds. Always start with `DRY_RUN=true` to verify behavior before going live. Never deploy more capital than you can afford to lose. This is not financial advice.

The authors are not responsible for any losses incurred through use of this software.
