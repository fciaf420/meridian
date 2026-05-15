import { config } from "../config.js";
import { getStateSummary } from "../state.js";
import { getPerformanceHistory, getPerformanceSummary } from "../lessons.js";
import { getDecisionSummary, getRecentDecisions } from "../decision-log.js";
import { getActiveStrategy, listStrategies } from "../strategy-library.js";
import { getSettings, saveSettings, SETTINGS_PATHS } from "./settings.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

const ACTIONS = {
  screen: {
    label: "Run screening scan",
    command: "meridian candidates --limit <n>",
    risk: "Reads live market APIs and applies Meridian's screening filters. It does not submit transactions.",
  },
  manage: {
    label: "Refresh wallet positions",
    command: "meridian positions",
    risk: "Reads wallet and position data. The web endpoint does not close, claim, or rebalance positions.",
  },
  deploy: {
    label: "Validate deploy candidate",
    command: "meridian deploy --pool <pool> --amount <sol> --dry-run",
    risk: "Live deploys create on-chain DLMM positions. The web preview validates the candidate and never signs transactions.",
  },
  close: {
    label: "Preview close",
    command: "meridian close --position <position> --dry-run",
    risk: "Live closes remove liquidity. The web preview never signs or submits transactions.",
  },
  claim: {
    label: "Preview fee claim",
    command: "meridian claim --position <position>",
    risk: "Live claims submit transactions. The web preview is informational only.",
  },
  swap: {
    label: "Preview swap",
    command: "meridian swap --from <mint> --to <mint> --amount <n> --dry-run",
    risk: "Live swaps use Jupiter. The web preview never creates a swap transaction.",
  },
};

const LIVE_CONFIRMATION = "EXECUTE_LIVE";
const tokenMetadataCache = new Map();
const poolSnapshotCache = new Map();
const webAgentState = {
  running: false,
  started_at: null,
  stopped_at: null,
  last_command: null,
  last_result: null,
};

function boolConfigured(value) {
  return typeof value === "string" ? value.trim().length > 0 : Boolean(value);
}

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 2) {
  const n = numeric(value);
  if (n == null) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function safeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || "Unknown error",
  };
}

function getMode() {
  return process.env.DRY_RUN === "true" ? "dry_run" : "live_capable";
}

function getCapabilities() {
  const liveEnabled = process.env.WEB_LIVE_TRADING_ENABLED === "true" && process.env.DRY_RUN === "false";
  return {
    wallet_private_key_configured: boolConfigured(process.env.WALLET_PRIVATE_KEY),
    rpc_configured: boolConfigured(process.env.RPC_URL),
    llm_configured: boolConfigured(process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY),
    telegram_configured: boolConfigured(process.env.TELEGRAM_BOT_TOKEN),
    helius_configured: boolConfigured(process.env.HELIUS_API_KEY),
    gmgn_configured: boolConfigured(config.gmgn?.apiKey || process.env.GMGN_API_KEY),
    lpagent_configured: boolConfigured(process.env.LPAGENT_API_KEY),
    live_actions_exposed_by_web: liveEnabled,
    live_browser_trading_enabled: liveEnabled,
  };
}

function getAgentStatus() {
  return {
    ...webAgentState,
    schedule: {
      managementIntervalMin: config.schedule.managementIntervalMin,
      screeningIntervalMin: config.schedule.screeningIntervalMin,
      healthCheckIntervalMin: config.schedule.healthCheckIntervalMin,
    },
    live_execution: getLiveGate("screen"),
  };
}

function getLiveGate(action = "execute") {
  const reasons = [];
  if (process.env.WEB_LIVE_TRADING_ENABLED !== "true") reasons.push("Set WEB_LIVE_TRADING_ENABLED=true.");
  if (process.env.DRY_RUN !== "false") reasons.push("Set DRY_RUN=false.");
  if (!boolConfigured(process.env.WALLET_PRIVATE_KEY)) reasons.push("Set WALLET_PRIVATE_KEY.");
  if (!boolConfigured(process.env.RPC_URL)) reasons.push("Set RPC_URL.");
  if (["screen", "manage"].includes(action) && !boolConfigured(process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY)) {
    reasons.push("Set OPENROUTER_API_KEY or LLM_API_KEY.");
  }
  return {
    ok: reasons.length === 0,
    confirmation: LIVE_CONFIRMATION,
    reasons,
  };
}

