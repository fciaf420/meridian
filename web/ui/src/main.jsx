import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AlertTriangle, Check, CircleDollarSign, Moon, Play, RefreshCw, Save, Settings, Shield, Sun, Terminal } from "lucide-react";
import { Alert as UiAlert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge as UiBadge } from "@/components/ui/badge";
import { Button as UiButton } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import "./styles.css";

const API_BASE = import.meta.env.VITE_API_BASE || "http://127.0.0.1:8787";
const THEME_STORAGE_KEY = "meridian-theme";

function getInitialTheme() {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

applyTheme(getInitialTheme());

const navItems = [
  ["Overview", "grid"],
  ["Screening", "queue"],
  ["Positions", "pulse"],
  ["Decisions", "timeline"],
  ["Actions", "play"],
  ["Settings", "sliders"],
];

function formatCurrency(value) {
  if (value == null) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatNumber(value, digits = 2) {
  if (value == null || Number.isNaN(Number(value))) return "-";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
  }).format(Number(value));
}

function formatPct(value, digits = 1) {
  if (value == null) return "-";
  return `${Number(value).toFixed(digits)}%`;
}

function formatSol(value, digits = 4) {
  if (value == null || Number.isNaN(Number(value))) return "-";
  return `${formatNumber(value, digits)} SOL`;
}

function formatAge(minutes) {
  if (minutes == null || Number.isNaN(Number(minutes))) return "-";
  const total = Math.max(0, Number(minutes));
  if (total < 60) return `${Math.floor(total)}m`;
  const hours = Math.floor(total / 60);
  const mins = Math.floor(total % 60);
  if (hours < 24) return `${hours}h ${mins}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function shortAddress(value) {
  if (!value) return "-";
  return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

function TokenAvatar({ icon, symbol, name }) {
  const label = symbol || name || "?";
  return icon ? (
    <img className="token-avatar" src={icon} alt="" loading="lazy" referrerPolicy="no-referrer" />
  ) : (
    <span className="token-avatar fallback" aria-hidden="true">{label.slice(0, 2).toUpperCase()}</span>
  );
}

async function fetchJson(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.detail?.message || data?.error || `${path} returned ${res.status}`);
  return data;
}

function normalizePoolSnapshot(data, fallbackAddress) {
  if (!data || typeof data !== "object") return null;
  return {
    address: data.address || fallbackAddress,
    name: data.name || null,
    current_price: data.current_price ?? null,
    tvl: data.tvl ?? null,
    dynamic_fee_pct: data.dynamic_fee_pct ?? null,
    bin_step: data.pool_config?.bin_step ?? data.bin_step ?? null,
    base_fee_pct: data.pool_config?.base_fee_pct ?? null,
    fee_tvl_ratio_24h: data.fee_tvl_ratio?.["24h"] ?? data.fee_tvl_ratio_24h ?? null,
    volume_24h: data.volume?.["24h"] ?? null,
    fees_24h: data.fees?.["24h"] ?? null,
    token_x: data.token_x ? {
      mint: data.token_x.address,
      symbol: data.token_x.symbol,
      name: data.token_x.name,
      price: data.token_x.price,
      market_cap: data.token_x.market_cap,
      holders: data.token_x.holders,
      verified: Boolean(data.token_x.is_verified),
    } : null,
    token_y: data.token_y ? {
      mint: data.token_y.address,
      symbol: data.token_y.symbol,
      name: data.token_y.name,
      price: data.token_y.price,
      verified: Boolean(data.token_y.is_verified),
    } : null,
  };
}

async function fetchPoolSnapshotsForPositions(positions) {
  const pools = [...new Set((positions || []).map((position) => position.pool).filter(Boolean))].slice(0, 20);
  if (pools.length === 0) return {};
  const entries = await Promise.all(pools.map(async (pool) => {
    try {
      const response = await fetch(`https://dlmm.datapi.meteora.ag/pools/${encodeURIComponent(pool)}`);
      if (!response.ok) return [pool, null];
      return [pool, normalizePoolSnapshot(await response.json(), pool)];
    } catch {
      return [pool, null];
    }
  }));
  return Object.fromEntries(entries.filter(([, snapshot]) => snapshot));
}

