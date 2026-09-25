import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { Notification } from "../hooks/useWebSocket";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

const EVENT_STYLES: Record<
  string,
  { label: string; badge: BadgeVariant; card: string; sweep?: string }
> = {
  deploy: {
    label: "Deployed",
    badge: "default",
    card: "bg-steel/10 border-steel/20",
    sweep: "notif-sweep notif-sweep--amber",
  },
  close: {
    label: "Closed",
    badge: "secondary",
    card: "bg-teal/20 border-steel/15",
    sweep: "notif-sweep notif-sweep--emerald",
  },
  out_of_range: {
    label: "Out of Range",
    badge: "destructive",
    card: "bg-steel/15 border-steel/30",
  },
  "cycle:management": {
    label: "Management",
    badge: "outline",
    card: "bg-teal/10 border-teal/20",
  },
  "cycle:screening": {
    label: "Screening",
    badge: "outline",
    card: "bg-teal/10 border-teal/20",
  },
  briefing: {
    label: "Briefing",
    badge: "secondary",
    card: "bg-teal/15 border-steel/15",
  },
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
      <div className="flex items-center justify-center h-full text-ash/40 text-sm">
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
    <ScrollArea className="h-full">
      <div className="space-y-2 p-2">
        {notifications.map((n) => {
          const style = EVENT_STYLES[n.event] || {
            label: n.event,
            badge: "outline" as BadgeVariant,
            card: "bg-steel/10 border-steel/20",
            sweep: "",
          };
          const time = new Date(n.ts).toLocaleTimeString();
          const fullText = getFullText(n);
          const isExpandable = EXPANDABLE_EVENTS.has(n.event) && fullText.length > PREVIEW_LEN;
          const isOpen = expanded.has(n.id);
          const displayText = isExpandable && !isOpen ? fullText.slice(0, PREVIEW_LEN) + "\u2026" : fullText;

          return (
            <div
              key={n.id}
              className={`relative overflow-hidden rounded-[20px] border p-3 text-xs ${style.card} ${style.sweep ?? ""} animate-slide-in-right transition-all hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(89,131,146,0.18)]`}
            >
              <div className="flex items-center justify-between mb-1">
                <Badge variant={style.badge}>{style.label}</Badge>
                <span className="font-mono text-[10px] text-ash/60">{time}</span>
              </div>
              <div className="text-cream/80 whitespace-pre-wrap">{displayText}</div>
              {isExpandable && (
                <button
                  onClick={() => toggle(n.id)}
                  className="mt-1.5 flex items-center gap-1 text-[10px] text-ash/60 hover:text-cream transition-colors"
                >
                  {isOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  {isOpen ? "Collapse" : "Show full report"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </ScrollArea>
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
