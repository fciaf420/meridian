import { memo } from "react";
import type { PositionInfo } from "../hooks/useWebSocket";
import { Badge } from "@/components/ui/badge";
import BinRangeChart from "./BinRangeChart";

function formatAge(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hrs = Math.floor(minutes / 60);
  const remainMins = minutes % 60;
  if (hrs < 24) return `${hrs}h ${remainMins}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

function PositionCardInner({ position }: { position: PositionInfo }) {
  const { pair, in_range, pnl_pct, unclaimed_fees_sol, unclaimed_fees_usd, age_minutes, active_bin, lower_bin, upper_bin } = position;

  const pnlColor = pnl_pct >= 0 ? "text-emerald-400" : "text-red-400";
  const fees = unclaimed_fees_sol != null ? `${unclaimed_fees_sol.toFixed(4)} SOL` : unclaimed_fees_usd != null ? `$${unclaimed_fees_usd.toFixed(2)}` : "--";

  return (
    <div className={`rounded-lg border bg-teal/15 p-3 text-xs transition-all hover:bg-teal/25 ${in_range ? "border-l-2 border-l-emerald-400 border-steel/20" : "border-l-2 border-l-red-400 border-steel/20"}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <span className="font-mono text-[12px] text-cream font-medium">{pair}</span>
        <Badge variant={in_range ? "outline" : "destructive"}>
          {in_range ? "IN RANGE" : "OOR"}
        </Badge>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-3 mb-2">
        <div>
          <span className="text-ash text-[10px] block">PnL</span>
          <span className={`font-mono text-[11px] font-medium ${pnlColor}`}>
            {pnl_pct >= 0 ? "+" : ""}{pnl_pct.toFixed(2)}%
          </span>
        </div>
        <div>
          <span className="text-ash text-[10px] block">Fees</span>
          <span className="font-mono text-[11px] text-cream">{fees}</span>
        </div>
        <div className="ml-auto">
          <span className="text-ash text-[10px] block">Age</span>
          <span className="font-mono text-[11px] text-steel">{age_minutes != null ? formatAge(age_minutes) : "--"}</span>
        </div>
      </div>

      {/* Bin range chart */}
      {lower_bin != null && upper_bin != null && active_bin != null ? (
        <BinRangeChart
          lowerBin={lower_bin}
          upperBin={upper_bin}
          activeBin={active_bin}
          inRange={in_range}
          strategy={position.strategy}
        />
      ) : (
        <div className="h-6 rounded bg-ink/40 flex items-center justify-center">
          <span className="font-mono text-[9px] text-ash/40">bin data unavailable</span>
        </div>
      )}
    </div>
  );
}

const PositionCard = memo(PositionCardInner, (prev, next) =>
  prev.position.pnl_pct === next.position.pnl_pct &&
  prev.position.in_range === next.position.in_range &&
  prev.position.unclaimed_fees_sol === next.position.unclaimed_fees_sol &&
  prev.position.active_bin === next.position.active_bin
);

export default PositionCard;