function scoreCandidate(pool) {
  const explicit = numeric(pool?.score);
  if (explicit != null) return explicit;

  const feeTvl = numeric(pool?.fee_active_tvl_ratio) ?? 0;
  const organic = numeric(pool?.organic_score ?? pool?.base?.organic) ?? 0;
  const volume = numeric(pool?.volume_window ?? pool?.volume) ?? 0;
  const holders = numeric(pool?.holders ?? pool?.token?.holders) ?? 0;
  return Math.round(Math.min(99, feeTvl * 700 + organic * 0.38 + volume / 15000 + holders / 1000));
}

function normalizeCandidate(pool, index = 0) {
  const baseSymbol = pool?.base?.symbol || pool?.token?.symbol || pool?.base_symbol;
  const quoteSymbol = pool?.quote?.symbol || pool?.quote_symbol;
  const poolAddress = pool?.pool || pool?.pool_address || pool?.address;
  const name = pool?.name || [baseSymbol, quoteSymbol].filter(Boolean).join(" / ") || "Unnamed DLMM pool";
  const activeTvl = numeric(pool?.active_tvl ?? pool?.tvl);
  const feeActiveTvlRatio = numeric(pool?.fee_active_tvl_ratio);
  const volatility = numeric(pool?.volatility);

  return {
    rank: index + 1,
    name,
    pool: poolAddress,
    base_mint: pool?.base?.mint || pool?.base_mint || pool?.token?.mint || null,
    base_symbol: baseSymbol || null,
    quote_symbol: quoteSymbol || null,
    bin_step: numeric(pool?.bin_step ?? pool?.dlmm_params?.bin_step),
    fee_pct: numeric(pool?.fee_pct),
    fee_active_tvl_ratio: feeActiveTvlRatio,
    active_tvl: activeTvl,
    volume_window: numeric(pool?.volume_window ?? pool?.volume),
    organic_score: numeric(pool?.organic_score ?? pool?.base?.organic),
    holders: numeric(pool?.holders ?? pool?.token?.holders),
    volatility,
    volatility_timeframe: pool?.volatility_timeframe || null,
    active_pct: numeric(pool?.active_pct),
    risk_level: numeric(pool?.risk_level),
    smart_money_buy: Boolean(pool?.smart_money_buy),
    price_vs_ath_pct: numeric(pool?.price_vs_ath_pct),
    score: scoreCandidate(pool),
    decision_hint: [
      feeActiveTvlRatio != null ? `Fee/active-TVL ${feeActiveTvlRatio}%` : null,
      activeTvl != null ? `active TVL $${Math.round(activeTvl).toLocaleString("en-US")}` : null,
      volatility != null ? `${volatility}% ${pool?.volatility_timeframe || "volatility"}` : null,
    ].filter(Boolean).join("; ") || "Review the pool metrics and local risk thresholds before acting.",
    raw: pool,
  };
}

async function loadTopCandidates(limit, services = {}) {
  if (services.getTopCandidates) return services.getTopCandidates({ limit });
  const { getTopCandidates } = await import("../tools/screening.js");
  return getTopCandidates({ limit });
}

async function loadPositions(services = {}) {
  if (services.getMyPositions) return services.getMyPositions({ force: true, silent: true });
  const { getMyPositions } = await import("../tools/dlmm.js");
  return getMyPositions({ force: true, silent: true });
}

async function loadPoolDetail(poolAddress, services = {}) {
  if (services.getPoolDetail) {
    return services.getPoolDetail({ pool_address: poolAddress, timeframe: config.screening.timeframe || "5m" });
  }
  const { getPoolDetail } = await import("../tools/screening.js");
  return getPoolDetail({ pool_address: poolAddress, timeframe: config.screening.timeframe || "5m" });
}

