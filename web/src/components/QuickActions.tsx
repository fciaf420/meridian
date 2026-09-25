import { useState, useCallback, useEffect } from "react";
import type { QuickActionResult } from "../hooks/useWebSocket";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

interface QuickActionsProps {
  sendQuickAction: (action: string) => void;
  quickActionResult: QuickActionResult | null;
  clearQuickActionResult: () => void;
}

const ACTIONS = [
  { key: "top-pools", label: "Top Pools", icon: "*" },
  { key: "recent-closes", label: "Recent Closes", icon: "+" },
  { key: "lessons", label: "Lessons", icon: "L" },
  { key: "memory", label: "Memories", icon: "M" },
  { key: "darwin-weights", label: "Darwin", icon: "D" },
  { key: "autoresearch", label: "Autoresearch", icon: "A" },
  { key: "settings", label: "Settings", icon: "S" },
  { key: "briefing", label: "Briefing", icon: "B" },
  { key: "performance", label: "Performance", icon: "P" },
] as const;

type ActionKey = (typeof ACTIONS)[number]["key"];

const ACTION_TITLES: Record<ActionKey, string> = {
  "top-pools": "Top Pools",
  "recent-closes": "Recent Closes",
  lessons: "Lessons",
  memory: "Memories",
  "darwin-weights": "Darwin Weights",
  autoresearch: "Autoresearch",
  settings: "Settings",
  briefing: "Briefing",
  performance: "Performance",
};

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex min-h-24 items-center justify-center text-sm text-ash/46">
      {text}
    </div>
  );
}

function fmtNum(v: unknown): string {
  if (v == null) return "--";
  const n = Number(v);
  return Number.isNaN(n) ? String(v) : n.toFixed(2);
}

function fmtUsd(v: unknown): string {
  if (v == null) return "--";
  const n = Number(v);
  return Number.isNaN(n) ? String(v) : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function fmtPct(v: unknown): string {
  if (v == null) return "--";
  const n = Number(v);
  return Number.isNaN(n) ? String(v) : `${n.toFixed(1)}%`;
}

function fmtHoldTime(v: unknown): string {
  if (v == null) return "--";
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  if (n < 60) return `${Math.round(n)}m`;
  return `${(n / 60).toFixed(1)}h`;
}

function normalizeLessons(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object" && Array.isArray((data as { lessons?: unknown[] }).lessons)) {
    return (data as { lessons: Record<string, unknown>[] }).lessons;
  }
  return [];
}

function normalizeRecentCloses(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object" && Array.isArray((data as { positions?: unknown[] }).positions)) {
    return (data as { positions: Record<string, unknown>[] }).positions;
  }
  return [];
}

