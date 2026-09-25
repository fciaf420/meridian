import { Wifi, WifiOff, Network } from "lucide-react";
import type { StatusInfo, TimerInfo, WalletData } from "../hooks/useWebSocket";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

interface StatusBarProps {
  connected: boolean;
  status: StatusInfo;
  timers: TimerInfo;
  wallet: WalletData | null;
  onOpenGraph?: () => void;
}

export default function StatusBar({ connected, status, timers, wallet, onOpenGraph }: StatusBarProps) {
  const busyLabel = status.managementBusy
    ? "Managing"
    : status.screeningBusy
      ? "Screening"
      : "Working";

  const busyTooltip = [
    status.managementBusy && "Management cycle active",
    status.screeningBusy && "Screening cycle active",
    status.busy && !status.managementBusy && !status.screeningBusy && "Agent is working",
  ]
    .filter(Boolean)
    .join(". ");

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex items-center gap-4 border-b border-white/8 bg-[linear-gradient(180deg,rgba(18,69,89,0.82),rgba(9,43,56,0.82))] px-4 py-2.5 text-xs shadow-[0_10px_28px_rgba(0,0,0,0.18)] backdrop-blur-sm">
        {/* Connection */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1.5 font-medium">
              {connected ? (
                <Wifi size={14} className="text-emerald-300" />
              ) : (
                <WifiOff size={14} className="text-ash/58" />
              )}
              <span className={connected ? "text-cream" : "text-ash/70"}>
                {connected ? "Connected" : "Disconnected"}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent>WebSocket connection to DLMM agent</TooltipContent>
        </Tooltip>

        <Separator orientation="vertical" className="h-3" />

        {/* Timers */}
        <div className="flex items-center gap-3 text-ash">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="font-mono text-[11px] uppercase tracking-[0.14em]">
                MGT:{" "}
                {timers.management === "--" ? (
                  <Skeleton className="h-3 w-8 inline-block" />
                ) : (
                  <span className="text-cream">{timers.management}</span>
                )}
              </span>
            </TooltipTrigger>
            <TooltipContent>Time until next management cycle</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <span className="font-mono text-[11px] uppercase tracking-[0.14em]">
                SCR:{" "}
                {timers.screening === "--" ? (
                  <Skeleton className="h-3 w-8 inline-block" />
                ) : (
                  <span className="text-cream">{timers.screening}</span>
                )}
              </span>
            </TooltipTrigger>
            <TooltipContent>Time until next screening cycle</TooltipContent>
          </Tooltip>
        </div>

        <Separator orientation="vertical" className="h-3" />

        {/* Wallet */}
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="font-mono text-[11px] text-ash tracking-[0.14em]">
              SOL:{" "}
              {wallet ? (
                <>
                  <span className="text-cream">{wallet.sol.toFixed(3)}</span>
                  <span className="ml-1 text-ash/72">(${wallet.sol_usd.toFixed(0)})</span>
                </>
              ) : (
                <Skeleton className="h-3 w-14 inline-block" />
              )}
            </span>
          </TooltipTrigger>
          <TooltipContent>Wallet balance — SOL ${wallet?.sol_price.toFixed(2) ?? "..."}</TooltipContent>
        </Tooltip>

        <div className="flex-1" />

        {/* Mind Map */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onOpenGraph}
              className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-ash/70 transition-colors hover:border-amber-300/20 hover:bg-amber-300/8 hover:text-amber-200"
            >
              <Network size={13} />
              <span className="font-mono text-[10px] tracking-wider">Mind Map</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>Open knowledge graph visualization</TooltipContent>
        </Tooltip>

        {/* Busy indicator */}
        {(status.busy || status.managementBusy || status.screeningBusy) && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5 rounded-full border border-emerald-300/15 bg-emerald-300/8 px-2.5 py-1">
                <span className="h-2 w-2 rounded-full bg-emerald-300 animate-subtle-glow" />
                <span className="font-mono text-[11px] text-emerald-200">{busyLabel}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>{busyTooltip}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
  );
}