async function loadPoolSnapshots(poolAddresses = [], services = {}) {
  const uniquePools = [...new Set(poolAddresses.filter(Boolean))].slice(0, 30);
  if (uniquePools.length === 0) return {};
  if (services.getPoolSnapshots) return services.getPoolSnapshots({ pools: uniquePools });

  const output = {};
  const missing = [];
  const now = Date.now();
  for (const pool of uniquePools) {
    const cached = poolSnapshotCache.get(pool);
    if (cached && now - cached.at < 30_000) {
      output[pool] = cached.value;
    } else {
      missing.push(pool);
    }
  }

  await Promise.all(missing.map(async (pool) => {
    try {
      const response = await fetch(`https://dlmm.datapi.meteora.ag/pools/${encodeURIComponent(pool)}`);
      if (!response.ok) return;
      const data = await response.json();
      const snapshot = {
        address: data.address || pool,
        name: data.name || null,
        current_price: round(data.current_price, 12),
        tvl: round(data.tvl, 2),
        dynamic_fee_pct: round(data.dynamic_fee_pct, 4),
        bin_step: round(data.pool_config?.bin_step ?? data.bin_step, 0),
        base_fee_pct: round(data.pool_config?.base_fee_pct, 4),
        fee_tvl_ratio_24h: round(data.fee_tvl_ratio?.["24h"] ?? data.fee_tvl_ratio_24h, 4),
        volume_24h: round(data.volume?.["24h"], 2),
        fees_24h: round(data.fees?.["24h"], 2),
        token_x: data.token_x ? {
          mint: data.token_x.address,
          symbol: data.token_x.symbol,
          name: data.token_x.name,
          price: round(data.token_x.price, 12),
          market_cap: round(data.token_x.market_cap, 2),
          holders: round(data.token_x.holders, 0),
          verified: Boolean(data.token_x.is_verified),
        } : null,
        token_y: data.token_y ? {
          mint: data.token_y.address,
          symbol: data.token_y.symbol,
          name: data.token_y.name,
          price: round(data.token_y.price, 12),
          verified: Boolean(data.token_y.is_verified),
        } : null,
      };
      poolSnapshotCache.set(pool, { at: now, value: snapshot });
      output[pool] = snapshot;
    } catch {
      // Position rendering can still use wallet/PnL data if the pool snapshot endpoint is unavailable.
    }
  }));

  return output;
}

async function loadTokenMetadata(mints = [], services = {}) {
  const uniqueMints = [...new Set(mints.filter(Boolean))].slice(0, 100);
  if (uniqueMints.length === 0) return {};
  if (services.getTokenMetadata) return services.getTokenMetadata({ mints: uniqueMints });

  const missing = uniqueMints.filter((mint) => !tokenMetadataCache.has(mint));
  if (missing.length > 0) {
    try {
      const headers = process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {};
      const response = await fetch(`https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(missing.join(","))}`, { headers });
      if (response.ok) {
        const tokens = await response.json();
        for (const token of Array.isArray(tokens) ? tokens : []) {
          if (!token?.id) continue;
          tokenMetadataCache.set(token.id, {
            mint: token.id,
            name: token.name || "",
            symbol: token.symbol || "",
            icon: token.icon || "",
            isVerified: Boolean(token.isVerified),
          });
        }
      }
    } catch {
      // Token art is decorative; live trading should not depend on metadata fetches.
    }
    for (const mint of missing) {
      if (!tokenMetadataCache.has(mint)) tokenMetadataCache.set(mint, null);
    }
  }

  return Object.fromEntries(
    uniqueMints.map((mint) => [mint, tokenMetadataCache.get(mint)]),
  );
}

