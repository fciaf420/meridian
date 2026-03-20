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
  { key: "top-pools", label: "Top Pools", icon: "\u2B50" },
  { key: "recent-closes", label: "Recent Closes", icon: "\u2705" },
  { key: "lessons", label: "Lessons", icon: "\uD83D\uDCD6" },
  { key: "memory", label: "Memory", icon: "\uD83E\uDDE0" },
  { key: "settings", label: "Settings", icon: "\u2699\uFE0F" },
  { key: "briefing", label: "Briefing", icon: "\uD83D\uDCCB" },
  { key: "performance", label: "Performance", icon: "\uD83D\uDCC8" },
] as const;

type ActionKey = (typeof ACTIONS)[number]["key"];

const ACTION_TITLES: Record<ActionKey, string> = {
  "top-pools": "Top Pools",
  "recent-closes": "Recent Closes",
  lessons: "Lessons",
  memory: "Memory",
  settings: "Settings",
  briefing: "Briefing",
  performance: "Performance",
};

/* ---------- Per-action renderers ---------- */

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
  const closes = Array.isArray(data) ? data : [];
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
              <TableCell className="text-right">{c.hold_time != null ? String(c.hold_time) : "--"}</TableCell>
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
  const lessons = Array.isArray(data) ? data : [];
  if (lessons.length === 0) return <EmptyState text="No lessons recorded yet." />;
  return (
    <div className="flex flex-col gap-2">
      {lessons.map((l: Record<string, unknown>, i: number) => (
        <div
          key={i}
          className="rounded-xl border border-white/8 bg-white/4 px-4 py-3"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm text-cream/90">{String(l.rule ?? l.text ?? l.content ?? "--")}</p>
            {!!l.pinned && (
              <Badge variant="secondary" className="shrink-0 text-[9px]">
                Pinned
              </Badge>
            )}
          </div>
          {Array.isArray(l.tags) && l.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {l.tags.map((tag: string, ti: number) => (
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
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return (
    <pre className="whitespace-pre-wrap break-words rounded-xl border border-white/8 bg-white/4 px-4 py-3 font-mono text-[11px] leading-relaxed text-cream/85">
      {text}
    </pre>
  );
}

function renderSettings(data: unknown) {
  if (!data || typeof data !== "object") return <EmptyState text="No settings data." />;
  const entries = Object.entries(data as Record<string, unknown>);
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-white/8 bg-white/4 px-4 py-3 font-mono text-[11px]">
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-start justify-between gap-3 py-1 border-b border-white/5 last:border-0">
          <span className="text-ash/70 shrink-0">{key}</span>
          <span className="text-cream/85 text-right break-all">
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
      className="prose prose-invert prose-sm max-w-none text-cream/85 [&_h1]:text-cream [&_h2]:text-cream [&_h3]:text-cream [&_a]:text-amber-200 [&_strong]:text-cream"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function renderPerformance(data: unknown) {
  if (!data || typeof data !== "object") return <EmptyState text="No performance data." />;
  const d = data as Record<string, unknown>;
  const stats = [
    { label: "Total Closed", value: d.total_closed ?? d.closed_positions ?? "--" },
    { label: "Win Rate", value: d.win_rate != null ? `${Number(d.win_rate).toFixed(1)}%` : (d.win_rate_pct != null ? `${Number(d.win_rate_pct).toFixed(1)}%` : "--") },
    { label: "Avg PnL", value: d.avg_pnl != null ? `${Number(d.avg_pnl).toFixed(3)} SOL` : (d.avg_pnl_sol != null ? `${Number(d.avg_pnl_sol).toFixed(3)} SOL` : "--") },
    { label: "Avg Range Efficiency", value: d.avg_range_efficiency != null ? `${Number(d.avg_range_efficiency).toFixed(1)}%` : "--" },
    { label: "Total Lessons", value: d.total_lessons ?? "--" },
  ];
  return (
    <div className="flex flex-col gap-2">
      {stats.map((s) => (
        <div
          key={s.label}
          className="flex items-center justify-between rounded-xl border border-white/8 bg-white/4 px-4 py-3"
        >
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ash/62">{s.label}</span>
          <span className="font-mono text-lg text-cream">{String(s.value)}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------- Helpers ---------- */

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
  return isNaN(n) ? String(v) : n.toFixed(2);
}

function fmtUsd(v: unknown): string {
  if (v == null) return "--";
  const n = Number(v);
  return isNaN(n) ? String(v) : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function fmtPct(v: unknown): string {
  if (v == null) return "--";
  const n = Number(v);
  return isNaN(n) ? String(v) : `${n.toFixed(1)}%`;
}

const RENDERERS: Record<ActionKey, (data: unknown) => React.ReactNode> = {
  "top-pools": renderTopPools,
  "recent-closes": renderRecentCloses,
  lessons: renderLessons,
  memory: renderMemory,
  settings: renderSettings,
  briefing: renderBriefing,
  performance: renderPerformance,
};

/* ---------- Component ---------- */

export default function QuickActions({
  sendQuickAction,
  quickActionResult,
  clearQuickActionResult,
}: QuickActionsProps) {
  const [activeAction, setActiveAction] = useState<ActionKey | null>(null);
  const [loading, setLoading] = useState(false);

  const handleClick = useCallback(
    (action: ActionKey) => {
      setActiveAction(action);
      setLoading(true);
      sendQuickAction(action);
    },
    [sendQuickAction],
  );

  const handleClose = useCallback(() => {
    setActiveAction(null);
    setLoading(false);
    clearQuickActionResult();
  }, [clearQuickActionResult]);

  // Detect when result arrives for the active action
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
      {/* Button row */}
      <div className="flex flex-wrap gap-2 px-1">
        {ACTIONS.map((a) => (
          <button
            key={a.key}
            onClick={() => handleClick(a.key)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-white/8 bg-white/4 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-cream/80 transition-all duration-200 hover:-translate-y-0.5 hover:border-amber-200/20 hover:bg-amber-200/8 hover:text-cream hover:shadow-[0_8px_20px_rgba(255,209,102,0.1)] active:translate-y-0"
          >
            <span className="text-sm leading-none">{a.icon}</span>
            {a.label}
          </button>
        ))}
      </div>

      {/* Result modal */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) handleClose(); }}>
        <DialogContent className="max-h-[80vh] max-w-2xl flex flex-col gap-0 p-0">
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
