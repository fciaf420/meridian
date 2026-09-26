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
active_tvl, volume, fee_active_tvl_ratio, volatility, organic_score,
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

Pass a pool address taken from get_my_positions, get_top_candidates or another tool result, never a guessed or constructed one.`,
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

deploy_position reads the active bin itself, so this is not a prerequisite for deploying; use it when you need the current price or bin for analysis or a report.`,
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

For two-sided spot: just pass your total SOL as amount_y + sol_split_pct. The executor auto-swaps the token portion via Jupiter. No need to pre-buy tokens.

PRIORITY ORDER for strategy and bins:
1. User explicitly specifies → always follow exactly (user override is absolute)
2. No user spec → use the configured strategy (config activeStrategy). Under "classic" that is bid_ask unless the two-sided spot conditions in your instructions are met. Under "evil_panda" it is single-sided SOL spot at the Evil Panda price_range_pct; this tool enforces that shape and rejects amount_x or sol_split_pct below 100.

STRATEGIES:
- 'bid_ask': Single-sided SOL below active bin. You only deposit SOL. bins_below = your range, bins_above = 0. As price drops, your SOL buys the base token bin by bin. You are NOT holding the token upfront — safer if it dumps.
- 'spot': Uniform liquidity distribution. Can be used THREE ways:
  (a) SOL-only spot: Only provide amount_y (SOL), no amount_x. Bins go BELOW active bin only (bins_below = range, bins_above = 0). Same direction as bid_ask but spot distribution instead of bid_ask curve.
  (b) Token-only spot: Only provide amount_x (base token), no amount_y. Bins go ABOVE active bin only (bins_below = 0, bins_above = range). You are selling the token as price rises.
  (c) Two-sided spot: Just provide total SOL as amount_y + sol_split_pct. Token is auto-swapped. The executor swaps the token portion via Jupiter and deploys with both sides. sol_split_pct is the % kept as SOL (100 = pure SOL). Unless the user gives a split, use 85-90.
Only 'bid_ask' and 'spot' are accepted; any other strategy is rejected.

SPOT BIN DIRECTION:
- SOL (quote token / Y) fills bins BELOW the active bin (active_bin minus N)
- Base token (X) fills bins ABOVE the active bin (active_bin plus N)
- If you only deposit SOL on spot → bins_below = range, bins_above = 0
- If you only deposit token on spot → bins_below = 0, bins_above = range
- If two-sided spot → just pass sol_split_pct + total SOL as amount_y. Bins are split automatically based on sol_split_pct.

SINGLE-SIDED (bid_ask) vs TWO-SIDED (spot):
- Single-sided = you do NOT hold the base token. SOL sits below price, only converts as price drops into your range. Safe default.
- Two-sided = the executor auto-swaps part of your SOL into the base token. If token dumps, your position loses more because you had exposure from the start. Requires conviction the token will hold or go up.
- bid_ask = concentrated bid curve below price. SOL converts to token as price drops into range. Ideal for earning fees on sell pressure.
- spot SOL-only = uniform distribution below price. Similar direction to bid_ask but different fee capture shape.
- spot two-sided = executor auto-swaps token portion, you hold both tokens. More fee capture but more downside risk.

WHEN TO USE WHICH:
- Meme tokens, new tokens, unproven tokens → ALWAYS bid_ask single-sided. Never take two-sided exposure on tokens you don't trust.
- High organic score (>85), strong holders, proven token → spot two-sided is OK if you believe in the token, with sol_split_pct 85-90.
- High volatility, trending, pumping → bid_ask. You earn fees from the sell pressure without holding the bag.
- Stable, range-bound, high volume → spot two-sided. More fee capture from both sides.
- When unsure → for autonomous runs use the active strategy from your instructions.

HARD RULES:
- Bin Step: Screening filters apply (config minBinStep/maxBinStep). If user specifies a pool, deploy regardless of bin step.

RANGE: Pass price_range_pct, the % price move the range covers from the active bin (80 = liquidity reaching down to 80% below the current price on a SOL-only position). The tool converts it to a bin count from the pool's bin_step, so the same % means the same coverage on any bin step; how wide to go is set by the range rules in your instructions. Positions wider than 69 bins are deployed over several transactions automatically; positions under 20 bins in total are rejected. Pass bins_below / bins_above only when you need an exact bin count.

Two-sided spot is checked before anything is sent (smart wallets on the pool, top-LPer win rate, 1h price stability, profitable prior spot deploys in pool memory); if any check fails the deploy is blocked with the reason. A second position in a pool already held is also blocked, as is a second pool on a base token already held when base_mint is passed.

