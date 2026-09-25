import { memo, useMemo, useState } from "react";

interface BinRangeChartProps {
  lowerBin: number;
  upperBin: number;
  activeBin: number;
  inRange: boolean;
  strategy?: "bid_ask" | "spot";
}

// Colors
const SOL = "rgb(59, 130, 246)";           // blue-500
const TOKEN = "rgb(168, 85, 247)";         // purple-500
const ACTIVE = "rgba(255, 255, 255, 0.85)";
const OOR = "rgba(248, 113, 113, 0.35)";

const MAX_BARS = 44;

function BinRangeChartInner({ lowerBin, upperBin, activeBin, inRange, strategy = "bid_ask" }: BinRangeChartProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const bars = useMemo(() => {
    const totalBins = upperBin - lowerBin;
    if (totalBins <= 0) return [];

    const step = totalBins > MAX_BARS ? Math.ceil(totalBins / MAX_BARS) : 1;
    const barCount = Math.ceil(totalBins / step);

    const result: Array<{
      height: number;
      color: string;
      isActive: boolean;
      startBin: number;
      endBin: number;
      side: "sol" | "token" | "active" | "oor";
    }> = [];

    for (let i = 0; i < barCount; i++) {
      const binId = lowerBin + i * step;
      const isActive = activeBin >= binId && activeBin < binId + step;
      const isSolSide = binId < activeBin;

      // Height depends on strategy shape
      let height: number;
      if (strategy === "bid_ask") {
        // Bid-ask wedge: deepest at bottom (lowerBin), tapering toward top (upperBin)
        // Shape applies to ALL bins — crossed bins still have liquidity (now as token)
        const posFromBottom = (binId - lowerBin) / (totalBins || 1);
        height = 1.0 - posFromBottom * 0.7;
      } else {
        // Spot: uniform distribution
        height = 0.75;
      }

      // Color: below active = SOL (blue), above active = token (purple).
      // Keep each side visually consistent instead of dimming bars by distance,
      // which made same-side bins look like mixed states.
      let color: string;
      let side: "sol" | "token" | "active" | "oor";
      if (!inRange) {
        color = OOR;
        side = "oor";
      } else if (isActive) {
        color = ACTIVE;
        side = "active";
      } else if (isSolSide) {
        color = SOL;
        side = "sol";
      } else {
        color = TOKEN;
        side = "token";
      }

      result.push({
        height,
        color,
        isActive,
        startBin: binId,
        endBin: Math.min(binId + step - 1, upperBin),
        side,
      });
    }

    return result;
  }, [lowerBin, upperBin, activeBin, inRange, strategy]);

  if (bars.length === 0) return null;

  const hoveredBar = hoveredIndex != null ? bars[hoveredIndex] : null;
  const readout = hoveredBar
    ? `Bins ${hoveredBar.startBin}-${hoveredBar.endBin} · ${hoveredBar.side === "active" ? "active bin" : hoveredBar.side === "sol" ? "SOL side" : hoveredBar.side === "token" ? "token side" : "out of range"}`
    : `Range ${lowerBin}-${upperBin} · ${strategy === "bid_ask" ? "bid-ask profile" : "spot profile"}`;

  return (
    <div>
      {/* Legend + active bin */}
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
            <span className="font-mono text-[9px] text-ash/60">SOL</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-purple-500" />
            <span className="font-mono text-[9px] text-ash/60">Token</span>
          </span>
        </div>
        <span className="font-mono text-[9px] text-ash/60">
          {hoveredBar ? `hover ${hoveredBar.startBin}` : `${strategy === "bid_ask" ? "bid-ask" : "spot"} | bin ${activeBin}`}
        </span>
      </div>

      {/* Chart */}
      <div
        className="flex h-8 items-end gap-px overflow-hidden rounded bg-ink/40 px-0.5"
        onMouseLeave={() => setHoveredIndex(null)}
      >
        {bars.map((bar, i) => (
          <div
            key={i}
            className="flex-1 rounded-t-sm transition-all duration-200"
            onMouseEnter={() => setHoveredIndex(i)}
            title={`Bins ${bar.startBin}-${bar.endBin} · ${bar.side}`}
            style={{
              height: `${bar.height * 100}%`,
              backgroundColor: bar.color,
              minWidth: 1,
              transform: hoveredIndex === i ? "translateY(-1px)" : undefined,
              filter: hoveredIndex === i ? "brightness(1.12)" : undefined,
              boxShadow: bar.isActive ? "0 0 6px rgba(255,255,255,0.5)" : undefined,
            }}
          />
        ))}
      </div>

      {/* Bin labels */}
      <div className="flex justify-between mt-0.5">
        <span className="font-mono text-[9px] text-ash/40">{lowerBin}</span>
        <span className="font-mono text-[9px] text-ash/40">{upperBin}</span>
      </div>

      <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.14em] text-ash/50">
        {readout}
      </div>
    </div>
  );
}

const BinRangeChart = memo(BinRangeChartInner, (prev, next) =>
  prev.activeBin === next.activeBin &&
  prev.inRange === next.inRange &&
  prev.lowerBin === next.lowerBin &&
  prev.upperBin === next.upperBin &&
  prev.strategy === next.strategy
);

export default BinRangeChart;
