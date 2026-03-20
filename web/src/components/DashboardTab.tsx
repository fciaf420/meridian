import { useMemo } from "react";
import type { PositionData, WalletData, LpOverviewData, QuickActionResult } from "../hooks/useWebSocket";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import PositionCard from "./PositionCard";
import QuickActions from "./QuickActions";

interface DashboardTabProps {
  positions: PositionData | null;
  wallet: WalletData | null;
  lpOverview: LpOverviewData | null;
  sendQuickAction: (action: string) => void;
  quickActionResult: QuickActionResult | null;
  clearQuickActionResult: () => void;
}

export default function DashboardTab({ positions, wallet, lpOverview, sendQuickAction, quickActionResult, clearQuickActionResult }: DashboardTabProps) {
  const oorCount = useMemo(
    () => positions?.positions.filter((p) => !p.in_range).length ?? 0,
    [positions],
  );

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-3 p-1">
        <Card className="relative overflow-hidden">
          <div className="absolute inset-x-[-20%] top-0 h-px bg-gradient-to-r from-transparent via-amber-200/80 to-transparent" />
          <div className="absolute -left-10 top-10 h-36 w-36 rounded-full bg-[radial-gradient(circle,rgba(255,209,102,0.16),transparent_72%)]" />
          <div className="absolute right-0 top-0 h-full w-1/3 bg-[linear-gradient(135deg,rgba(255,209,102,0.08),transparent_56%)]" />
          <CardContent className="p-4">
            <div className="flex min-h-[220px] flex-col justify-between rounded-[24px] border border-amber-200/12 bg-[linear-gradient(180deg,rgba(255,209,102,0.1),rgba(255,209,102,0.02))] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-amber-200/72">
                    Portfolio Pulse
                  </span>
                  <div className="max-w-sm">
                    <div className="text-3xl font-semibold leading-none tracking-tight text-cream sm:text-4xl">
                      {wallet ? `${wallet.sol.toFixed(2)} SOL` : <Skeleton className="h-10 w-36" />}
                    </div>
                    <div className="mt-2 text-sm text-cream/74">
                      {wallet ? `$${wallet.sol_usd.toFixed(0)} on hand with live DLMM capital ready to move.` : "Awaiting wallet state"}
                    </div>
                  </div>
                </div>
                <Badge variant={oorCount > 0 ? "destructive" : "secondary"}>
                  {oorCount > 0 ? `${oorCount} OOR` : "Healthy"}
                </Badge>
              </div>

              <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ash/58">Desk Read</div>
                  <div className="mt-2 max-w-md text-sm text-cream/80">
                    {lpOverview
                      ? `Closed ${lpOverview.closed_positions} positions with ${lpOverview.win_rate_pct.toFixed(1)}% wins and ${lpOverview.total_fees_sol.toFixed(3)} SOL captured in fees.`
                      : "Waiting for realized performance data before publishing the desk read."}
                  </div>
                </div>
                {lpOverview ? (
                  <div className="text-right">
                    <div className={`font-mono text-3xl ${lpOverview.total_pnl_sol < 0 ? "text-red-400" : "text-emerald-300"}`}>
                      {lpOverview.total_pnl_sol >= 0 ? "+" : ""}{lpOverview.total_pnl_sol.toFixed(3)}
                    </div>
                    <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ash/56">SOL net pnl</div>
                  </div>
                ) : (
                  <div className="flex flex-col items-end gap-2">
                    <Skeleton className="h-9 w-24" />
                    <Skeleton className="h-3 w-18" />
                  </div>
                )}
              </div>
            </div>

          </CardContent>
        </Card>

        <QuickActions
          sendQuickAction={sendQuickAction}
          quickActionResult={quickActionResult}
          clearQuickActionResult={clearQuickActionResult}
        />

        <div className="flex items-center justify-between px-1">
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-amber-200/70">
              Positions
            </span>
            <span className="text-base font-medium tracking-tight text-cream">
              Open range inventory
            </span>
            <span className="text-xs text-ash/56">
              Live PnL, fees, range state, and direct jump-outs to pool and token views.
            </span>
          </div>
          {positions && (
            <Badge variant="outline">
              {positions.total_positions} open
            </Badge>
          )}
        </div>

        {positions ? (
          positions.positions.length > 0 ? (
            <div className="flex flex-col gap-2">
              {positions.positions.map((p) => (
                <PositionCard key={p.position} position={p} />
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="flex min-h-32 items-center justify-center text-sm text-ash/46">
                No open positions
              </CardContent>
            </Card>
          )
        ) : (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-24 w-full rounded-2xl" />
            <Skeleton className="h-24 w-full rounded-2xl" />
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