export function getHealth(now = new Date()) {
  return {
    ok: true,
    app: "Meridian",
    service: "web-api",
    mode: getMode(),
    dry_run_env: process.env.DRY_RUN === "true",
    timestamp: now.toISOString(),
    capabilities: getCapabilities(),
    live_execution: getLiveGate(),
  };
}

export function getSafeConfig() {
  return {
    risk: {
      maxPositions: config.risk.maxPositions,
      maxDeployAmount: config.risk.maxDeployAmount,
    },
    screening: {
      source: config.screening.source,
      timeframe: config.screening.timeframe,
      category: config.screening.category,
      minTvl: config.screening.minTvl,
      maxTvl: config.screening.maxTvl,
      minVolume: config.screening.minVolume,
      minOrganic: config.screening.minOrganic,
      minHolders: config.screening.minHolders,
      minMcap: config.screening.minMcap,
      maxMcap: config.screening.maxMcap,
      minBinStep: config.screening.minBinStep,
      maxBinStep: config.screening.maxBinStep,
      minFeeActiveTvlRatio: config.screening.minFeeActiveTvlRatio,
      blockedLaunchpads: config.screening.blockedLaunchpads,
    },
    management: {
      deployAmountSol: config.management.deployAmountSol,
      minSolToOpen: config.management.minSolToOpen,
      gasReserve: config.management.gasReserve,
      takeProfitPct: config.management.takeProfitPct,
      stopLossPct: config.management.stopLossPct,
      trailingTakeProfit: config.management.trailingTakeProfit,
      trailingTriggerPct: config.management.trailingTriggerPct,
      trailingDropPct: config.management.trailingDropPct,
      minClaimAmount: config.management.minClaimAmount,
      outOfRangeWaitMinutes: config.management.outOfRangeWaitMinutes,
      minFeePerTvl24h: config.management.minFeePerTvl24h,
      solMode: config.management.solMode,
    },
    strategy: config.strategy,
    schedule: config.schedule,
    llm: {
      managementModel: config.llm.managementModel,
      screeningModel: config.llm.screeningModel,
      generalModel: config.llm.generalModel,
      maxSteps: config.llm.maxSteps,
      maxTokens: config.llm.maxTokens,
      temperature: config.llm.temperature,
    },
    api: {
      agentMeridianApiUrlConfigured: boolConfigured(process.env.AGENT_MERIDIAN_API_URL),
      lpAgentRelayEnabled: Boolean(config.api?.lpAgentRelayEnabled),
    },
  };
}

function getOverview(now) {
  return {
    health: getHealth(now),
    config: getSafeConfig(),
    state: getStateSummary(),
    performance: getPerformanceSummary(),
    decisions: {
      recent: getRecentDecisions(6),
      summary: getDecisionSummary(6),
    },
    strategies: listStrategies(),
    active_strategy: getActiveStrategy(),
    workflow: {
      core_surfaces: ["screen", "manage", "deploy", "claim", "close", "swap", "learn", "decisions"],
      web_actions_are_preview_only: true,
      web_actions_are_preview_only: false,
      autonomous_loop_available: true,
      data_sources: ["live screening", "wallet positions", "local state", "decision log", "lessons"],
    },
  };
}

async function getCandidates(parsed, services = {}) {
  const limit = Math.min(20, Math.max(1, Number(parsed.searchParams.get("limit") || 8)));
  const generatedAt = new Date().toISOString();
  const result = await loadTopCandidates(limit, services);
  const candidates = (result?.candidates || result?.pools || [])
    .map((candidate, index) => normalizeCandidate(candidate, index));
  const metadata = await loadTokenMetadata(candidates.map((candidate) => candidate.base_mint), services);

  return {
    source: result?.source || config.screening.source || "meteora",
    live_fetch_enabled: true,
    generated_at: generatedAt,
    total_screened: result?.total_screened ?? result?.total ?? candidates.length,
    stage_counts: result?.stage_counts || null,
    filtered_examples: result?.filtered_examples || [],
    candidates: candidates.map((candidate) => ({
      ...candidate,
      token_icon: metadata[candidate.base_mint]?.icon || null,
      token_metadata: metadata[candidate.base_mint] || null,
    })),
  };
}