function Icon({ name }) {
  const common = { viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true" };
  const stroke = { stroke: "currentColor", strokeWidth: "1.75", strokeLinecap: "round", strokeLinejoin: "round" };

  if (name === "grid") return <svg {...common}><path {...stroke} d="M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v4H4zM14 15h6v4h-6z" /></svg>;
  if (name === "queue") return <svg {...common}><path {...stroke} d="M5 6h14M5 12h10M5 18h7" /><path {...stroke} d="m17 15 3 3-3 3" /></svg>;
  if (name === "pulse") return <svg {...common}><path {...stroke} d="M4 13h4l2-6 4 11 2-5h4" /></svg>;
  if (name === "timeline") return <svg {...common}><path {...stroke} d="M7 5v14M7 7h10M7 12h7M7 17h11" /><circle cx="7" cy="7" r="2" fill="currentColor" /><circle cx="7" cy="12" r="2" fill="currentColor" /><circle cx="7" cy="17" r="2" fill="currentColor" /></svg>;
  if (name === "sliders") return <svg {...common}><path {...stroke} d="M5 7h8M17 7h2M5 12h2M11 12h8M5 17h10" /><circle cx="15" cy="7" r="2" {...stroke} /><circle cx="9" cy="12" r="2" {...stroke} /><circle cx="17" cy="17" r="2" {...stroke} /></svg>;
  if (name === "play") return <svg {...common}><path d="M8 5.5v13l10-6.5-10-6.5Z" fill="currentColor" /></svg>;
  if (name === "refresh") return <svg {...common}><path {...stroke} d="M20 12a8 8 0 0 1-14.7 4.4M4 12A8 8 0 0 1 18.7 7.6" /><path {...stroke} d="M19 4v4h-4M5 20v-4h4" /></svg>;
  if (name === "lock") return <svg {...common}><path {...stroke} d="M7 10V8a5 5 0 0 1 10 0v2M6 10h12v10H6z" /></svg>;
  return <svg {...common}><circle cx="12" cy="12" r="8" {...stroke} /></svg>;
}

function Badge({ tone = "neutral", children }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

function Panel({ className = "", children }) {
  return <section className={`panel ${className}`}>{children}</section>;
}

function EmptyState({ title, detail, action }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <p>{detail}</p>
      {action}
    </div>
  );
}

function buildUiPositionRange(position) {
  const rawRange = position.range || {};
  const lower = Number(rawRange.lower_bin ?? position.lower_bin);
  const upper = Number(rawRange.upper_bin ?? position.upper_bin);
  const active = Number(rawRange.active_bin ?? position.active_bin);
  if (![lower, upper, active].every(Number.isFinite)) {
    return {
      available: false,
      status: rawRange.status || (position.in_range === false ? "out_of_range" : "unknown"),
      label: rawRange.label || (position.in_range === false ? "Out of range" : "Range data unavailable"),
    };
  }
  const min = Math.min(lower, upper);
  const max = Math.max(lower, upper);
  const width = Math.max(1, max - min);
  const activePct = Math.max(0, Math.min(100, ((active - min) / width) * 100));
  const inRange = active >= min && active <= max && position.in_range !== false;
  const quotePct = Math.round(activePct);
  const basePct = 100 - quotePct;
  const bars = Array.from({ length: 48 }, (_, index) => {
    const bin = Math.round(min + (width * index) / 47);
    const progress = index / 47;
    const leftHeavyWedge = 1 - progress;
    const side = index / 47 <= activePct / 100 ? "quote" : "base";
    return {
      bin,
      active: Math.abs(bin - active) <= Math.max(1, width / 96),
      side,
      height: Math.round((30 + leftHeavyWedge * 50) * 10) / 10,
    };
  });
  return {
    available: true,
    status: rawRange.status || (inRange ? "in_range" : "out_of_range"),
    label: rawRange.label || (inRange ? "In range" : active < min ? "Below range" : "Above range"),
    lower_bin: min,
    upper_bin: max,
    active_bin: active,
    width_bins: rawRange.width_bins ?? width,
    active_pct: Math.round(activePct * 10) / 10,
    distance_to_lower_bins: rawRange.distance_to_lower_bins ?? active - min,
    distance_to_upper_bins: rawRange.distance_to_upper_bins ?? max - active,
    base_pct: rawRange.base_pct ?? basePct,
    quote_pct: rawRange.quote_pct ?? quotePct,
    bars,
  };
}

function PositionRangeVisual({ position }) {
  const range = buildUiPositionRange(position) || {};
  const bars = Array.isArray(range.bars) ? range.bars : [];
  const activePct = range.active_pct ?? 50;

  if (!range.available) {
    return (
      <div className="position-range empty">
        <div className="range-empty-line" />
        <span>{range.label || "Range data unavailable"}</span>
      </div>
    );
  }

  return (
    <div className={`position-range ${range.status === "in_range" ? "in-range" : "out-range"}`}>
      <div className="range-legend">
        <span><i className="legend-dot base" />{position.pool_snapshot?.token_x?.symbol || position.token_metadata?.symbol || "Token"} {range.base_pct}%</span>
        <span><i className="legend-dot quote" />{position.pool_snapshot?.token_y?.symbol || "SOL"} {range.quote_pct}%</span>
      </div>
      <div className="range-bars" style={{ "--active-pct": `${activePct}%` }}>
        {bars.map((bar, index) => (
          <i
            key={`${bar.bin}-${index}`}
            className={`${bar.side || "quote"}${bar.active ? " active" : ""}`}
            style={{ "--bar-height": `${bar.height}%` }}
            title={`Bin ${bar.bin}`}
          />
        ))}
        <b aria-hidden="true" />
      </div>
      <div className="range-axis">
        <span>{range.lower_bin}</span>
        <span>Active {range.active_bin}</span>
        <span>{range.upper_bin}</span>
      </div>
    </div>
  );
}

function PositionDetailCard({ position }) {
  const snapshot = position.pool_snapshot || {};
  const range = buildUiPositionRange(position) || {};
  const tokenSymbol = snapshot.token_x?.symbol || position.token_metadata?.symbol || "Token";
  const quoteSymbol = snapshot.token_y?.symbol || "SOL";
  const valueLabel = snapshot.current_price != null
    ? `${formatNumber(snapshot.current_price, 10)} ${quoteSymbol}/${tokenSymbol}`
    : "Price unavailable";
  const pnlTone = Number(position.pnl_pct || 0) < 0 ? "negative" : "positive";

  return (
    <article className="position-card">
      <div className="position-card-head">
        <div className="token-cell">
          <TokenAvatar icon={position.token_icon} symbol={tokenSymbol} name={position.pair} />
          <div>
            <strong>{snapshot.name || position.pair || position.pool_name || shortAddress(position.pool)}</strong>
            <span>{shortAddress(position.position)} · Pool {shortAddress(position.pool)}</span>
          </div>
        </div>
        <Badge tone={range.status === "in_range" ? "success" : "warning"}>{range.label || (position.in_range === false ? "Out of range" : "In range")}</Badge>
      </div>

      <div className="position-stat-grid">
        <div>
          <span>PnL</span>
          <strong className={pnlTone}>{formatCurrency(position.pnl_true_usd ?? position.pnl_usd)} · {formatPct(position.pnl_pct, 2)}</strong>
        </div>
        <div>
          <span>Liquidity</span>
          <strong>{formatCurrency(position.total_value_true_usd ?? position.total_value_usd)}</strong>
        </div>
        <div>
          <span>Claimable fees</span>
          <strong>{formatCurrency(position.unclaimed_fees_true_usd ?? position.unclaimed_fees_usd)}</strong>
        </div>
        <div>
          <span>24h fees / TVL</span>
          <strong>{formatPct(position.fee_per_tvl_24h ?? snapshot.fee_tvl_ratio_24h, 2)}</strong>
        </div>
      </div>

      <PositionRangeVisual position={position} />

      <div className="position-detail-strip">
        <div><span>Pool price</span><strong>{valueLabel}</strong></div>
        <div><span>Range width</span><strong>{range.width_bins != null ? `${range.width_bins} bins` : "-"}</strong></div>
        <div><span>To lower</span><strong>{range.distance_to_lower_bins != null ? `${range.distance_to_lower_bins} bins` : "-"}</strong></div>
        <div><span>To upper</span><strong>{range.distance_to_upper_bins != null ? `${range.distance_to_upper_bins} bins` : "-"}</strong></div>
        <div><span>Held</span><strong>{formatAge(position.age_minutes)}</strong></div>
        <div><span>OOR time</span><strong>{formatAge(position.minutes_out_of_range)}</strong></div>
      </div>
    </article>
  );
}

function displaySettingValue(value) {
  if (value && typeof value === "object" && "value" in value) return value.value;
  if (Array.isArray(value)) return value.join(", ");
  if (value == null) return "";
  return String(value);
}

function buildSettingsForm(settings) {
  const form = { env: {}, userConfig: {}, gmgnConfig: {} };
  for (const group of Object.keys(form)) {
    for (const [key, value] of Object.entries(settings?.values?.[group] || {})) {
      form[group][key] = displaySettingValue(value);
    }
  }
  return form;
}

function updateNestedForm(setter, group, key, value) {
  setter((current) => ({
    ...current,
    [group]: {
      ...(current[group] || {}),
      [key]: value,
    },
  }));
}

function fieldIsSecret(field) {
  return field.type === "secret";
}

function hasSettingValue(value, keepSecret) {
  return value === keepSecret || String(value ?? "").trim().length > 0;
}

function getFieldRequirement(group, field, settingsForm, keepSecret) {
  const value = settingsForm?.[group]?.[field.key];
  const source = settingsForm?.userConfig?.screeningSource;
  const llmKeyPresent =
    hasSettingValue(settingsForm?.env?.OPENROUTER_API_KEY, keepSecret) ||
    hasSettingValue(settingsForm?.env?.LLM_API_KEY, keepSecret) ||
    hasSettingValue(settingsForm?.userConfig?.llmApiKey, keepSecret);

  if (group === "env" && ["WALLET_PRIVATE_KEY", "RPC_URL"].includes(field.key)) {
    return { label: "Required", tone: hasSettingValue(value, keepSecret) ? "ready" : "required" };
  }
  if (group === "env" && ["OPENROUTER_API_KEY", "LLM_API_KEY"].includes(field.key)) {
    return { label: llmKeyPresent ? "LLM ready" : "One required", tone: llmKeyPresent ? "ready" : "required" };
  }
  if (group === "userConfig" && field.key === "llmApiKey") {
    return { label: llmKeyPresent ? "LLM ready" : "One required", tone: llmKeyPresent ? "ready" : "required" };
  }
  if (group === "env" && ["DRY_RUN", "WEB_LIVE_TRADING_ENABLED"].includes(field.key)) {
    return { label: "Required for live", tone: "live" };
  }
  if ((group === "env" && field.key === "GMGN_API_KEY") || (group === "gmgnConfig" && field.key === "apiKey")) {
    return { label: source === "gmgn" ? "Required for GMGN" : "Optional", tone: source === "gmgn" ? "required" : "optional" };
  }
  if (field.required) return { label: "Required", tone: hasSettingValue(value, keepSecret) ? "ready" : "required" };
  if (fieldIsSecret(field)) return { label: "Secret", tone: "secret" };
  return { label: "Optional", tone: "optional" };
}

function SettingInput({ group, field, value, onChange, keepSecret }) {
  const secret = fieldIsSecret(field);
  const inputValue = secret && value === keepSecret ? "" : value ?? "";

  if (field.type === "boolean") {
    return (
      <select value={String(value === "" ? false : value)} onChange={(event) => onChange(event.target.value)}>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }

  if (field.type === "choice") {
    return (
      <select value={inputValue} onChange={(event) => onChange(event.target.value)}>
        <option value="">Unset</option>
        {(field.choices || []).map((choice) => (
          <option key={choice.key || choice} value={choice.key || choice}>
            {choice.label || choice.key || choice}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      type={field.type === "number" ? "number" : secret ? "password" : "text"}
      min={field.min}
      max={field.max}
      step={field.type === "number" ? "any" : undefined}
      value={inputValue}
      placeholder={secret && value === keepSecret ? "Configured - leave blank to keep" : field.type === "list" ? "comma, separated, values" : ""}
      onChange={(event) => onChange(event.target.value)}
      autoComplete={secret ? "new-password" : "off"}
      data-group={group}
    />
  );
}

function SettingsView({ settings, settingsForm, setSettingsForm, saving, saveSettingsNow }) {
  const readiness = settings?.readiness;
  const keepSecret = settings?.schema?.keepSecret || "__KEEP_SECRET__";
  const sections = [
    ["env", ".env", "Environment", "Secrets, provider keys, web runtime flags, and process-level values.", settings?.schema?.env || []],
    ["userConfig", "user-config.json", "User Config", "Core Meridian strategy, screening, deployment, schedules, and integrations.", settings?.schema?.userConfig || []],
    ["gmgnConfig", "gmgn-config.json", "GMGN Config", "GMGN scanner credentials, filters, ranking, enrichment, and token quality gates.", settings?.schema?.gmgnConfig || []],
  ];

  if (!settings) {
    return (
      <Panel>
        <EmptyState title="Loading settings" detail="Reading runtime, env, and config state." />
      </Panel>
    );
  }

  return (
    <section className="settings-workspace" aria-label="Runtime settings">
      <Card className="runtime-card">
        <CardHeader>
          <CardTitle>Runtime readiness</CardTitle>
          <CardDescription>Fill the required items, disable dry-run, and enable live browser trading to run Meridian fully from the web app.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="readiness-grid">
            {readiness?.checks?.map((check) => (
              <div key={check.id} className={check.ok ? "readiness-item ready" : check.required ? "readiness-item missing" : "readiness-item"}>
                {check.ok ? <Check data-icon="inline-start" /> : <AlertTriangle data-icon="inline-start" />}
                <span>{check.label}</span>
                <UiBadge variant={check.ok ? "secondary" : check.required ? "destructive" : "outline"}>
                  {check.ok ? "Ready" : check.required ? "Required" : "Optional"}
                </UiBadge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="settings-actions">
        <UiButton onClick={saveSettingsNow} disabled={saving}>
          <Save data-icon="inline-start" />
          {saving ? "Saving" : "Save settings"}
        </UiButton>
        <span>{settings.files?.exists?.env ? ".env found" : ".env will be created"}</span>
      </div>

      {sections.map(([group, fileName, title, description, groupSections]) => (
        <div key={group} className="settings-group">
          <div className="settings-bucket-heading">
            <div>
              <strong>{title}</strong>
              <span>{description}</span>
            </div>
            <UiBadge variant="outline">{fileName}</UiBadge>
          </div>
          {groupSections.map((section) => (
            <Card key={`${group}-${section.id}`} className="settings-card">
              <CardHeader>
                <CardTitle>{section.title}</CardTitle>
                {section.description && <CardDescription>{section.description}</CardDescription>}
              </CardHeader>
              <CardContent>
                <div className="settings-form-grid">
                  {section.fields.map((field) => (
                    <label key={`${group}-${field.key}`} className="setting-field">
                      <span className="setting-label">
                        <span>{field.label}</span>
                        {(() => {
                          const requirement = getFieldRequirement(group, field, settingsForm, keepSecret);
                          return <em className={`setting-requirement ${requirement.tone}`}>{requirement.label}</em>;
                        })()}
                      </span>
                      <SettingInput
                        group={group}
                        field={field}
                        value={settingsForm?.[group]?.[field.key] ?? ""}
                        keepSecret={keepSecret}
                        onChange={(value) => updateNestedForm(setSettingsForm, group, field.key, value)}
                      />
                    </label>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ))}
    </section>
  );
}

function ActionInput({ label, value, onChange, type = "text", placeholder = "" }) {
  return (
    <label className="setting-field">
      <span>{label}</span>
      <input type={type} value={value ?? ""} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function ActionCenter({
  selected,
  actionForm,
  setActionForm,
  liveGate,
  agentStatus,
  previewAction,
  executeLiveAction,
  startAutonomousLoop,
  stopAutonomousLoop,
  loading,
  result,
}) {
  const setValue = (key, value) => setActionForm((current) => ({ ...current, [key]: value }));
  const liveReady = liveGate?.ok;

  return (
    <section className="action-workspace" aria-label="Live web controls">
      <Card className="runtime-card">
        <CardHeader>
          <CardTitle>Live control center</CardTitle>
          <CardDescription>These controls call Meridian's existing bot tools from the browser. When live trading is enabled and dry-run is false, Execute runs real on-chain actions.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="live-status">
            <UiBadge variant={liveReady ? "secondary" : "destructive"}>{liveReady ? "Live execution ready" : "Live execution blocked"}</UiBadge>
            {!liveReady && <span>{liveGate?.reasons?.join(" ") || "Open Settings and fill runtime env."}</span>}
          </div>
        </CardContent>
      </Card>

      <div className="action-grid">
        <Card className="action-card autonomous-card">
          <CardHeader>
            <CardTitle><Play data-icon="inline-start" /> Autonomous loop</CardTitle>
            <CardDescription>Start the same scheduled Meridian loop as `npm run start`: management, screening, health checks, briefing, and PnL polling.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="loop-status">
              <UiBadge variant={agentStatus?.running ? "secondary" : "outline"}>
                {agentStatus?.running ? "Loop running" : "Loop stopped"}
              </UiBadge>
              <span>
                Management every {agentStatus?.schedule?.managementIntervalMin ?? "-"}m,
                screening every {agentStatus?.schedule?.screeningIntervalMin ?? "-"}m
              </span>
            </div>
            {agentStatus?.last_result && <p className="loop-note">{agentStatus.last_result}</p>}
            <div className="action-buttons">
              <UiButton onClick={startAutonomousLoop} disabled={loading.action || !liveReady || agentStatus?.running}>
                <Play data-icon="inline-start" /> Start autonomous loop
              </UiButton>
              <UiButton variant="outline" onClick={stopAutonomousLoop} disabled={loading.action || !agentStatus?.running}>
                Stop loop
              </UiButton>
            </div>
          </CardContent>
        </Card>

        <Card className="action-card">
          <CardHeader>
            <CardTitle><CircleDollarSign data-icon="inline-start" /> Deploy position</CardTitle>
            <CardDescription>Open a DLMM position in the selected or manually entered pool.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="settings-form-grid">
              <ActionInput label="Pool address" value={actionForm.pool} placeholder={selected?.pool || "DLMM pool address"} onChange={(value) => setValue("pool", value)} />
              <ActionInput label="Amount SOL" type="number" value={actionForm.amount_sol} onChange={(value) => setValue("amount_sol", value)} />
              <ActionInput label="Bins below" type="number" value={actionForm.bins_below} onChange={(value) => setValue("bins_below", value)} />
              <ActionInput label="Bins above" type="number" value={actionForm.bins_above} onChange={(value) => setValue("bins_above", value)} />
            </div>
            <div className="action-buttons">
              <UiButton variant="outline" onClick={() => previewAction("deploy", { pool: actionForm.pool || selected?.pool, amount_sol: actionForm.amount_sol })} disabled={loading.action}>
                <Terminal data-icon="inline-start" /> Preview
              </UiButton>
              <UiButton onClick={() => executeLiveAction("deploy")} disabled={loading.action || !liveReady}>
                <Play data-icon="inline-start" /> Execute live
              </UiButton>
            </div>
          </CardContent>
        </Card>

        <Card className="action-card">
          <CardHeader>
            <CardTitle><RefreshCw data-icon="inline-start" /> Bot cycles</CardTitle>
            <CardDescription>Run screening or management exactly like the terminal bot.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="action-buttons wrap">
              <UiButton onClick={() => executeLiveAction("screen")} disabled={loading.action || !liveReady}>Run screening</UiButton>
              <UiButton onClick={() => executeLiveAction("manage")} disabled={loading.action || !liveReady}>Run management</UiButton>
              <UiButton variant="outline" onClick={() => previewAction("screen")} disabled={loading.action}>Refresh queue</UiButton>
              <UiButton variant="outline" onClick={() => previewAction("manage")} disabled={loading.action}>Refresh positions</UiButton>
            </div>
          </CardContent>
        </Card>

        <Card className="action-card">
          <CardHeader>
            <CardTitle><Shield data-icon="inline-start" /> Position actions</CardTitle>
            <CardDescription>Claim fees or close a position by address.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="settings-form-grid">
              <ActionInput label="Position address" value={actionForm.position} onChange={(value) => setValue("position", value)} />
              <ActionInput label="Close reason" value={actionForm.reason} onChange={(value) => setValue("reason", value)} />
            </div>
            <div className="action-buttons">
              <UiButton onClick={() => executeLiveAction("claim")} disabled={loading.action || !liveReady}>Claim fees</UiButton>
              <UiButton variant="destructive" onClick={() => executeLiveAction("close")} disabled={loading.action || !liveReady}>Close position</UiButton>
            </div>
          </CardContent>
        </Card>

        <Card className="action-card">
          <CardHeader>
            <CardTitle><Settings data-icon="inline-start" /> Swap</CardTitle>
            <CardDescription>Swap tokens through Jupiter using the configured wallet.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="settings-form-grid">
              <ActionInput label="Input mint" value={actionForm.input_mint} onChange={(value) => setValue("input_mint", value)} />
              <ActionInput label="Output mint" value={actionForm.output_mint} onChange={(value) => setValue("output_mint", value)} />
              <ActionInput label="Amount" type="number" value={actionForm.amount} onChange={(value) => setValue("amount", value)} />
            </div>
            <div className="action-buttons">
              <UiButton onClick={() => executeLiveAction("swap")} disabled={loading.action || !liveReady}>Execute swap</UiButton>
            </div>
          </CardContent>
        </Card>
      </div>

      {result && (
        <UiAlert className="action-result" variant={result.error ? "destructive" : "default"}>
          <AlertTitle>{result.error ? "Action failed" : "Action result"}</AlertTitle>
          <AlertDescription>
            <pre>{JSON.stringify(result, null, 2)}</pre>
          </AlertDescription>
        </UiAlert>
      )}
    </section>
  );
}

function App() {
  const [theme, setTheme] = useState(getInitialTheme);
  const [activeNav, setActiveNav] = useState("Overview");
  const [health, setHealth] = useState(null);
  const [overview, setOverview] = useState(null);
  const [candidatesMeta, setCandidatesMeta] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [positions, setPositions] = useState([]);
  const [selectedPool, setSelectedPool] = useState(null);
  const [preview, setPreview] = useState(null);
  const [settings, setSettings] = useState(null);
  const [settingsForm, setSettingsForm] = useState({ env: {}, userConfig: {}, gmgnConfig: {} });
  const [agentStatus, setAgentStatus] = useState(null);
  const [actionForm, setActionForm] = useState({
    pool: "",
    amount_sol: "",
    bins_below: "",
    bins_above: "0",
    position: "",
    reason: "Web operator action",
    input_mint: "",
    output_mint: "",
    amount: "",
  });
  const [actionResult, setActionResult] = useState(null);
  const [loading, setLoading] = useState({ boot: true, candidates: false, positions: false, action: false, settings: false });
  const [errors, setErrors] = useState({});
  const isDark = theme === "dark";

  useEffect(() => {
    applyTheme(theme);
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  async function loadOverview() {
    const [healthData, overviewData] = await Promise.all([
      fetchJson("/api/health"),
      fetchJson("/api/overview"),
    ]);
    setHealth(healthData);
    setOverview(overviewData);
  }

  async function loadCandidates({ silent = false } = {}) {
    if (!silent) setLoading((value) => ({ ...value, candidates: true }));
    try {
      const data = await fetchJson("/api/candidates?limit=8");
      setCandidatesMeta(data);
      setCandidates(data.candidates || []);
      setSelectedPool((current) => current || data.candidates?.[0]?.pool || null);
      setErrors((value) => ({ ...value, candidates: null }));
    } catch (error) {
      setCandidates([]);
      setCandidatesMeta(null);
      setErrors((value) => ({ ...value, candidates: error.message }));
    } finally {
      setLoading((value) => ({ ...value, candidates: false }));
    }
  }

  async function loadSettings() {
    const data = await fetchJson("/api/settings");
    setSettings(data);
    setSettingsForm(buildSettingsForm(data));
    return data;
  }

  async function loadAgentStatus() {
    const data = await fetchJson("/api/agent/status");
    setAgentStatus(data);
    return data;
  }

  async function loadPositions({ silent = false } = {}) {
    if (!silent) setLoading((value) => ({ ...value, positions: true }));
    try {
      const data = await fetchJson("/api/positions");
      const rawPositions = data.positions || [];
      const snapshots = await fetchPoolSnapshotsForPositions(rawPositions);
      setPositions(rawPositions.map((position) => ({
        ...position,
        pool_snapshot: position.pool_snapshot || snapshots[position.pool] || null,
      })));
      setErrors((value) => ({ ...value, positions: null }));
    } catch (error) {
      setPositions([]);
      setErrors((value) => ({ ...value, positions: error.message }));
    } finally {
      setLoading((value) => ({ ...value, positions: false }));
    }
  }

  useEffect(() => {
    let alive = true;
    async function boot() {
      try {
        await loadOverview();
        if (!alive) return;
        await Promise.all([loadCandidates({ silent: true }), loadPositions({ silent: true }), loadSettings(), loadAgentStatus()]);
      } catch (error) {
        if (!alive) return;
        setErrors((value) => ({ ...value, boot: error.message }));
      } finally {
        if (alive) setLoading((value) => ({ ...value, boot: false }));
      }
    }
    boot();
    const id = window.setInterval(() => {
      loadOverview().catch(() => {});
      loadPositions({ silent: true }).catch(() => {});
      loadAgentStatus().catch(() => {});
    }, 30000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const selected = useMemo(
    () => candidates.find((candidate) => candidate.pool === selectedPool) || candidates[0] || null,
    [candidates, selectedPool],
  );

  useEffect(() => {
    if (!selected?.pool) return;
    setActionForm((current) => current.pool ? current : ({
      ...current,
      pool: selected.pool,
      amount_sol: String(overview?.config?.management?.deployAmountSol ?? 0.5),
      bins_below: String(overview?.config?.strategy?.defaultBinsBelow ?? 69),
      bins_above: "0",
    }));
  }, [selected?.pool, overview?.config?.management?.deployAmountSol, overview?.config?.strategy?.defaultBinsBelow]);

  async function previewAction(action, candidate = selected) {
    setLoading((value) => ({ ...value, action: true }));
    try {
      if (action === "screen") {
        await loadCandidates();
      }
      if (action === "manage") {
        await loadPositions();
      }
      const data = await fetchJson("/api/actions/preview", {
        method: "POST",
        body: JSON.stringify({
          action,
          inputs: {
            pool: candidate?.pool,
            amount_sol: overview?.config?.management?.deployAmountSol ?? 0.5,
          },
        }),
      });
      setPreview(data);
      setErrors((value) => ({ ...value, action: null }));
    } catch (error) {
      setErrors((value) => ({ ...value, action: error.message }));
      setPreview(null);
    } finally {
      setLoading((value) => ({ ...value, action: false }));
    }
  }

  async function saveSettingsNow() {
    setLoading((value) => ({ ...value, settings: true }));
    try {
      const result = await fetchJson("/api/settings", {
        method: "POST",
        body: JSON.stringify(settingsForm),
      });
      setSettings(result.settings);
      setSettingsForm(buildSettingsForm(result.settings));
      setErrors((value) => ({ ...value, settings: null }));
      await loadOverview();
    } catch (error) {
      setErrors((value) => ({ ...value, settings: error.message }));
    } finally {
      setLoading((value) => ({ ...value, settings: false }));
    }
  }

  async function executeLiveAction(action) {
    setLoading((value) => ({ ...value, action: true }));
    setActionResult(null);
    const inputs = {
      pool: actionForm.pool || selected?.pool,
      amount_sol: actionForm.amount_sol || overview?.config?.management?.deployAmountSol || 0.5,
      bins_below: actionForm.bins_below || overview?.config?.strategy?.defaultBinsBelow,
      bins_above: actionForm.bins_above || 0,
      position: actionForm.position,
      reason: actionForm.reason,
      input_mint: actionForm.input_mint,
      output_mint: actionForm.output_mint,
      amount: actionForm.amount,
    };
    try {
      const data = await fetchJson("/api/actions/execute", {
        method: "POST",
        body: JSON.stringify({ action, inputs, confirmation: "EXECUTE_LIVE" }),
      });
      setActionResult(data);
      setPreview(data);
      setErrors((value) => ({ ...value, action: null }));
      await Promise.all([loadOverview().catch(() => {}), loadPositions({ silent: true }).catch(() => {})]);
    } catch (error) {
      const result = { error: error.message, action };
      setActionResult(result);
      setErrors((value) => ({ ...value, action: error.message }));
    } finally {
      setLoading((value) => ({ ...value, action: false }));
    }
  }

  async function startAutonomousLoop() {
    setLoading((value) => ({ ...value, action: true }));
    setActionResult(null);
    try {
      const data = await fetchJson("/api/agent/start", {
        method: "POST",
        body: JSON.stringify({ confirmation: "EXECUTE_LIVE" }),
      });
      setAgentStatus(data.agent);
      setActionResult(data);
      setErrors((value) => ({ ...value, action: null }));
      await loadOverview().catch(() => {});
    } catch (error) {
      setActionResult({ error: error.message, action: "start-autonomous-loop" });
      setErrors((value) => ({ ...value, action: error.message }));
    } finally {
      setLoading((value) => ({ ...value, action: false }));
    }
  }

  async function stopAutonomousLoop() {
    setLoading((value) => ({ ...value, action: true }));
    setActionResult(null);
    try {
      const data = await fetchJson("/api/agent/stop", {
        method: "POST",
        body: JSON.stringify({ confirmation: "EXECUTE_LIVE" }),
      });
      setAgentStatus(data.agent);
      setActionResult(data);
      setErrors((value) => ({ ...value, action: null }));
    } catch (error) {
      setActionResult({ error: error.message, action: "stop-autonomous-loop" });
      setErrors((value) => ({ ...value, action: error.message }));
    } finally {
      setLoading((value) => ({ ...value, action: false }));
    }
  }

  const thresholds = overview?.config || {};
  const state = overview?.state || { open_positions: 0, closed_positions: 0, total_fees_claimed_usd: 0 };
  const decisions = overview?.decisions?.recent?.length
    ? overview.decisions.recent
    : [];
  const connected = !errors.boot && health?.ok;
  const statusTone = errors.boot ? "danger" : connected ? "success" : "warning";
  const liveGate = health?.live_execution || {
    ok: health?.capabilities?.live_browser_trading_enabled === true,
    reasons: health?.capabilities?.live_browser_trading_enabled ? [] : [
      "Set WEB_LIVE_TRADING_ENABLED=true and DRY_RUN=false in Settings.",
    ],
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">Skip to dashboard</a>
      <header className="command-bar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <strong>Meridian</strong>
            <span>DLMM operator console</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="Primary">
          {navItems.map(([label, icon]) => (
            <button
              key={label}
              className={activeNav === label ? "nav-item active" : "nav-item"}
              onClick={() => setActiveNav(label)}
              title={label}
            >
              <Icon name={icon} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="command-actions">
          <button
            className="theme-toggle"
            type="button"
            onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            aria-label={`Switch to ${isDark ? "light" : "dark"} mode`}
            title={`Switch to ${isDark ? "light" : "dark"} mode`}
          >
            {isDark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
          </button>
          <div className="runtime-chip">
            <Badge tone={statusTone}>{errors.boot ? "API offline" : health?.mode === "live_capable" ? "Live-capable runtime" : "Dry-run runtime"}</Badge>
          </div>
        </div>
      </header>

      <main id="main" className="workspace">
        <section className="hero-panel" aria-label="Operator summary">
          <div>
            <p className="eyeline">{errors.candidates ? "Screening needs attention" : "Live Meridian data"}</p>
            <h1>Screen pools, inspect risk, preview actions.</h1>
            <p className="hero-copy">
              The web app reads Meridian's live screening pipeline, wallet positions, local state, lessons, and decision log. When live trading is enabled in Settings, the browser executes through the same Meridian tools as CLI and Telegram.
            </p>
          </div>
          <div className="hero-actions">
            <button className="button secondary" onClick={() => previewAction("manage")} disabled={loading.positions || loading.action}>
              <Icon name="refresh" />
              Refresh positions
            </button>
            <button className="button primary" onClick={() => previewAction("screen")} disabled={loading.candidates || loading.action}>
              <Icon name="play" />
              Run screening scan
            </button>
          </div>
        </section>

        <section className="metric-rail" aria-label="Runtime metrics">
          <div><span>Candidate source</span><strong>{candidatesMeta?.source || thresholds.screening?.source || "-"}</strong></div>
          <div><span>Total screened</span><strong>{candidatesMeta?.total_screened ?? "-"}</strong></div>
          <div><span>Open positions</span><strong>{positions.length || state.open_positions || 0}</strong></div>
          <div><span>Fees claimed</span><strong>{formatCurrency(state.total_fees_claimed_usd)}</strong></div>
        </section>

        {(errors.boot || errors.action || errors.settings) && (
          <div className="alert danger" role="alert" aria-live="polite">
            <strong>{errors.boot ? "API connection failed" : errors.settings ? "Settings failed" : "Action failed"}</strong>
            <span>{errors.boot || errors.settings || errors.action}</span>
          </div>
        )}

        {activeNav === "Settings" ? (
          <SettingsView
            settings={settings}
            settingsForm={settingsForm}
            setSettingsForm={setSettingsForm}
            saving={loading.settings}
            saveSettingsNow={saveSettingsNow}
          />
        ) : activeNav === "Actions" ? (
          <ActionCenter
            selected={selected}
            actionForm={actionForm}
            setActionForm={setActionForm}
            liveGate={liveGate}
            agentStatus={agentStatus}
            previewAction={previewAction}
            executeLiveAction={executeLiveAction}
            startAutonomousLoop={startAutonomousLoop}
            stopAutonomousLoop={stopAutonomousLoop}
            loading={loading}
            result={actionResult}
          />
        ) : (
        <section className="content-grid" aria-label={`${activeNav} view`}>
          <div className="main-column">
            {["Overview", "Screening"].includes(activeNav) && (
            <Panel className="candidate-panel">
              <div className="panel-heading">
                <div>
                  <h2>Screening queue</h2>
                  <p>{loading.candidates ? "Fetching live candidates from Meridian..." : "Ranked pools returned by the active screening source."}</p>
                </div>
                <Badge tone={errors.candidates ? "danger" : "success"}>
                  {errors.candidates ? "Disconnected" : `${candidates.length} live`}
                </Badge>
              </div>

              {errors.candidates ? (
                <EmptyState
                  title="Live screening did not return candidates"
                  detail={errors.candidates}
                  action={<button className="button secondary" onClick={() => loadCandidates()}><Icon name="refresh" /> Try again</button>}
                />
              ) : candidates.length === 0 ? (
                <EmptyState
                  title={loading.candidates || loading.boot ? "Loading screening data" : "No eligible pools returned"}
                  detail={loading.candidates || loading.boot ? "Meridian is checking the configured source." : "The scan completed without an eligible pool under the current thresholds."}
                  action={<button className="button secondary" onClick={() => loadCandidates()}><Icon name="refresh" /> Refresh scan</button>}
                />
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Pool</th>
                        <th>Score</th>
                        <th>Fee/TVL</th>
                        <th>TVL</th>
                        <th>Volatility</th>
                        <th>Bin</th>
                        <th>Preview</th>
                      </tr>
                    </thead>
                    <tbody>
                      {candidates.map((candidate) => (
                        <tr
                          key={candidate.pool}
                          className={selected?.pool === candidate.pool ? "selected-row" : ""}
                          onClick={() => setSelectedPool(candidate.pool)}
                        >
                          <td>
                            <div className="token-cell">
                              <TokenAvatar icon={candidate.token_icon} symbol={candidate.base_symbol} name={candidate.name} />
                              <div>
                                <strong>{candidate.name}</strong>
                                <span>{shortAddress(candidate.pool)}</span>
                              </div>
                            </div>
                          </td>
                          <td><span className="score">{candidate.score ?? "-"}</span></td>
                          <td>{formatPct(candidate.fee_active_tvl_ratio, 3)}</td>
                          <td>{formatCurrency(candidate.active_tvl)}</td>
                          <td>{formatPct(candidate.volatility)}</td>
                          <td>{candidate.bin_step ?? "-"}</td>
                          <td>
                            <button
                              className="text-button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setSelectedPool(candidate.pool);
                                previewAction("deploy", candidate);
                              }}
                            >
                              Validate
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
            )}

            {["Overview", "Positions"].includes(activeNav) && (
            <div className="lower-grid">
              <Panel>
                <div className="panel-heading compact">
                  <h2>Position health</h2>
                  <Badge tone={errors.positions ? "warning" : "success"}>{errors.positions ? "Local state only" : "Wallet read"}</Badge>
                </div>
                {errors.positions ? (
                  <EmptyState title="Wallet positions unavailable" detail={errors.positions} />
                ) : positions.length ? (
                  <div className="position-list">
                    {positions.slice(0, 4).map((position) => (
                      <article key={position.position || position.pool}>
                        <div className="token-cell">
                          <TokenAvatar icon={position.token_icon} symbol={position.pool_snapshot?.token_x?.symbol || position.token_metadata?.symbol} name={position.pair} />
                          <div>
                            <strong>{position.pair || position.pool_name || shortAddress(position.pool)}</strong>
                            <span>{shortAddress(position.position)} · {buildUiPositionRange(position)?.label || (position.in_range === false ? "Out of range" : "In range")}</span>
                            {buildUiPositionRange(position)?.available && (
                              <span>Active {buildUiPositionRange(position).active_bin} inside {buildUiPositionRange(position).lower_bin}-{buildUiPositionRange(position).upper_bin}</span>
                            )}
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <EmptyState title="No open wallet positions" detail="Meridian did not find active positions for the configured wallet." />
                )}
              </Panel>

              <Panel>
                <div className="panel-heading compact">
                  <h2>Risk controls</h2>
                  <Badge tone="warning">Browser locked</Badge>
                </div>
                <div className="threshold-list">
                  <div><span>Max positions</span><strong>{thresholds.risk?.maxPositions ?? 3}</strong></div>
                  <div><span>Deploy amount</span><strong>{thresholds.management?.deployAmountSol ?? 0.5} SOL</strong></div>
                  <div><span>Min TVL</span><strong>{formatCurrency(thresholds.screening?.minTvl ?? 10000)}</strong></div>
                  <div><span>Fee/TVL</span><strong>{formatPct(thresholds.screening?.minFeeActiveTvlRatio ?? 0.05, 2)}</strong></div>
                  <div><span>Bin step</span><strong>{thresholds.screening?.minBinStep ?? 80}-{thresholds.screening?.maxBinStep ?? 125}</strong></div>
                  <div><span>Web actions</span><strong>Preview only</strong></div>
                </div>
              </Panel>
            </div>
            )}

            {["Overview", "Decisions"].includes(activeNav) && (
            <Panel className="decision-band">
              <div className="panel-heading compact">
                <h2>Recent decisions</h2>
                <span>Agent memory</span>
              </div>
              {decisions.length ? (
                <div className="decision-list">
                  {decisions.slice(0, 3).map((decision) => (
                    <article key={decision.id || `${decision.type}-${decision.summary}`} className="decision-item">
                      <span>{String(decision.type || "note").toLowerCase()}</span>
                      <strong>{decision.summary || decision.pool_name || "Decision recorded"}</strong>
                      <p>{decision.reason || "No reason recorded yet."}</p>
                    </article>
                  ))}
                </div>
              ) : (
                <EmptyState title="No decision log entries yet" detail="Run screening or management from the agent to populate the decision log." />
              )}
            </Panel>
            )}

            {activeNav === "Screening" && (
              <Panel>
                <div className="panel-heading compact">
                  <h2>Screening filters</h2>
                  <Badge tone="neutral">{thresholds.screening?.source || "source"}</Badge>
                </div>
                <div className="threshold-list">
                  <div><span>Timeframe</span><strong>{thresholds.screening?.timeframe || "-"}</strong></div>
                  <div><span>Category</span><strong>{thresholds.screening?.category || "-"}</strong></div>
                  <div><span>Min TVL</span><strong>{formatCurrency(thresholds.screening?.minTvl)}</strong></div>
                  <div><span>Max TVL</span><strong>{formatCurrency(thresholds.screening?.maxTvl)}</strong></div>
                  <div><span>Min volume</span><strong>{formatCurrency(thresholds.screening?.minVolume)}</strong></div>
                  <div><span>Min organic</span><strong>{thresholds.screening?.minOrganic ?? "-"}</strong></div>
                </div>
              </Panel>
            )}

            {activeNav === "Positions" && (
              <Panel>
                <div className="panel-heading compact">
                  <div>
                    <h2>Position map</h2>
                    <p>Live wallet positions with active bin, position range, PnL, liquidity, claimable fees, and pool price context.</p>
                  </div>
                  <Badge tone={errors.positions ? "warning" : "success"}>{positions.length} positions</Badge>
                </div>
                {positions.length ? (
                  <div className="position-detail-list">
                    {positions.map((position) => (
                      <PositionDetailCard key={position.position || position.pool} position={position} />
                    ))}
                  </div>
                ) : (
                  <EmptyState title="No open wallet positions" detail="Meridian did not find active positions for the configured wallet." />
                )}
              </Panel>
            )}

            {activeNav === "Decisions" && (
              <Panel>
                <div className="panel-heading compact">
                  <h2>Decision history</h2>
                  <span>{decisions.length} recent entries</span>
                </div>
                {decisions.length ? (
                  <div className="decision-list full">
                    {decisions.map((decision) => (
                      <article key={decision.id || `${decision.type}-${decision.summary}-${decision.timestamp}`} className="decision-item">
                        <span>{String(decision.type || "note").toLowerCase()}</span>
                        <strong>{decision.summary || decision.pool_name || "Decision recorded"}</strong>
                        <p>{decision.reason || "No reason recorded yet."}</p>
                      </article>
                    ))}
                  </div>
                ) : (
                  <EmptyState title="No decision log entries yet" detail="Run the autonomous loop or one-off actions to populate the decision log." />
                )}
              </Panel>
            )}
          </div>

          {["Overview", "Screening"].includes(activeNav) && (
          <aside className="inspector" aria-label="Deploy preview inspector">
            <div className="inspector-header">
              <span>Candidate validation</span>
              <strong>{selected?.name || "No pool selected"}</strong>
              <p>{selected?.decision_hint || "Run a screening scan to select a live candidate."}</p>
            </div>
            <div className="inspector-metrics">
              <div><span>Score</span><strong>{selected?.score ?? "-"}</strong></div>
              <div><span>TVL</span><strong>{formatCurrency(selected?.active_tvl)}</strong></div>
              <div><span>Fee/TVL</span><strong>{formatPct(selected?.fee_active_tvl_ratio, 3)}</strong></div>
              <div><span>Volatility</span><strong>{formatPct(selected?.volatility)}</strong></div>
            </div>
            <div className="deployment-plan">
              <h3>Deploy plan</h3>
              <div><span>Amount</span><strong>{thresholds.management?.deployAmountSol ?? 0.5} SOL</strong></div>
              <div><span>Range</span><strong>Active bin - {thresholds.strategy?.defaultBinsBelow ?? 69} bins</strong></div>
              <div><span>Bin step</span><strong>{selected?.bin_step ?? "-"} bps</strong></div>
              <div><span>Mode</span><strong>{thresholds.management?.solMode ? "SOL guarded" : "Configured"}</strong></div>
            </div>
            <div className="preview-notice">
              <Icon name="lock" />
              <span>Use Actions to execute live. This inspector validates the selected candidate before deployment.</span>
            </div>
            <button className="button preview-only" onClick={() => previewAction("deploy")} disabled={!selected || loading.action}>
              Validate selected pool
            </button>
            {preview && (
              <div className="preview-result">
                <span>{preview.label || "Preview ready"}</span>
                <strong>{preview.validation?.pool_name || preview.validation?.status || "Not executed"}</strong>
                <p>{preview.validation?.error?.message || preview.risk}</p>
              </div>
            )}
          </aside>
          )}
        </section>
        )}

        <footer className="status-strip">
          <span>API {connected ? "connected" : "unavailable"}</span>
          <span>{liveGate.ok ? "Live browser execution enabled" : "Live browser execution blocked until Settings are complete"}</span>
          <span>Last refresh {new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        </footer>
      </main>
    </div>
  );
}

const rootElement = document.getElementById("root");
window.__MERIDIAN_ROOT__ ||= createRoot(rootElement);
window.__MERIDIAN_ROOT__.render(<App />);