This sends a real on-chain transaction unless the runner is in DRY_RUN mode.`,
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
            description: "DLMM strategy. 'bid_ask' = single-sided SOL only. 'spot' = uniform distribution; with sol_split_pct auto-swaps token portion via Jupiter for two-sided. If user specifies, use exactly what they said. Otherwise use the active strategy's lp_strategy field. Default: bid_ask."
          },
          bins_above: {
            type: "number",
            description: "Number of bins above active bin (token X side). Set > 0 when depositing base token (amount_x). For SOL-only positions (bid_ask or spot), this should be 0. For two-sided spot, set proportionally to token conviction."
          },
          bins_below: {
            type: "number",
            description: "Number of bins below active bin. NOT NEEDED if you provide price_range_pct instead (preferred)."
          },
          price_range_pct: {
            type: "number",
            description: "Preferred way to size the range: the % price move it covers from the active bin (downside for SOL-only positions), chosen by the range rules in your instructions. Bins are auto-calculated from the pool's bin_step."
          },
          sol_split_pct: {
            type: "number",
            description: "For two-sided spot only: % of total SOL to keep as SOL (below active bin). The rest is auto-swapped to base token via Jupiter. E.g. 88 = keep 88% as SOL / auto-swap 12% to token. Unless the user gives a split, use 85-90. If omitted with both amount_x and amount_y, bins split 50/50. For bid_ask or SOL-only spot, omit this. Bins are split proportionally."
          },
          pool_name: { type: "string", description: "Human-readable pool name for record-keeping" },
          base_mint: { type: "string", description: "Base token mint address — used to prevent duplicate token exposure across pools" },
          bin_step: { type: "number", description: "Pool bin step (from discover_pools)" },
          volatility: { type: "number", description: "Pool volatility at deploy time" },
          fee_tvl_ratio: { type: "number", description: "fee/TVL ratio at deploy time" },
          organic_score: { type: "number", description: "Base token organic score at deploy time" },
          initial_value_usd: { type: "number", description: "Estimated USD value being deployed" },
          study_avg_hold_hours: { type: "number", description: "Average hold time (hours) of top LPers in this pool from study_top_lpers. Used by management to compare your hold time." }
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
When to close is decided by the management rules in your instructions, not by this tool.
After withdrawing, it swaps the base tokens this close withdrew back to SOL (skipping dust under $0.10; in USDC mode the runner then settles the proceeds to USDC). The result includes pnl_usd, pnl_pct, txs, and a swap object; status "success_with_exposure" means the withdrawn tokens could not be swapped safely and remain in the wallet.

WARNING: This executes a real on-chain transaction. Cannot be undone.`,
      parameters: {
        type: "object",
        properties: {
          position_address: {
            type: "string",
            description: "The position public key to close"
          },
          reason: {
            type: "string",
            description: "Short close reason for the history, e.g. \"rule 5: yield dead\" or \"Judgment: yield dying on the 1h view\". Hard-rule closes are labelled automatically; give the reason for judgment closes."
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
      description: `Sell a closed position's leftover base token back to SOL via Jupiter (real on-chain transaction).
Use it only after close_position returned status "success_with_exposure" with swap.exposure_ui > 0: sell at most swap.exposure_ui of that close's base token, to SOL.
Limits enforced in code (a refused call returns blocked: true with the reason; report it to the owner instead of retrying):
- input_mint must be a token a close in the last 2h left unsold. Other wallet balances are not the agent's to sell.
- output_mint must be SOL. SOL→token buys are refused: deploy_position buys the token side of two-sided spot itself.
- The amount is clamped to what that close left unsold and is still in the wallet.
- Refused while that close's own swap has an unknown outcome and may still land (until swap.retry_not_before).
- Any swap whose price impact is above maxSwapPriceImpactPct (default 5%) is refused.
Not needed around deploys or normal closes: close_position already swaps its withdrawn base tokens back to SOL, and in USDC mode the runner settles to USDC automatically.
Returns success, the tx signature and the amounts in and out.`,
      parameters: {
        type: "object",
        properties: {
          input_mint: {
            type: "string",
            description: "Mint address of the closed position's base token to sell"
          },
          output_mint: {
            type: "string",
            description: "Must be SOL (So11111111111111111111111111111111111111112)"
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

Common keys (pass one as setting, with value and reason):
- takeProfitFeePct, stopLossPct (a negative PnL %, e.g. -15), trailingTakeProfit, trailingTriggerPct, trailingDropPct — exit thresholds
- maxVolatility, maxTvl, minTokenFeesSol, timeframe — screening filters
- managementIntervalMin, maxPositions, deployAmountSol, positionSizePct, gasReserve — cadence and sizing
- ohlcvBufferMult — candle-based range depth (1.0–1.8; raise after downside OOR / stop losses, lower when the deep part of ranges goes unused)
- managementModel, screeningModel — the LLM model for that cycle
Risk-relevant numeric keys are bounds-checked and out-of-range values are refused.

Entry-safety filters (blockTransferFeeAbovePct, blockTransferHook, blockPermanentDelegate,
blockFreezeAuthority, blockMintAuthority, blockPausable, blockNonTransferable, solFeePoolsOnly,
twapSpikeMaxPct, twapWindowMinutes) can only be TIGHTENED by you (turn a block on, lower a limit).
Disabling a guard or raising a limit is refused — only the user can loosen them.

Always provide a reason. This is logged as a lesson and visible in future cycles.`,
      parameters: {
        type: "object",
        properties: {
          setting: {
            type: "string",
            description: "The config key to change. e.g. managementIntervalMin, stopLossPct, takeProfitFeePct, deployAmountSol, maxPositions, timeframe, etc."
          },
          value: {
            description: "The new value for the setting (number, string, or boolean)"
          },
          reason: {
            type: "string",
            description: "Why you are making this change"
          }
        },
        required: ["setting", "value", "reason"]
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
      description: "Remove a wallet from the smart wallet tracker. It stops counting as a smart-wallet signal in screening immediately. Use only when the user asks to stop tracking that wallet.",
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
This is a key signal: low global_fees_sol means transactions are bundled or the token is a scam, which is why it is a hard deploy gate: below config.screening.minTokenFeesSol (default 30), do not deploy.

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

Returns: aggregate patterns (avg hold time, pct_top_winners, ROI) and per-LPer summaries.
pct_top_winners is the share of owners in the top-winners list (0-100), not a win rate.
Data comes from the Meridian study API, not LPAgent.`,
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
Returns aggregate patterns (avg hold time, pct_top_winners, ROI) and historical samples.
pct_top_winners is the share of owners in the top-winners list (0-100), not a win rate.

Use this before deploying into a new pool to:
- See if top performers are scalpers (< 1h holds) or long-term holders.
- Match your strategy and range to what is actually working for others.
- Avoid pools where even the best performers have poor ROI.`,
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
Results are point-in-time and not cached; record anything worth keeping about a pool with add_pool_note.

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
      description: "Mark a saved strategy-library entry as the active reference. Screening cycles show it to the screener as a non-binding note (\"SAVED STRATEGY (reference, not mandatory)\"). It does not change the configured trading strategy (config.strategy.activeStrategy, e.g. evil_panda), the deploy defaults, or the exit rules; tell the user that when they ask to switch strategies. Use when the user asks to activate a saved strategy by id from list_strategies.",
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
      description: "Permanently delete a saved strategy from the library. If it was the active reference, the next saved strategy becomes active. Use only when the user asks to delete it.",
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
      description: "Remove a token mint from the blacklist so screening and deploys can use it again. Use only when the user asks; a mint blacklisted for a scam or rug reason should stay listed.",
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
  },

  // ─── Knowledge Base ──────────────────────────────────────────

  {
    type: "function",
    function: {
      name: "kb_read",
      description: `Read an article from the knowledge base. Pass "INDEX.md" (or omit path) to read the index — a table of contents of all articles with summaries. Pass "CONCEPTS.md" to read recurring themes. Pass a specific path (e.g. "pools/bonk-sol.md") to read a full article.
TIP: Always read INDEX.md first to find what you need, then drill into specific articles.`,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Article path within knowledge/ (e.g. 'INDEX.md', 'pools/bonk-sol.md'). Defaults to INDEX.md." }
        }
      }
    }
  },

  {
    type: "function",
    function: {
      name: "kb_write",
      description: `Write or update a markdown article in the knowledge base. Use this to file observations, compile analysis, or update existing articles.
Articles should be concise, interlinked using [[concept]] syntax, and organized into categories: pools/, strategies/, patterns/, lessons/, performance/.
The INDEX.md is auto-updated when you write an article. Writing an existing path overwrites the whole article.`,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Article path within knowledge/ (e.g. 'pools/bonk-sol.md')" },
          content: { type: "string", description: "Full markdown content of the article" }
        },
        required: ["path", "content"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "kb_search",
      description: `Full-text search across all knowledge base articles. Returns matching file paths with context lines.
Use this to find articles related to a topic before reading them in full.`,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text to search for across all articles" }
        },
        required: ["query"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "kb_list",
      description: "List all knowledge base articles, optionally filtered by category. Shows title, summary, word count, and last updated date.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", description: "Filter by category: pools, strategies, patterns, lessons, performance" },
          limit: { type: "number", description: "Max articles to return (default 50)" }
        }
      }
    }
  },

  {
    type: "function",
    function: {
      name: "kb_delete",
      description: "Permanently delete an article from the knowledge base and its INDEX.md entry. Use for articles that are wrong or merged into another; prefer kb_write to correct an article.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Article path to delete (e.g. 'pools/old-pool.md')" }
        },
        required: ["path"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "kb_migrate",
      description: `One-time migration: converts existing lessons.json and pool-memory.json data into initial knowledge base articles. Safe to re-run — skips articles that already exist. Also rebuilds INDEX.md and CONCEPTS.md.`,
      parameters: { type: "object", properties: {} }
    }
  },

  {
    type: "function",
    function: {
      name: "kb_stats",
      description: "Get knowledge base statistics: article count, word count, categories breakdown, and last updated timestamp.",
      parameters: { type: "object", properties: {} }
    }
  },

  {
    type: "function",
    function: {
      name: "kb_rebuild_indexes",
      description: "Rebuild INDEX.md and CONCEPTS.md from scratch by scanning all articles. Use after bulk writes or when indexes become out of sync.",
      parameters: { type: "object", properties: {} }
    }
  },

];
