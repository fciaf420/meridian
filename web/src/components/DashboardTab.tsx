import { useMemo } from "react";
import type { PositionData, WalletData, LpOverviewData } from "../hooks/useWebSocket";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import PositionCard from "./PositionCard";

interface DashboardTabProps {
  positions: PositionData | null;
  wallet: WalletData | null;
  lpOverview: LpOverviewData | null;
}

export default function DashboardTab({ positions, wallet, lpOverview }: DashboardTabProps) {
  const oorCount = useMemo(
    () => positions?.positions.filter((p) => !p.in_range).length ?? 0,
    [positions],
  );
  const openPositions = positions?.total_positions ?? 0;

  const heroStats = [
    {
      label: "Net PnL",
      value: lpOverview ? `${lpOverview.total_pnl_sol >= 0 ? "+" : ""}${lpOverview.total_pnl_sol.toFixed(3)} SOL` : "--",
      detail: lpOverview ? `$${lpOverview.total_pnl_usd.toFixed(0)}` : "Awaiting LP data",
      tone: lpOverview && lpOverview.total_pnl_sol < 0 ? "text-red-400" : "text-emerald-300",
    },
    {
      label: "Win Rate",
      value: lpOverview ? `${lpOverview.win_rate_pct.toFixed(1)}%` : "--",
      detail: lpOverview ? `${lpOverview.closed_positions} closed` : "No history yet",
      tone: "text-cream",
    },
    {
      label: "Exposure",
      value: `${openPositions} open`,
      detail: oorCount > 0 ? `${oorCount} OOR` : "All in range",
      tone: oorCount > 0 ? "text-amber-300" : "text-cream",
    },
    {
      label: "Fees",
      value: lpOverview ? `${lpOverview.total_fees_sol.toFixed(3)} SOL` : "--",
      detail: lpOverview ? `$${lpOverview.total_fees_usd.toFixed(0)}` : "Awaiting LP data",
      tone: "text-cream",
    },
  ];

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-3 p-1">
        <Card className="relative overflow-hidden">
          <div className="absolute inset-x-[-20%] top-0 h-px bg-gradient-to-r from-transparent via-amber-200/80 to-transparent" />
          <div className="absolute -left-10 top-10 h-36 w-36 rounded-full bg-[radial-gradient(circle,rgba(255,209,102,0.16),transparent_72%)]" />
          <div className="absolute right-0 top-0 h-full w-1/3 bg-[linear-gradient(135deg,rgba(255,209,102,0.08),transparent_56%)]" />
          <CardContent className="grid gap-4 p-4 lg:grid-cols-[1.2fr_0.95fr]">
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

            <div className="grid gap-3 sm:grid-cols-2">
              {heroStats.map((stat) => (
                <div
                  key={stat.label}
                  className="rounded-[22px] border border-white/8 bg-[linear-gradient(180deg,rgba(12,55,71,0.68),rgba(2,27,36,0.92))] px-4 py-4 shadow-[0_14px_26px_rgba(0,0,0,0.18)]"
                >
                  <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ash/58">
                    {stat.label}
                  </div>
                  <div className={`mt-3 font-mono text-2xl ${stat.tone}`}>
                    {wallet || lpOverview || stat.label === "Exposure" ? stat.value : <Skeleton className="h-8 w-24" />}
                  </div>
                  <div className="mt-1 text-xs text-ash/58">
                    {wallet || lpOverview || stat.label === "Exposure" ? stat.detail : <Skeleton className="h-4 w-20" />}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <CardTitle>Desk Breakdown</CardTitle>
                <CardDescription>
                  Live wallet state, realized performance, and current risk posture.
                </CardDescription>
              </div>
              <Badge variant={oorCount > 0 ? "destructive" : "secondary"}>
                {oorCount > 0 ? `${oorCount} OOR` : "Healthy"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="grid gap-3 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-white/8 bg-white/4 px-4 py-3">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ash/56">Wallet Value</div>
                {wallet ? (
                  <div className="mt-2 flex items-end justify-between gap-3">
                    <div className="font-mono text-2xl text-cream">{wallet.sol.toFixed(3)} SOL</div>
                    <div className="text-right">
                      <div className="font-mono text-sm text-cream/80">${wallet.sol_usd.toFixed(2)}</div>
                      <div className="text-[11px] text-ash/52">SOL ${wallet.sol_price.toFixed(2)}</div>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2 flex flex-col gap-2">
                    <Skeleton className="h-8 w-28" />
                    <Skeleton className="h-4 w-20" />
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-white/8 bg-white/4 px-4 py-3">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ash/56">Current Exposure</div>
                <div className="mt-2 flex items-end justify-between gap-3">
                  <div className="font-mono text-2xl text-cream">{openPositions}</div>
                  <div className="text-right text-[11px] text-ash/56">
                    {oorCount > 0 ? `${oorCount} out of range` : "All positions healthy"}
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-2 rounded-xl border border-white/8 bg-white/4 px-4 py-3 font-mono text-[11px]">
              {lpOverview ? (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-ash/62">Total PnL</span>
                    <span className={lpOverview.total_pnl >= 0 ? "text-emerald-300" : "text-red-400"}>
                      {lpOverview.total_pnl >= 0 ? "+" : ""}{lpOverview.total_pnl_sol.toFixed(4)} SOL
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-ash/62">Fees Captured</span>
                    <span className="text-cream">{lpOverview.total_fees_sol.toFixed(4)} SOL</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-ash/62">Win Rate</span>
                    <span className="text-cream">{lpOverview.win_rate_pct.toFixed(1)}%</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-ash/62">Average Hold</span>
                    <span className="text-cream">{lpOverview.avg_hold_hours.toFixed(1)}h</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-ash/62">ROI</span>
                    <span className={lpOverview.roi_pct >= 0 ? "text-emerald-300" : "text-red-400"}>
                      {lpOverview.roi_pct >= 0 ? "+" : ""}{lpOverview.roi_pct.toFixed(2)}%
                    </span>
                  </div>
                </>
              ) : (
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              )}
            </div>
          </CardContent>
        </Card>

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