function renderTopPools(data: unknown) {
  const pools = Array.isArray(data) ? data : [];
  if (pools.length === 0) return <EmptyState text="No pool data available." />;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead className="text-right">Fee/TVL</TableHead>
          <TableHead className="text-right">Volume</TableHead>
          <TableHead className="text-right">Organic</TableHead>
          <TableHead className="text-right">Holders</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {pools.map((p: Record<string, unknown>, i: number) => (
          <TableRow key={i}>
            <TableCell className="max-w-[140px] truncate">{String(p.name ?? p.pair ?? "--")}</TableCell>
            <TableCell className="text-right">{fmtNum(p.fee_tvl_ratio ?? p.fee_tvl)}</TableCell>
            <TableCell className="text-right">{fmtUsd(p.volume ?? p.volume_24h)}</TableCell>
            <TableCell className="text-right">{fmtPct(p.organic ?? p.organic_score)}</TableCell>
            <TableCell className="text-right">{p.holders != null ? String(p.holders) : "--"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function renderRecentCloses(data: unknown) {
  const closes = normalizeRecentCloses(data);
  if (closes.length === 0) return <EmptyState text="No recent closes." />;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Pool</TableHead>
          <TableHead className="text-right">PnL %</TableHead>
          <TableHead className="text-right">PnL USD</TableHead>
          <TableHead className="text-right">Hold</TableHead>
          <TableHead>Strategy</TableHead>
          <TableHead>Reason</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {closes.map((c: Record<string, unknown>, i: number) => {
          const pnlPct = Number(c.pnl_pct ?? 0);
          const pnlColor = pnlPct >= 0 ? "text-emerald-300" : "text-red-400";
          return (
            <TableRow key={i}>
              <TableCell className="max-w-[120px] truncate">{String(c.pool ?? c.pair ?? "--")}</TableCell>
              <TableCell className={`text-right ${pnlColor}`}>{fmtPct(c.pnl_pct)}</TableCell>
              <TableCell className={`text-right ${pnlColor}`}>{fmtUsd(c.pnl_usd)}</TableCell>
              <TableCell className="text-right">{fmtHoldTime(c.minutes_held ?? c.hold_time)}</TableCell>
              <TableCell>{String(c.strategy ?? "--")}</TableCell>
              <TableCell className="max-w-[100px] truncate text-ash/70">{String(c.close_reason ?? c.reason ?? "--")}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function renderLessons(data: unknown) {
  const lessons = normalizeLessons(data);
  if (lessons.length === 0) return <EmptyState text="No lessons recorded yet." />;
  return (
    <div className="flex flex-col gap-2">
      {lessons.map((lesson, i) => (
        <div key={i} className="rounded-xl border border-white/8 bg-white/4 px-4 py-3">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm text-cream/90">{String(lesson.rule ?? lesson.text ?? lesson.content ?? "--")}</p>
            {!!lesson.pinned && (
              <Badge variant="secondary" className="shrink-0 text-[9px]">
                Pinned
              </Badge>
            )}
          </div>
          {Array.isArray(lesson.tags) && lesson.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {lesson.tags.map((tag: string, ti: number) => (
                <span
                  key={ti}
                  className="rounded-md bg-steel/20 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-ash/70"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function renderMemory(data: unknown) {
  const text = typeof data === "string"
    ? data
    : data == null
      ? "No memory facts promoted yet."
      : JSON.stringify(data, null, 2);
  return (
    <pre className="whitespace-pre-wrap break-words rounded-xl border border-white/8 bg-white/4 px-4 py-3 font-mono text-[11px] leading-relaxed text-cream/85">
      {text}
    </pre>
  );
}

function renderDarwinWeights(data: unknown) {
  if (!data || typeof data !== "object") return <EmptyState text="No Darwin weight data." />;
  const payload = data as {
    enabled?: boolean;
    last_recalc?: string | null;
    recalc_count?: number;
    weights?: Array<{ signal?: string; weight?: number; direction?: string }>;
  };
  const weights = Array.isArray(payload.weights) ? payload.weights : [];

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl border border-white/8 bg-white/4 px-4 py-3 text-sm text-cream/84">
        <div>Darwin: {payload.enabled ? "enabled" : "disabled"}</div>
        <div>Last recalc: {payload.last_recalc || "--"}</div>
        <div>Total recalcs: {payload.recalc_count ?? 0}</div>
      </div>

      {weights.length ? (
        weights.map((entry, index) => {
          const weight = Number(entry.weight ?? 0);
          const width = `${Math.max(8, Math.min(100, (weight / 2.5) * 100))}%`;
          return (
            <div key={`${entry.signal}-${index}`} className="rounded-xl border border-white/8 bg-white/4 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-cream/90">{String(entry.signal ?? "--")}</div>
                  <div className="mt-1 text-xs text-ash/56">{String(entry.direction ?? "unknown")}</div>
                </div>
                <div className="font-mono text-lg text-cream">{weight.toFixed(2)}</div>
              </div>
              <div className="mt-3 h-2 rounded-full bg-white/8">
                <div className="h-2 rounded-full bg-[linear-gradient(90deg,rgba(89,131,146,0.85),rgba(255,209,102,0.92))]" style={{ width }} />
              </div>
            </div>
          );
        })
      ) : (
        <EmptyState text="No Darwin weights available." />
      )}
    </div>
  );
}

function renderAutoresearch(data: unknown) {
  if (!data || typeof data !== "object") return <EmptyState text="No autoresearch data." />;
  const payload = data as {
    enabled?: boolean;
    cooldownRemaining?: number;
    keptOverrideSections?: string[];
    active?: { section?: string; hypothesis?: string } | null;
    recentLessons?: Array<{ id?: number; rule?: string; created_at?: string }>;
    recentExperiments?: Array<{ id?: string; section?: string; status?: string; hypothesis?: string }>;
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl border border-white/8 bg-white/4 px-4 py-3 text-sm text-cream/84">
        <div>Autoresearch: {payload.enabled ? "enabled" : "disabled"}</div>
        <div>Cooldown remaining: {payload.cooldownRemaining ?? 0}</div>
        <div>Kept overrides: {(payload.keptOverrideSections || []).join(", ") || "none"}</div>
        {payload.active ? (
          <div className="mt-2 rounded-lg border border-white/6 bg-black/10 px-3 py-2">
            <div className="font-medium text-cream">{payload.active.section || "active experiment"}</div>
            <div className="mt-1 text-xs text-ash/60">{payload.active.hypothesis || "--"}</div>
          </div>
        ) : null}
      </div>

      {Array.isArray(payload.recentLessons) && payload.recentLessons.length > 0 ? (
        <div className="flex flex-col gap-2">
          {payload.recentLessons.map((lesson, index) => (
            <div key={`${lesson.id}-${index}`} className="rounded-xl border border-white/8 bg-white/4 px-4 py-3">
              <div className="text-sm text-cream/90">{String(lesson.rule ?? "--")}</div>
              <div className="mt-1 text-xs text-ash/56">{String(lesson.created_at ?? "--")}</div>
            </div>
          ))}
        </div>
      ) : Array.isArray(payload.recentExperiments) && payload.recentExperiments.length > 0 ? (
        <div className="flex flex-col gap-2">
          {payload.recentExperiments.map((experiment, index) => (
            <div key={`${experiment.id}-${index}`} className="rounded-xl border border-white/8 bg-white/4 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="font-medium text-cream">{String(experiment.section ?? "--")}</div>
                <Badge variant="outline">{String(experiment.status ?? "--")}</Badge>
              </div>
              <div className="mt-1 text-sm text-cream/84">{String(experiment.hypothesis ?? "--")}</div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState text="No autoresearch history yet." />
      )}
    </div>
  );
}

function renderSettings(data: unknown) {
  if (!data || typeof data !== "object") return <EmptyState text="No settings data." />;
  const entries = Object.entries(data as Record<string, unknown>);
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-white/8 bg-white/4 px-4 py-3 font-mono text-[11px]">
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-start justify-between gap-3 border-b border-white/5 py-1 last:border-0">
          <span className="shrink-0 text-ash/70">{key}</span>
          <span className="break-all text-right text-cream/85">
            {typeof value === "object" ? JSON.stringify(value) : String(value)}
          </span>
        </div>
      ))}
    </div>
  );
}

function renderBriefing(data: unknown) {
  const html = typeof data === "string" ? data : "";
  if (!html) return <EmptyState text="No briefing content." />;
  return (
    <div
      className="prose prose-invert prose-sm max-w-none text-cream/85 [&_a]:text-amber-200 [&_h1]:text-cream [&_h2]:text-cream [&_h3]:text-cream [&_strong]:text-cream"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function renderPerformance(data: unknown) {
  if (!data || typeof data !== "object") return <EmptyState text="No performance data." />;
  const d = data as Record<string, unknown>;
  const stats = [
    { label: "Total Closed", value: d.total_closed ?? d.total_positions_closed ?? "--" },
    { label: "Win Rate", value: d.win_rate != null ? `${Number(d.win_rate).toFixed(1)}%` : (d.win_rate_pct != null ? `${Number(d.win_rate_pct).toFixed(1)}%` : "--") },
    { label: "Avg PnL", value: d.avg_pnl != null ? `${Number(d.avg_pnl).toFixed(3)} SOL` : (d.avg_pnl_pct != null ? `${Number(d.avg_pnl_pct).toFixed(1)}%` : "--") },
    { label: "Avg Range Efficiency", value: d.avg_range_efficiency != null ? `${Number(d.avg_range_efficiency).toFixed(1)}%` : (d.avg_range_efficiency_pct != null ? `${Number(d.avg_range_efficiency_pct).toFixed(1)}%` : "--") },
    { label: "Total Lessons", value: d.total_lessons ?? "--" },
  ];
  return (
    <div className="flex flex-col gap-2">
      {stats.map((s) => (
        <div key={s.label} className="flex items-center justify-between rounded-xl border border-white/8 bg-white/4 px-4 py-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ash/62">{s.label}</span>
          <span className="font-mono text-lg text-cream">{String(s.value)}</span>
        </div>
      ))}
    </div>
  );
}

const RENDERERS: Record<ActionKey, (data: unknown) => React.ReactNode> = {
  "top-pools": renderTopPools,
  "recent-closes": renderRecentCloses,
  lessons: renderLessons,
  memory: renderMemory,
  "darwin-weights": renderDarwinWeights,
  autoresearch: renderAutoresearch,
  settings: renderSettings,
  briefing: renderBriefing,
  performance: renderPerformance,
};

export default function QuickActions({
  sendQuickAction,
  quickActionResult,
  clearQuickActionResult,
}: QuickActionsProps) {
  const [activeAction, setActiveAction] = useState<ActionKey | null>(null);
  const [loading, setLoading] = useState(false);

  const handleClick = useCallback((action: ActionKey) => {
    setActiveAction(action);
    setLoading(true);
    sendQuickAction(action);
  }, [sendQuickAction]);

  const handleClose = useCallback(() => {
    setActiveAction(null);
    setLoading(false);
    clearQuickActionResult();
  }, [clearQuickActionResult]);

  const hasResult =
    quickActionResult != null &&
    activeAction != null &&
    quickActionResult.action === activeAction;

  useEffect(() => {
    if (hasResult && loading) {
      setLoading(false);
    }
  }, [hasResult, loading]);

  const dialogOpen = activeAction != null;

  return (
    <>
      <div className="flex flex-wrap gap-2 px-1">
        {ACTIONS.map((action) => (
          <button
            key={action.key}
            onClick={() => handleClick(action.key)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-white/8 bg-white/4 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-cream/80 transition-all duration-200 hover:-translate-y-0.5 hover:border-amber-200/20 hover:bg-amber-200/8 hover:text-cream hover:shadow-[0_8px_20px_rgba(255,209,102,0.1)] active:translate-y-0"
          >
            <span className="text-sm leading-none">{action.icon}</span>
            {action.label}
          </button>
        ))}
      </div>

      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) handleClose(); }}>
        <DialogContent className="flex max-h-[80vh] max-w-2xl flex-col gap-0 p-0">
          <DialogHeader className="flex flex-row items-center justify-between border-b border-white/8 px-5 py-4">
            <DialogTitle>
              {activeAction ? ACTION_TITLES[activeAction] : ""}
            </DialogTitle>
            <DialogClose className="rounded-lg p-1.5 text-ash/60 transition-colors hover:bg-white/8 hover:text-cream">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M1 1L13 13M1 13L13 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </DialogClose>
          </DialogHeader>

          <ScrollArea className="flex-1 overflow-auto px-5 py-4" style={{ maxHeight: "calc(80vh - 72px)" }}>
            {loading ? (
              <div className="flex min-h-32 flex-col items-center justify-center gap-3">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-amber-200/30 border-t-amber-200" />
                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ash/50">
                  Loading...
                </span>
              </div>
            ) : quickActionResult?.error ? (
              <div className="flex min-h-24 items-center justify-center text-sm text-red-400">
                {quickActionResult.error}
              </div>
            ) : hasResult && activeAction ? (
              RENDERERS[activeAction](quickActionResult.data)
            ) : (
              <div className="flex min-h-32 flex-col items-center justify-center gap-3">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-amber-200/30 border-t-amber-200" />
                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ash/50">
                  Loading...
                </span>
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  );
}