function buildPositionRange(position) {
  const lower = numeric(position.lower_bin);
  const upper = numeric(position.upper_bin);
  const active = numeric(position.active_bin);
  if (lower == null || upper == null || active == null) {
    return {
      available: false,
      status: position.in_range === false ? "out_of_range" : "unknown",
      label: position.in_range === false ? "Out of range" : "Range data unavailable",
    };
  }

  const min = Math.min(lower, upper);
  const max = Math.max(lower, upper);
  const width = Math.max(1, max - min);
  const activeOffset = active - min;
  const activePct = Math.max(0, Math.min(100, (activeOffset / width) * 100));
  const inRange = active >= min && active <= max && position.in_range !== false;
  const distanceToLower = active - min;
  const distanceToUpper = max - active;
  const side = active < min ? "below" : active > max ? "above" : "inside";
  const bars = Array.from({ length: 48 }, (_, index) => {
    const bin = Math.round(min + (width * index) / 47);
    const activeDistance = Math.abs(bin - active);
    const edgeDistance = Math.min(Math.abs(bin - min), Math.abs(bin - max));
    const edgeFade = Math.max(0.28, 1 - edgeDistance / Math.max(1, width / 2));
    return {
      bin,
      active: activeDistance <= Math.max(1, width / 96),
      height: Math.round((34 + edgeFade * 42) * 10) / 10,
    };
  });

  return {
    available: true,
    status: inRange ? "in_range" : "out_of_range",
    label: inRange ? "In range" : side === "below" ? "Below range" : "Above range",
    lower_bin: min,
    upper_bin: max,
    active_bin: active,
    width_bins: width,
    active_offset_bins: activeOffset,
    active_pct: round(activePct, 1),
    distance_to_lower_bins: distanceToLower,
    distance_to_upper_bins: distanceToUpper,
    side,
    bars,
  };
}

async function getPositions(services = {}) {
  const result = await loadPositions(services);
  const positions = Array.isArray(result?.positions) ? result.positions : [];
  const metadata = await loadTokenMetadata(positions.map((position) => position.base_mint), services);
  const poolSnapshots = await loadPoolSnapshots(positions.map((position) => position.pool), services);
  return {
    source: "wallet",
    generated_at: new Date().toISOString(),
    positions: positions.map((position) => {
      const pool = poolSnapshots[position.pool] || null;
      const baseMint = position.base_mint || pool?.token_x?.mint || null;
      return {
        ...position,
        base_mint: baseMint,
        token_icon: metadata[baseMint]?.icon || null,
        token_metadata: metadata[baseMint] || null,
        pool_snapshot: pool,
        range: buildPositionRange(position),
      };
    }),
    total_positions: result?.total_positions ?? positions.length,
  };
}

async function previewAction(body = {}, services = {}) {
  const action = String(body.action || "").trim().toLowerCase();
  const spec = ACTIONS[action];
  if (!spec) {
    return {
      status: 400,
      body: {
        error: "Unknown action.",
        allowed_actions: Object.keys(ACTIONS),
      },
    };
  }

  const inputs = body.inputs || {};
  let validation = { checked: false, status: "not_required" };
  let detail = null;

  if (action === "deploy") {
    const pool = String(inputs.pool || inputs.pool_address || "").trim();
    if (!pool) {
      return {
        status: 400,
        body: {
          error: "Pool address is required for deploy preview.",
          required: ["inputs.pool"],
        },
      };
    }

    try {
      detail = await loadPoolDetail(pool, services);
      validation = {
        checked: true,
        status: "ready_for_operator_review",
        pool_name: detail?.name || pool,
        tvl: numeric(detail?.tvl ?? detail?.active_tvl),
        bin_step: numeric(detail?.dlmm_params?.bin_step ?? detail?.bin_step),
        fee_active_tvl_ratio: numeric(detail?.fee_active_tvl_ratio),
        volatility: numeric(detail?.volatility),
      };
    } catch (error) {
      validation = {
        checked: true,
        status: "pool_detail_unavailable",
        error: safeError(error),
      };
    }
  }

  return {
    status: 200,
    body: {
      action,
      ...spec,
      accepted: true,
      executed: false,
      dry_run_only: process.env.DRY_RUN === "true",
      live_execution: getLiveGate(action),
      inputs,
      validation,
      detail,
    },
  };
}

