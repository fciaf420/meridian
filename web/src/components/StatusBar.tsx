import { Wifi, WifiOff, Loader2 } from "lucide-react";
import type { StatusInfo, TimerInfo } from "../hooks/useWebSocket";

interface StatusBarProps {
  connected: boolean;
  status: StatusInfo;
  timers: TimerInfo;
}

export default function StatusBar({ connected, status, timers }: StatusBarProps) {
  return (
    <div className="flex items-center gap-4 px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/80 text-xs">
      {/* Connection */}
      <div className="flex items-center gap-1.5">
        {connected ? (
          <Wifi size={14} className="text-emerald-500" />
        ) : (
          <WifiOff size={14} className="text-red-500" />
        )}
        <span className={connected ? "text-emerald-400" : "text-red-400"}>
          {connected ? "Connected" : "Disconnected"}
        </span>
      </div>

      <div className="h-3 w-px bg-zinc-700" />

      {/* Timers */}
      <div className="flex items-center gap-3 text-zinc-400">
        <span>Manage: <span className="text-zinc-200">{timers.management}</span></span>
        <span>Screen: <span className="text-zinc-200">{timers.screening}</span></span>
      </div>

      <div className="flex-1" />

      {/* Busy indicator */}
      {(status.busy || status.managementBusy || status.screeningBusy) && (
        <div className="flex items-center gap-1.5 text-amber-400">
          <Loader2 size={14} className="animate-spin" />
          <span>
            {status.managementBusy ? "Managing" : status.screeningBusy ? "Screening" : "Working"}
          </span>
        </div>
      )}
    </div>
  );
}
