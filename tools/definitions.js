export const tools = [
  // ═══════════════════════════════════════════
  //  SCREENING TOOLS
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "discover_pools",
      description: `Fetch top DLMM pools from the Meteora Pool Discovery API.
Pools are pre-filtered for safety:
- No critical warnings on base/quote tokens
- No high single ownership on base token
- Base token market cap >= $150k
- Base token holders >= 100
- Volume >= $1k (in timeframe)
- Active TVL >= $10k
- Fee/Active TVL ratio >= 0.01 (in timeframe)
- Both tokens organic score >= 60

Returns condensed pool data: address, name, tokens, bin_step, fee_pct,
active_tvl, fee_window, volume_window, fee_tvl_ratio, volatility, organic_score,
holders, mcap, active_positions, price_change_pct, warning count.

Use this as the primary tool for finding new LP opportunities.`,
      parameters: {
        type: "object",
        properties: {
          page_size: {
            type: "number",
            description: "Number of pools to return. Default 50. Use 10-20 for quick scans."
          },
          timeframe: {
            type: "string",
            enum: ["1h", "4h", "12h", "24h"],
            description: "Timeframe for metrics. Use 24h for general screening, 1h for momentum."
          },
          category: {
            type: "string",
            enum: ["top", "new", "trending"],
            description: "Pool category. 'top' = highest fee/TVL, 'new' = recently created, 'trending' = gaining activity."
          }
        }
      }
    }
  },

  {
    type: "function",
    function: {
      name: "get_top_candidates",
      description: `Get the top pre-scored pool candidates ready for deployment.
All filtering, scoring, and rule-checking is done in code — no analysis needed.
Returns the top N eligible pools ranked by score (fee/TVL, organic, stability, volume).
Each pool includes a score (0-100) and has already passed all hard disqualifiers.
Use this instead of discover_pools for screening cycles.`,
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of top candidates to return. Default 3."
          }
        }
      }
    }
  },

  {
    type: "function",
    function: {
      name: "get_pool_detail",
      description: `Get detailed info for a specific DLMM pool by address.
Use this during management to check current pool health (volume, fees, organic score, price trend).
Default timeframe is 5m for real-time accuracy during position management.
Use a longer timeframe (1h, 4h) only when screening for new deployments.

IMPORTANT: Only call this with a real pool address from get_my_positions or get_top_candidates. Never guess or construct a pool address.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: {
            type: "string",
            description: "The on-chain pool address (base58 public key)"
          },
          timeframe: {
            type: "string",
            enum: ["5m", "15m", "30m", "1h", "2h", "4h", "12h", "24h"],
            description: "Data timeframe. Default 5m for management (most accurate). Use 4h+ for screening."
          }
        },
        required: ["pool_address"]
      }
    }
  },

  // ═══════════════════════════════════════════
  //  POSITION DEPLOYMENT TOOLS
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "get_active_bin",
      description: `Get the current active bin and price for a DLMM pool.
This is an on-chain call via the SDK. Returns:
- binId: the current active bin number
- price: human-readable price (token X per token Y)
- pricePerLamport: raw price in lamports

Always call this before deploying a position to get the freshest price.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: {
            type: "string",
            description: "The DLMM pool address"
          }
        },
        required: ["pool_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "deploy_position",
      description: `Open a new DLMM liquidity position.

PRIORITY ORDER for strategy and bins:
1. User explicitly specifies → always follow exactly (user override is absolute)
2. No user spec → use active strategy's lp_strategy and choose bins based on volatility

STRATEGIES:
- 'bid_ask': Single-sided SOL below active bin. You only deposit SOL. As price drops, your SOL buys the base token bin by bin. You are NOT holding the token upfront — safer if it dumps.
- 'spot': Two-sided — deposits BOTH tokens around active bin. You ARE holding the base token. If the token dumps, you absorb more loss because you already held it. More fee capture but more risk.
- Never use 'curve'.

SINGLE-SIDED (bid_ask) vs TWO-SIDED (spot) — CRITICAL:
- Single-sided = you do NOT hold the base token. SOL sits below price, only converts as price drops into your range. Safe default.
- Two-sided = you ARE holding the base token in the LP. If token dumps, your position loses more because you had exposure from the start. Requires conviction the token will hold or go up.

WHEN TO USE WHICH:
- Meme tokens, new tokens, unproven tokens → ALWAYS bid_ask single-sided. Never take two-sided exposure on tokens you don't trust.
- High organic score (>85), strong holders, proven token → spot two-sided is OK if you believe in the token.
- High volatility, trending, pumping → bid_ask. You earn fees from the sell pressure without holding the bag.
- Stable, range-bound, high volume → spot. More fee capture from both sides.
- When unsure → ALWAYS default to bid_ask single-sided. It's the safe choice.

HARD RULES:
- Bin Step: Only deploy in pools with bin_step between 80 and 125.

BIN RANGE GUIDELINES (when user hasn't specified):
- Low volatility (<3) → narrow range: 35–45 bins
- Medium volatility (3–6) → medium range: 45–55 bins
- High volatility (>6) → wide range: 55–69 bins
- Wide-range strategies: up to 350 bins. Max 1400 total.
- To convert a % price range to bins: bins = ceil(log(1 - pct) / log(1 + bin_step/10000))
  Example: -60% range at bin_step 100 → ceil(log(0.40)/log(1.01)) = 92 bins.

WARNING: This executes a real on-chain transaction. Check DRY_RUN mode.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: {
            type: "string",
            description: "The DLMM pool address to LP in"
          },
          amount_y: {
            type: "number",
            description: "Amount of quote token (usually SOL) to deposit."
          },
          amount_x: {
            type: "number",
            description: "Amount of base token to deposit (if doing dual-sided or base-only)."
          },
          amount_sol: {
            type: "number",
            description: "Alias for amount_y. For backward compatibility."
          },
          strategy: {
            type: "string",
            enum: ["bid_ask", "spot"],
            description: "DLMM strategy. If user specifies, use exactly what they said. Otherwise use the active strategy's lp_strategy field. Default: bid_ask."
          },
          bins_above: {
            type: "number",
            description: "Number of bins above active bin. Default 0 (single-sided SOL). Set > 0 only for two-sided strategies."
          },
          bins_below: {
            type: "number",
            description: "Number of bins below active bin. If the user specifies a value, use it exactly. If they specify a % range, convert using: bins = ceil(log(1 - pct) / log(1 + bin_step/10000)). Otherwise choose based on volatility: 35–69 standard, 100–350 for wide-range. Max 1400 total."
          },
          pool_name: { type: "string", description: "Human-readable pool name for record-keeping" },
          base_mint: { type: "string", description: "Base token mint address — used to prevent duplicate token exposure across pools" },
          bin_step: { type: "number", description: "Pool bin step (from discover_pools)" },
          volatility: { type: "number", description: "Pool volatility at deploy time" },
          fee_tvl_ratio: { type: "number", description: "fee/TVL ratio at deploy time" },
          organic_score: { type: "number", description: "Base token organic score at deploy time" },
          initial_value_usd: { type: "number", description: "Estimated USD value being deployed" }
        },
        required: ["pool_address"]
      }
    }
  },

  // ═══════════════════════════════════════════
  //  POSITION MANAGEMENT TOOLS
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "get_position_pnl",
      description: `Get detailed PnL and real-time Fee/TVL metrics for an open position.
Use this during management to check if yield has dropped significantly.
Returns current feePerTvl24h which indicates the current APY of the pool.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: { type: "string", description: "The pool address" },
          position_address: { type: "string", description: "The position public key" }
        },
        required: ["pool_address", "position_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "get_my_positions",
      description: `List all open DLMM positions for the agent wallet.
Returns positions grouped by pool, each with:
- position address
- pool address and token pair
- bin range (min/max bin IDs)
- whether currently in range
- unclaimed fees (in USD)
- total deposited value vs current value
- time since last rebalance

Use this at the start of every management cycle.`,
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },

  {
    type: "function",
    function: {
      name: "claim_fees",
      description: `Claim accumulated swap fees from a specific position.
Only call when unclaimed fees > $5 to justify transaction costs.
Returns the transaction hash and amounts claimed.

WARNING: This executes a real on-chain transaction.`,
      parameters: {
        type: "object",
        properties: {
          position_address: {
            type: "string",
            description: "The position public key to claim fees from"
          }
        },
        required: ["position_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "close_position",
      description: `Remove all liquidity and close a position.
This withdraws all tokens back to the wallet and closes the position account.
Use when:
- Position has been out of range for > 30 minutes
- IL exceeds accumulated fees
- Token shows danger signals (organic score drop, volume crash)
- Rebalancing (close old + open new)

WARNING: This executes a real on-chain transaction. Cannot be undone.`,
      parameters: {
        type: "object",
        properties: {
          position_address: {
            type: "string",
            description: "The position public key to close"
          }
        },
        required: ["position_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "get_wallet_positions",
      description: `Get all open DLMM positions for any Solana wallet address.
Use this when the user asks about another wallet's positions, wants to monitor a wallet,
or wants to copy/compare positions.

Returns the same structure as get_my_positions but for the given wallet:
position address, pool, bin range, in-range status, unclaimed fees, PnL, age.`,
      parameters: {
        type: "object",
        properties: {
          wallet_address: {
            type: "string",
            description: "The Solana wallet address (base58 public key) to check"
          }
        },
        required: ["wallet_address"]
      }
    }
  },

  // ═══════════════════════════════════════════
  //  WALLET TOOLS
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "get_wallet_balance",
      description: `Get current wallet balances for SOL, USDC, and all other token holdings.
Returns:
- SOL balance (native)
- USDC balance
- Other SPL token balances with USD values
- Total portfolio value in USD

Use to check available capital before deploying positions.`,
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },

  {
    type: "function",
    function: {
      name: "swap_token",
      description: `Swap tokens via Jupiter aggregator.
Use when you need to rebalance wallet holdings, e.g.:
- Convert claimed fee tokens back to SOL/USDC
- Prepare token pair before deploying a position

WARNING: This executes a real on-chain transaction.`,
      parameters: {
        type: "object",
        properties: {
          input_mint: {
            type: "string",
            description: "Mint address of the token to sell"
          },
          output_mint: {
            type: "string",
            description: "Mint address of the token to buy"
          },
          amount: {
            type: "number",
            description: "Amount of input token to swap (in human-readable units, not lamports)"
          },
        },
        required: ["input_mint", "output_mint", "amount"]
      }
    }
  },

  // ═══════════════════════════════════════════
  //  LEARNING TOOLS
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "update_config",
      description: `Update any of your operating parameters at runtime.
Changes persist to user-config.json and take effect immediately — no restart needed.

You can change anything: screening thresholds, management rules, deploy amounts, cron intervals, strategy params, LLM settings.

Examples:
- { takeProfitFeePct: 8 }        — raise take profit target for hot markets
- { maxVolatility: 6 }           — accept higher volatility pools
- { managementIntervalMin: 5 }   — check positions more frequently
- { deployAmountSol: 0.5 }       — deploy more per position
- { timeframe: "1h" }            — switch screening timeframe
- { maxTvl: 50000 }              — tighter TVL cap
- { binsBelow: 50 }              — narrower bin range
- { maxPositions: 5 }            — allow more concurrent positions
- { managementModel: "deepseek-chat" }  — switch management cycle model (also: "claude-sonnet-4-20250514")
- { screeningModel: "deepseek-chat" }   — switch screening cycle model (also: "claude-sonnet-4-20250514")
- { stopLossPct: -15 }                  — close position if PnL drops below -15%
- { minTokenFeesSol: 20 }             — lower global fees gate
- { gasReserve: 0.3 }                 — keep more SOL for gas
- { positionSizePct: 0.25 }           — smaller positions per deploy
- { trailingTakeProfit: true }           — enable/disable trailing take profit
- { trailingTriggerPct: 5 }             — activate trailing TP when PnL hits +5%
- { trailingDropPct: 2 }                — close when PnL drops 2% from peak

Always provide a reason. This is logged as a lesson and visible in future cycles.`,
      parameters: {
        type: "object",
        properties: {
          changes: {
            type: "object",
            description: "Key-value pairs of settings to update. e.g. { \"takeProfitFeePct\": 8 }"
          },
          reason: {
            type: "string",
            description: "Why you are making this change — what you observed that justified it"
          }
        },
        required: ["changes", "reason"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "self_update",
      description: `Pull the latest code from git and restart the agent.
Use when the user says "update", "pull latest", "update yourself", etc.
Responds with what changed before restarting in 3 seconds.`,
      parameters: { type: "object", properties: {} }
    }
  },

  // ═══════════════════════════════════════════
  //  SMART WALLET TOOLS
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "add_smart_wallet",
      description: `Add a wallet to the smart wallet tracker.
Use when the user says "add smart wallet", "track this wallet", "add to smart wallets", etc.
- type "lp": wallet is tracked for LP positions (checked before deploying). Use for LPers/whales.
- type "holder": wallet is only checked for token holdings (never fetches positions). Use for KOLs/traders who don't LP.`,
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Label for this wallet (e.g. 'alpha-1', 'whale-sol')" },
          address: { type: "string", description: "Solana wallet address (base58)" },
          category: { type: "string", enum: ["alpha", "smart", "fast", "multi"], description: "Wallet category (default: alpha)" },
          type: { type: "string", enum: ["lp", "holder"], description: "lp = tracks LP positions, holder = tracks token holdings only (default: lp)" }
        },
        required: ["name", "address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "remove_smart_wallet",
      description: "Remove a wallet from the smart wallet tracker.",
      parameters: {
        type: "object",
        properties: {
          address: { type: "string", description: "Wallet address to remove" }
        },
        required: ["address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "list_smart_wallets",
      description: "List all currently tracked smart wallets.",
      parameters: { type: "object", properties: {} }
    }
  },

  {
    type: "function",
    function: {
      name: "check_smart_wallets_on_pool",
      description: `Check if any tracked smart wallets have an active position in a given pool.
Use this before deploying to gauge confidence — if smart wallets are in the pool it's a strong signal.
If no smart wallets are present, rely on fundamentals (fees, volume, organic score) as usual.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: { type: "string", description: "Pool address to check" }
        },
        required: ["pool_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "get_token_info",
      description: `Get token data from Jupiter (organic score, holders, audit, price stats, mcap).
Use this to research a token before deploying or when the user asks about a token.
Accepts token name, symbol, or mint address as query.

Returns: organic score, holder count, mcap, liquidity, audit flags (mint/freeze disabled, bot holders %), 1h and 24h stats.`,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Token name, symbol, or mint address" }
        },
        required: ["query"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "get_token_holders",
      description: `Get holder distribution for a token by mint address.
Fetches top 100 holders — use limit to control how many to display (default 20).
Each holder includes: address, amount, % of supply, SOL balance, tags (Pool/AMM/etc), and funding info (who funded this wallet, amount, slot).
is_pool=true means it's a liquidity pool address, not a real holder — filter these out when analyzing concentration.

Also returns global_fees_sol — total priority/jito tips paid by ALL traders on this token (NOT Meteora LP fees).
This is a key signal: low global_fees_sol means transactions are bundled or the token is a scam.
HARD GATE: if global_fees_sol < config.screening.minTokenFeesSol (default 30), do NOT deploy.

NOTE: Requires mint address. If you only have a symbol/name, call get_token_info first to resolve the mint.`,
      parameters: {
        type: "object",
        properties: {
          mint: { type: "string", description: "Token mint address (base58). Use get_token_info first if you only have a symbol." },
          limit: { type: "number", description: "How many holders to return (default 20, max 100)" }
        },
        required: ["mint"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "search_pools",
      description: `Search for DLMM pools by token symbol, ticker, or contract address (CA).
Use this when the user asks to deploy into a specific token or pool by name/CA,
or when you want to find pools for a specific token outside of the normal screening flow.

Examples: "find pools for ROSIE", "search BONK pools", "look up pool for CA abc123..."

Returns pool address, name, bin_step, fee %, TVL, volume, and token mints.`,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Token symbol, ticker name, or contract address to search for"
          },
          limit: {
            type: "number",
            description: "Max results to return (default 10)"
          }
        },
        required: ["query"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "get_top_lpers",
      description: `Get the top LPers for a pool by address — quick read-only lookup.
Use this when the user asks "who are the top LPers in this pool?" or wants to
know how others are performing in a specific pool without saving lessons.

Returns: aggregate patterns (avg hold time, win rate, ROI) and per-LPer summaries.
Requires LPAGENT_API_KEY to be set.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: {
            type: "string",
            description: "The pool address to look up top LPers for"
          },
          limit: {
            type: "number",
            description: "Number of top LPers to return. Default 5."
          }
        },
        required: ["pool_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "study_top_lpers",
      description: `Fetch and analyze top LPers for a pool to learn from their behaviour.
Returns aggregate patterns (avg hold time, win rate, ROI) and historical samples.

Use this before deploying into a new pool to:
- See if top performers are scalpers (< 1h holds) or long-term holders.
- Match your strategy and range to what is actually working for others.
- Avoid pools where even the best performers have low win rates.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: {
            type: "string",
            description: "Pool address to study top LPers for"
          },
          limit: {
            type: "number",
            description: "Number of top LPers to study. Default 4."
          }
        },
        required: ["pool_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "clear_lessons",
      description: `Remove lessons from memory. Use when the user asks to erase lessons, or when lessons contain bad data (e.g. bug-caused -100% PnL records).

Modes:
- keyword: remove all lessons whose text contains the keyword (e.g. "-100%", "FAILED", "WhiteHouse")
- all: wipe every lesson
- performance: wipe all closed position performance records (the raw data lessons are derived from)`,
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["keyword", "all", "performance"],
            description: "What to clear"
          },
          keyword: {
            type: "string",
            description: "Required when mode=keyword. Case-insensitive substring match against lesson text."
          }
        },
        required: ["mode"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "set_position_note",
      description: `Save a persistent instruction for a position that ALL future management cycles will respect.
Use this immediately whenever the user gives a specific instruction about a position:
- "hold until 5% profit"
- "don't close before fees hit $10"
- "close if it goes out of range"
- "hold for at least 2 hours"

The instruction is stored in state.json and injected into every management cycle prompt.
Pass null or empty string to clear an existing instruction.`,
      parameters: {
        type: "object",
        properties: {
          position_address: {
            type: "string",
            description: "The position address to attach the instruction to"
          },
          instruction: {
            type: "string",
            description: "The instruction to persist (e.g. 'hold until PnL >= 5%'). Pass empty string to clear."
          }
        },
        required: ["position_address", "instruction"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "add_lesson",
      description: `Save a lesson to the agent's permanent memory.
Use after studying top LPers or observing a pattern worth remembering.
Lessons are injected into the system prompt on every future cycle.
Write concrete, actionable rules — not vague observations.

Use 'role' to target a specific agent type so it only appears in the right context.
Use 'pinned: true' for critical rules that must always be present regardless of memory cap.

Examples:
- rule: "PREFER: pools where top LPers hold < 30 min", tags: ["scalping"], role: "SCREENER"
- rule: "AVOID: closing when OOR < 30min — price often recovers", tags: ["oor"], role: "MANAGER", pinned: true`,
      parameters: {
        type: "object",
        properties: {
          rule: {
            type: "string",
            description: "The lesson rule — specific and actionable"
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags e.g. ['narrative', 'screening', 'oor', 'fees', 'management']"
          },
          role: {
            type: "string",
            enum: ["SCREENER", "MANAGER", "GENERAL"],
            description: "Which agent role this lesson applies to. Omit for all roles."
          },
          pinned: {
            type: "boolean",
            description: "Pin this lesson so it's always injected regardless of memory cap. Use for critical rules."
          }
        },
        required: ["rule"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "get_pool_info",
      description: `Get deep pool intelligence from LP Agent API — token audit, fee trends, bot holders, buy/sell ratio.
Use this for extra due diligence before deploying or to check if a pool is dying during management.
Rate limited to 5 calls per minute — use sparingly, only when you need deeper intel than get_pool_detail provides.
Results are auto-saved to memory so you won't need to call it again for the same pool.

Returns: token audit (mint/freeze authority, bot %, dev balance, top holder concentration),
5m and 1h trading stats (buy/sell volume, organic ratio, trader count),
fee trend over last 24 hours, liquidity amounts.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: {
            type: "string",
            description: "The DLMM pool address to get deep info for"
          }
        },
        required: ["pool_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "remember_fact",
      description: `Store a fact in holographic memory for cross-session learning.
Use this to remember patterns, outcomes, or strategies that should persist across restarts.
Nuggets: "pools" (pool outcomes), "strategies" (what strategies work), "lessons" (general rules), "patterns" (market patterns).
Or create a new nugget name for a new category.

Examples:
- remember_fact("pools", "BONK-SOL", "high volume but unstable, close within 30min")
- remember_fact("strategies", "bid_ask_bs100", "works well for volatile tokens, 70%+ win rate")
- remember_fact("lessons", "evening_volatility", "volume drops after 8pm UTC, avoid new deploys")`,
      parameters: {
        type: "object",
        properties: {
          nugget: { type: "string", description: "Memory category (pools, strategies, lessons, patterns, or custom)" },
          key: { type: "string", description: "Short descriptive key for the fact" },
          value: { type: "string", description: "The fact content to remember" }
        },
        required: ["nugget", "key", "value"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "recall_memory",
      description: `Query holographic memory for relevant facts from past sessions.
Use this before making decisions to check if you've learned something relevant.
Supports fuzzy matching — you don't need an exact key, just a related query.

Examples:
- recall_memory("BONK") → might recall "BONK-SOL: high volume but unstable"
- recall_memory("bid_ask strategy") → might recall strategy effectiveness data
- recall_memory("evening trading") → might recall timing-based lessons`,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for in memory (fuzzy matched)" },
          nugget: { type: "string", description: "Optional: search only in this nugget (pools, strategies, lessons, patterns)" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "forget_fact",
      description: `Remove a fact from holographic memory.
Use this to clean up stale, incorrect, or outdated facts.
Specify the nugget name and the exact key of the fact to forget.

Examples:
- forget_fact("pools", "BONK-SOL") — remove an outdated pool outcome
- forget_fact("strategies", "old_pattern") — remove an obsolete strategy note`,
      parameters: {
        type: "object",
        properties: {
          nugget: { type: "string", description: "Memory category the fact belongs to (pools, strategies, lessons, patterns, or custom)" },
          key: { type: "string", description: "The exact key of the fact to remove" }
        },
        required: ["nugget", "key"]
      }
    }
  },

  // ─── Strategy Library ──────────────────────────────────────────

  {
    type: "function",
    function: {
      name: "add_strategy",
      description: `Save a new LP strategy to the strategy library.
Use when the user pastes a tweet or description of a strategy.
Parse the text and extract structured criteria, then call this tool to store it.`,
      parameters: {
        type: "object",
        properties: {
          id:           { type: "string", description: "Short slug e.g. 'overnight_classic_bid_ask'" },
          name:         { type: "string", description: "Human-readable name" },
          author:       { type: "string", description: "Strategy author/creator" },
          lp_strategy:  { type: "string", enum: ["bid_ask", "spot", "curve"], description: "LP strategy type" },
          token_criteria: { type: "object", description: "Token selection criteria" },
          entry:        { type: "object", description: "Entry conditions" },
          range:        { type: "object", description: "Bin range configuration" },
          exit:         { type: "object", description: "Exit rules" },
          best_for:     { type: "string", description: "Ideal market conditions" },
          raw:          { type: "string", description: "Original tweet/text" }
        },
        required: ["id", "name"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "list_strategies",
      description: "List all saved strategies in the library with a summary of each. Shows which one is currently active.",
      parameters: { type: "object", properties: {} }
    }
  },

  {
    type: "function",
    function: {
      name: "get_strategy",
      description: "Get full details of a specific strategy including all criteria and raw text.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Strategy ID from list_strategies" } },
        required: ["id"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "set_active_strategy",
      description: "Set which strategy to use for the next screening/deployment cycle.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Strategy ID to activate" } },
        required: ["id"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "remove_strategy",
      description: "Remove a strategy from the library.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Strategy ID to remove" } },
        required: ["id"]
      }
    }
  },

  // ─── Lesson Management ─────────────────────────────────────────

  {
    type: "function",
    function: {
      name: "list_lessons",
      description: "Browse saved lessons with optional filters. Use to find a lesson ID before pinning/unpinning.",
      parameters: {
        type: "object",
        properties: {
          role:   { type: "string", enum: ["SCREENER", "MANAGER", "GENERAL"], description: "Filter by role" },
          pinned: { type: "boolean", description: "Filter to only pinned (true) or unpinned (false) lessons" },
          tag:    { type: "string", description: "Filter by a specific tag" },
          limit:  { type: "number", description: "Max lessons to return (default 30)" }
        }
      }
    }
  },

  {
    type: "function",
    function: {
      name: "pin_lesson",
      description: "Pin a lesson by ID so it's always injected into the prompt regardless of memory cap.",
      parameters: {
        type: "object",
        properties: { id: { type: "number", description: "Lesson ID (from list_lessons)" } },
        required: ["id"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "unpin_lesson",
      description: "Unpin a previously pinned lesson.",
      parameters: {
        type: "object",
        properties: { id: { type: "number", description: "Lesson ID to unpin" } },
        required: ["id"]
      }
    }
  },

  // ─── Performance History ────────────────────────────────────────

  {
    type: "function",
    function: {
      name: "get_performance_history",
      description: `Retrieve closed position records filtered by time window.
Use when the user asks about recent performance, last 24h positions, P&L history, etc.`,
      parameters: {
        type: "object",
        properties: {
          hours: { type: "number", description: "How many hours back to look (default 24). Use 168 for last 7 days." },
          limit: { type: "number", description: "Max records to return (default 50)" }
        }
      }
    }
  },

  // ─── Pool Memory ────────────────────────────────────────────────

  {
    type: "function",
    function: {
      name: "get_pool_memory",
      description: `Check your deploy history for a pool BEFORE deploying.
Returns all past deploys, PnL, win rate, and any notes you've added.
Call this tool before deploying to any pool — you may have been here before and it didn't work.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: { type: "string", description: "The pool address to look up" }
        },
        required: ["pool_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "add_pool_note",
      description: "Annotate a pool with a freeform note that persists across sessions.",
      parameters: {
        type: "object",
        properties: {
          pool_address: { type: "string", description: "Pool address to annotate" },
          note: { type: "string", description: "The note to save" }
        },
        required: ["pool_address", "note"]
      }
    }
  },

  // ─── Token Blacklist ────────────────────────────────────────────

  {
    type: "function",
    function: {
      name: "add_to_blacklist",
      description: "Permanently blacklist a base token mint so it's never deployed into again.",
      parameters: {
        type: "object",
        properties: {
          mint: { type: "string", description: "The base token mint address to blacklist" },
          symbol: { type: "string", description: "Token symbol" },
          reason: { type: "string", description: "Why this token is being blacklisted" }
        },
        required: ["mint", "reason"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "remove_from_blacklist",
      description: "Remove a token mint from the blacklist.",
      parameters: {
        type: "object",
        properties: { mint: { type: "string", description: "The mint address to remove" } },
        required: ["mint"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "list_blacklist",
      description: "List all blacklisted token mints with their reasons.",
      parameters: { type: "object", properties: {} }
    }
  },

  // ─── Token Narrative ────────────────────────────────────────────

  {
    type: "function",
    function: {
      name: "get_token_narrative",
      description: `Get the narrative/story behind a token from Jupiter ChainInsight.
Returns a plain-text description of what the token is about.
GOOD signals: specific origin story, active community, trending catalyst, named entities.
BAD signals: empty/null, pure hype only, completely generic, copy-paste of another token.`,
      parameters: {
        type: "object",
        properties: {
          mint: { type: "string", description: "Token mint address (base58)" }
        },
        required: ["mint"]
      }
    }
  }
];
