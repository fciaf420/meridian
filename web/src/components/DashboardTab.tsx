import { useMemo } from "react";
import type { PositionData, WalletData } from "../hooks/useWebSocket";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import PositionCard from "./PositionCard";

interface DashboardTabProps {
  positions: PositionData | null;
  wallet: WalletData | null;
}

export default function DashboardTab({ positions, wallet }: DashboardTabProps) {
  const oorCount = useMemo(
    () => positions?.positions.filter((p) => !p.in_range).length ?? 0,
    [positions],
  );

  return (
    <ScrollArea className="h-full">
      <div className="p-3 space-y-3">
        {/* Wallet Card */}
        <Card>
          <CardHeader>
            <CardTitle>Wallet</CardTitle>
          </CardHeader>
          <CardContent>
            {wallet ? (
              <div className="flex items-baseline gap-4">
                <span className="font-mono text-lg text-cream font-medium">
                  {wallet.sol.toFixed(3)} <span className="text-ash text-xs">SOL</span>
                </span>
                <span className="font-mono text-sm text-steel">
                  ${wallet.sol_usd.toFixed(2)}
                </span>
                <span className="font-mono text-[10px] text-ash/60 ml-auto">
                  SOL ${wallet.sol_price.toFixed(2)}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-4">
                <Skeleton className="h-6 w-24" />
                <Skeleton className="h-4 w-16" />
              </div>
            )}
          </CardContent>
        </Card>

        {/* OOR Alert */}
        {oorCount > 0 && (
          <div className="rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-400 font-mono">
            {oorCount} position{oorCount > 1 ? "s" : ""} out of range
          </div>
        )}

        {/* Positions */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="font-mono text-[11px] uppercase tracking-wider text-ash">
              Positions
            </span>
            {positions && (
              <span className="font-mono text-[10px] text-ash/60">
                {positions.total_positions} open
              </span>
            )}
          </div>

          {positions ? (
            positions.positions.length > 0 ? (
              <div className="space-y-2">
                {positions.positions.map((p) => (
                  <PositionCard key={p.position} position={p} />
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-ash/40 text-sm">
                No open positions
              </div>
            )
          ) : (
            <div className="space-y-2">
              <Skeleton className="h-24 w-full rounded-lg" />
              <Skeleton className="h-24 w-full rounded-lg" />
            </div>
          )}
        </div>
      </div>
    </ScrollArea>
  );
}
