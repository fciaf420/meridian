import { memo, useMemo } from "react";

interface BinRangeChartProps {
  lowerBin: number;
  upperBin: number;
  activeBin: number;
  inRange: boolean;
  strategy?: "bid_ask" | "spot";
}

// Colors
const SOL = "rgb(59, 130, 246)";           // blue-500
const SOL_DIM = "rgba(59, 130, 246, 0.3)";
const TOKEN = "rgb(168, 85, 247)";         // purple-500
const TOKEN_DIM = "rgba(168, 85, 247, 0.3)";
const ACTIVE = "rgba(255, 255, 255, 0.85)";
const OOR = "rgba(248, 113, 113, 0.35)";

const MAX_BARS = 44;

function BinRangeChartInner({ lowerBin, upperBin, activeBin, inRange, strategy = "bid_ask" }: BinRangeChartProps) {
  const bars = useMemo(() => {
    const totalBins = upperBin - lowerBin;
    if (totalBins <= 0) return [];

    const step = totalBins > MAX_BARS ? Math.ceil(totalBins / MAX_BARS) : 1;
    const barCount = Math.ceil(totalBins / step);

    const result: Array<{ height: number; color: string; isActive: boolean }> = [];

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

      // Color: below active = SOL (blue), above active = token (purple)
      // Crossed bins hold token, uncrossed bins hold SOL
      let color: string;
      if (!inRange) {
        color = OOR;
      } else if (isActive) {
        color = ACTIVE;
      } else if (isSolSide) {
        // SOL side — brighter closer to active
        const distNorm = Math.abs(binId - activeBin) / (totalBins || 1);
        color = distNorm < 0.5 ? SOL : SOL_DIM;
      } else {
        // Token side (already crossed / converted)
        const distNorm = Math.abs(binId - activeBin) / (totalBins || 1);
        color = distNorm < 0.5 ? TOKEN : TOKEN_DIM;
      }

      result.push({ height, color, isActive });
    }

    return result;
  }, [lowerBin, upperBin, activeBin, inRange, strategy]);

  if (bars.length === 0) return null;

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
          {strategy === "bid_ask" ? "bid-ask" : "spot"} | bin {activeBin}
        </span>
      </div>

      {/* Chart */}
      <div className="flex items-end gap-px h-8 rounded overflow-hidden bg-ink/40 px-0.5">
        {bars.map((bar, i) => (
          <div
            key={i}
            className="flex-1 rounded-t-sm transition-all duration-300"
            style={{
              height: `${bar.height * 100}%`,
              backgroundColor: bar.color,
              minWidth: 1,
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