function buildToolCall(action, inputs = {}) {
  if (action === "deploy") {
    const poolAddress = String(inputs.pool_address || inputs.pool || "").trim();
    if (!poolAddress) throw new Error("Pool address is required.");
    return {
      tool: "deploy_position",
      args: {
        pool_address: poolAddress,
        amount_y: numeric(inputs.amount_y ?? inputs.amount_sol ?? inputs.amount),
        amount_sol: numeric(inputs.amount_sol ?? inputs.amount_y ?? inputs.amount),
        amount_x: numeric(inputs.amount_x ?? 0) ?? 0,
        strategy: inputs.strategy || undefined,
        bins_below: inputs.bins_below == null || inputs.bins_below === "" ? undefined : Number(inputs.bins_below),
        bins_above: inputs.bins_above == null || inputs.bins_above === "" ? undefined : Number(inputs.bins_above),
        pool_name: inputs.pool_name || undefined,
        base_mint: inputs.base_mint || undefined,
        bin_step: inputs.bin_step == null || inputs.bin_step === "" ? undefined : Number(inputs.bin_step),
        base_fee: inputs.base_fee == null || inputs.base_fee === "" ? undefined : Number(inputs.base_fee),
        volatility: inputs.volatility == null || inputs.volatility === "" ? undefined : Number(inputs.volatility),
        fee_tvl_ratio: inputs.fee_tvl_ratio == null || inputs.fee_tvl_ratio === "" ? undefined : Number(inputs.fee_tvl_ratio),
        organic_score: inputs.organic_score == null || inputs.organic_score === "" ? undefined : Number(inputs.organic_score),
        initial_value_usd: inputs.initial_value_usd == null || inputs.initial_value_usd === "" ? undefined : Number(inputs.initial_value_usd),
      },
    };
  }
  if (action === "claim") {
    const position = String(inputs.position_address || inputs.position || "").trim();
    if (!position) throw new Error("Position address is required.");
    return { tool: "claim_fees", args: { position_address: position } };
  }
  if (action === "close") {
    const position = String(inputs.position_address || inputs.position || "").trim();
    if (!position) throw new Error("Position address is required.");
    return {
      tool: "close_position",
      args: {
        position_address: position,
        skip_swap: Boolean(inputs.skip_swap),
        reason: inputs.reason || "Web operator close",
      },
    };
  }
  if (action === "swap") {
    const inputMint = String(inputs.input_mint || inputs.from || "").trim();
    const outputMint = String(inputs.output_mint || inputs.to || "").trim();
    const amount = numeric(inputs.amount);
    if (!inputMint || !outputMint || !amount) throw new Error("Input mint, output mint, and amount are required.");
    return { tool: "swap_token", args: { input_mint: inputMint, output_mint: outputMint, amount } };
  }
  throw new Error(`Action ${action} is not directly executable.`);
}

