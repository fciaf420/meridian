import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { Notification } from "../hooks/useWebSocket";

const EVENT_STYLES: Record<string, { label: string; color: string }> = {
  deploy: { label: "Deployed", color: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20" },
  close: { label: "Closed", color: "text-amber-400 bg-amber-400/10 border-amber-400/20" },
  out_of_range: { label: "Out of Range", color: "text-red-400 bg-red-400/10 border-red-400/20" },
  "cycle:management": { label: "Management", color: "text-blue-400 bg-blue-400/10 border-blue-400/20" },
  "cycle:screening": { label: "Screening", color: "text-violet-400 bg-violet-400/10 border-violet-400/20" },
  briefing: { label: "Briefing", color: "text-cyan-400 bg-cyan-400/10 border-cyan-400/20" },
};

const EXPANDABLE_EVENTS = new Set(["cycle:management", "cycle:screening", "briefing"]);
const PREVIEW_LEN = 120;

interface NotificationFeedProps {
  notifications: Notification[];
}

export default function NotificationFeed({ notifications }: NotificationFeedProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (notifications.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-600 text-sm">
        No notifications yet
      </div>
    );
  }

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="overflow-y-auto h-full space-y-2 p-2">
      {notifications.map((n) => {
        const style = EVENT_STYLES[n.event] || { label: n.event, color: "text-zinc-400 bg-zinc-400/10 border-zinc-400/20" };
        const time = new Date(n.ts).toLocaleTimeString();
        const fullText = getFullText(n);
        const isExpandable = EXPANDABLE_EVENTS.has(n.event) && fullText.length > PREVIEW_LEN;
        const isOpen = expanded.has(n.id);
        const displayText = isExpandable && !isOpen ? fullText.slice(0, PREVIEW_LEN) + "…" : fullText;

        return (
          <div key={n.id} className={`rounded-lg border p-3 text-xs ${style.color}`}>
            <div className="flex items-center justify-between mb-1">
              <span className="font-semibold">{style.label}</span>
              <span className="opacity-60">{time}</span>
            </div>
            <div className="text-zinc-300 whitespace-pre-wrap">{displayText}</div>
            {isExpandable && (
              <button
                onClick={() => toggle(n.id)}
                className="mt-1.5 flex items-center gap-1 text-[10px] opacity-60 hover:opacity-100 transition-opacity"
              >
                {isOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                {isOpen ? "Collapse" : "Show full report"}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function getFullText(n: Notification): string {
  const d = n.data;
  switch (n.event) {
    case "deploy":
      return `${d.pair || "?"} — ${d.amountSol || "?"} SOL`;
    case "close": {
      const pnlVal = d.pnlSol != null ? `${Number(d.pnlSol).toFixed(4)} SOL` : (d.pnlUsd != null ? `$${Number(d.pnlUsd).toFixed(2)}` : "?");
      return `${d.pair || "?"} — PnL: ${pnlVal} (${d.pnlPct ? `${Number(d.pnlPct).toFixed(2)}%` : "?"})`;
    }
    case "out_of_range":
      return `${d.pair || "?"} — ${d.minutesOOR || "?"}m OOR`;
    case "cycle:management":
    case "cycle:screening":
      return typeof d.report === "string" ? d.report : JSON.stringify(d);
    case "briefing":
      return typeof d.html === "string" ? d.html.replace(/<[^>]*>/g, "") : "Briefing generated";
    default:
      return JSON.stringify(d);
  }
}
