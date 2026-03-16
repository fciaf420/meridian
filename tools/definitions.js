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

You have autonomy to choose strategy and range based on pool metrics.

HARD RULES:
- Strategy: 'spot' or 'bid_ask' ONLY. Never use 'curve'.
- Bin Step: Only deploy in pools with bin_step between 80 and 125.

Guidelines:
- Range: total bins (below + above + 1) cannot exceed 70.
- Deposit: Can be single-sided (SOL only or Base only) or dual-sided.

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
            enum: ["bid_ask"],
            description: "DLMM strategy type. Only bid_ask is allowed."
          },
          bins_below: {
            type: "number",
            description: "Number of bins below active bin. Choose 35–69 based on pool volatility. Low volatility → 35–45. High volatility → 55–69."
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
- { managementModel: "openrouter/healer-alpha" }  — switch management cycle model
- { screeningModel: "openrouter/healer-alpha" }   — switch screening cycle model

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

  // ═══════════════════════════════════════════
  //  SMART WALLET TOOLS
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "add_smart_wallet",
      description: `Add a wallet to the smart wallet tracker.
Use when the user says "add smart wallet", "track this wallet", "add to smart wallets", etc.
Tracked wallets are used to check if high-confidence LPers are in a pool before deploying.`,
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Label for this wallet (e.g. 'alpha-1', 'whale-sol')" },
          address: { type: "string", description: "Solana wallet address (base58)" },
          category: { type: "string", enum: ["alpha", "smart", "fast", "multi"], description: "Wallet type (default: alpha)" }
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

Examples:
- "PREFER: pools where top LPers hold < 30 min — scalping beats holding in high-volatility pairs"
- "AVOID: entering pools where top performers show avg_hold > 4h and low win_rate — they're stuck"`,
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
            description: "Optional tags e.g. ['hold_time', 'scalping', 'pool_type']"
          }
        },
        required: ["rule"]
      }
    }
  }
];