async function executeAction(body = {}, services = {}) {
  const action = String(body.action || "").trim().toLowerCase();
  const spec = ACTIONS[action];
  if (!spec) return { status: 400, body: { error: "Unknown action.", allowed_actions: Object.keys(ACTIONS) } };

  const gate = getLiveGate(action);
  if (!gate.ok) return { status: 409, body: { error: "Live browser trading is not enabled.", live_execution: gate } };
  if (body.confirmation !== LIVE_CONFIRMATION) {
    return {
      status: 400,
      body: {
        error: `Set confirmation to ${LIVE_CONFIRMATION} to execute live actions.`,
        live_execution: gate,
      },
    };
  }

  const inputs = body.inputs || {};
  if (services.executeAction) {
    const result = await services.executeAction({ action, inputs, body });
    return { status: 200, body: { action, ...spec, executed: true, result } };
  }

  if (action === "screen") {
    const { runScreeningCycle } = await import("../index.js");
    const result = await runScreeningCycle({ silent: true });
    return { status: 200, body: { action, ...spec, executed: true, result: result || "No action taken" } };
  }
  if (action === "manage") {
    const { runManagementCycle } = await import("../index.js");
    const result = await runManagementCycle({ silent: true });
    return { status: 200, body: { action, ...spec, executed: true, result: result || "No action taken" } };
  }

  const { executeTool } = await import("../tools/executor.js");
  const { tool, args } = buildToolCall(action, inputs);
  const result = await executeTool(tool, args);
  const blocked = result?.blocked || result?.error;
  return {
    status: blocked ? 409 : 200,
    body: {
      action,
      ...spec,
      executed: !blocked,
      tool,
      args: {
        ...args,
        position_address: args.position_address ? shortRedacted(args.position_address) : undefined,
      },
      result,
    },
  };
}

async function startAutonomousAgent(body = {}, services = {}) {
  const gate = getLiveGate("screen");
  if (!gate.ok) return { status: 409, body: { error: "Autonomous loop is not ready to run live.", live_execution: gate } };
  if (body.confirmation !== LIVE_CONFIRMATION) {
    return {
      status: 400,
      body: {
        error: `Set confirmation to ${LIVE_CONFIRMATION} to start the autonomous live loop.`,
        live_execution: gate,
      },
    };
  }

  if (services.startAutonomousAgent) {
    const result = await services.startAutonomousAgent(body);
    webAgentState.running = true;
    webAgentState.started_at = new Date().toISOString();
    webAgentState.stopped_at = null;
    webAgentState.last_command = "start";
    webAgentState.last_result = result || null;
    return { status: 200, body: { ok: true, agent: getAgentStatus() } };
  }

  const { startCronJobs, runScreeningCycle } = await import("../index.js");
  startCronJobs();
  webAgentState.running = true;
  webAgentState.started_at = new Date().toISOString();
  webAgentState.stopped_at = null;
  webAgentState.last_command = "start";
  webAgentState.last_result = "Autonomous loop started. Immediate screening cycle queued.";

  runScreeningCycle({ silent: false })
    .then((result) => { webAgentState.last_result = result || "Immediate screening cycle completed."; })
    .catch((error) => { webAgentState.last_result = `Immediate screening failed: ${error.message}`; });

  return { status: 200, body: { ok: true, agent: getAgentStatus() } };
}

async function stopAutonomousAgent(body = {}, services = {}) {
  if (body.confirmation !== LIVE_CONFIRMATION) {
    return {
      status: 400,
      body: {
        error: `Set confirmation to ${LIVE_CONFIRMATION} to stop the autonomous loop.`,
      },
    };
  }

  if (services.stopAutonomousAgent) await services.stopAutonomousAgent(body);
  else {
    const { stopCronJobs } = await import("../index.js");
    stopCronJobs();
  }

  webAgentState.running = false;
  webAgentState.stopped_at = new Date().toISOString();
  webAgentState.last_command = "stop";
  webAgentState.last_result = "Autonomous loop stopped.";
  return { status: 200, body: { ok: true, agent: getAgentStatus() } };
}

