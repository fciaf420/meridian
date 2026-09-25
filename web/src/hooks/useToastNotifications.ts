import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { Notification } from "./useWebSocket";

export function useToastNotifications(notifications: Notification[]) {
  const seenIds = useRef(new Set<string>());

  useEffect(() => {
    for (const n of notifications) {
      if (seenIds.current.has(n.id)) continue;
      seenIds.current.add(n.id);

      const toastEvents: Record<string, string> = {
        deploy: "Position Deployed",
        close: "Position Closed",
        out_of_range: "Out of Range",
      };

      const title = toastEvents[n.event];
      if (!title) continue;

      const d = n.data;
      let description = "";
      switch (n.event) {
        case "deploy":
          description = `${d.pair || "?"} — ${d.amountSol || "?"} SOL`;
          break;
        case "close": {
          const pnl = d.pnlSol != null ? `${Number(d.pnlSol).toFixed(4)} SOL` : "?";
          description = `${d.pair || "?"} — PnL: ${pnl}`;
          break;
        }
        case "out_of_range":
          description = `${d.pair || "?"} — ${d.minutesOOR || "?"}m OOR`;
          break;
      }

      toast(title, { description });
    }
  }, [notifications]);
}