function shortRedacted(value) {
  return typeof value === "string" && value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

function response(status, body, headers = JSON_HEADERS) {
  return { status, headers, body };
}

export async function handleApiRequest({
  method = "GET",
  url = "/",
  body = null,
  now = new Date(),
  services = {},
} = {}) {
  const parsed = new URL(url, "http://localhost");
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  const upperMethod = method.toUpperCase();

  if (upperMethod === "OPTIONS") return response(204, null);
  if (upperMethod === "GET" && path === "/") {
    return response(200, {
      app: "Meridian",
      service: "web-api",
      endpoints: [
        "/api/health",
        "/api/overview",
        "/api/config",
        "/api/settings",
        "/api/state",
        "/api/lessons",
        "/api/decisions",
        "/api/positions",
        "/api/candidates",
        "/api/agent/status",
        "/api/agent/start",
        "/api/agent/stop",
        "/api/actions/preview",
        "/api/actions/execute",
      ],
    });
  }
  if (upperMethod === "GET" && path === "/api/health") return response(200, getHealth(now));
  if (upperMethod === "GET" && path === "/api/overview") return response(200, getOverview(now));
  if (upperMethod === "GET" && path === "/api/config") return response(200, getSafeConfig());
  if (upperMethod === "GET" && path === "/api/settings") {
    return response(200, getSettings(services.settingsPaths || SETTINGS_PATHS));
  }
  if (upperMethod === "GET" && path === "/api/agent/status") return response(200, getAgentStatus());
  if (upperMethod === "POST" && path === "/api/settings") {
    try {
      return response(200, saveSettings(body || {}, services.settingsPaths || SETTINGS_PATHS));
    } catch (error) {
      return response(400, { error: error.message });
    }
  }
  if (upperMethod === "GET" && path === "/api/state") return response(200, getStateSummary());
  if (upperMethod === "GET" && path === "/api/lessons") {
    return response(200, {
      performance_summary: getPerformanceSummary(),
      performance_24h: getPerformanceHistory({ hours: 24, limit: 25 }),
    });
  }
  if (upperMethod === "GET" && path === "/api/decisions") {
    return response(200, {
      recent: getRecentDecisions(20),
      summary: getDecisionSummary(8),
    });
  }
  if (upperMethod === "GET" && path === "/api/positions") {
    try {
      return response(200, await getPositions(services));
    } catch (error) {
      return response(502, {
        error: "Unable to load wallet positions.",
        detail: safeError(error),
        positions: [],
        total_positions: 0,
      });
    }
  }
  if (upperMethod === "GET" && path === "/api/candidates") {
    try {
      return response(200, await getCandidates(parsed, services));
    } catch (error) {
      return response(502, {
        error: "Unable to load live screening candidates.",
        detail: safeError(error),
        source: config.screening.source || "meteora",
        live_fetch_enabled: true,
        candidates: [],
      });
    }
  }
  if (upperMethod === "POST" && path === "/api/actions/preview") {
    const preview = await previewAction(body || {}, services);
    return response(preview.status, preview.body);
  }
  if (upperMethod === "POST" && path === "/api/actions/execute") {
    try {
      const executed = await executeAction(body || {}, services);
      return response(executed.status, executed.body);
    } catch (error) {
      return response(500, { error: "Live action failed.", detail: safeError(error) });
    }
  }
  if (upperMethod === "POST" && path === "/api/agent/start") {
    try {
      const result = await startAutonomousAgent(body || {}, services);
      return response(result.status, result.body);
    } catch (error) {
      return response(500, { error: "Unable to start autonomous loop.", detail: safeError(error) });
    }
  }
  if (upperMethod === "POST" && path === "/api/agent/stop") {
    try {
      const result = await stopAutonomousAgent(body || {}, services);
      return response(result.status, result.body);
    } catch (error) {
      return response(500, { error: "Unable to stop autonomous loop.", detail: safeError(error) });
    }
  }

  return response(404, { error: "Not found", path });
}

export async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return null;
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

export async function sendNodeResponse(req, res) {
  try {
    const body = req.method === "POST" ? await readJsonBody(req) : null;
    const result = await handleApiRequest({ method: req.method, url: req.url, body });
    res.writeHead(result.status, result.headers);
    res.end(result.body == null ? "" : JSON.stringify(result.body, null, 2));
  } catch (error) {
    const isSyntax = error instanceof SyntaxError;
    res.writeHead(isSyntax ? 400 : 500, JSON_HEADERS);
    res.end(JSON.stringify({ error: isSyntax ? "Invalid JSON request body." : error.message }, null, 2));
  }
}
