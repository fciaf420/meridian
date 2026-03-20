import type { PositionData, WalletData, CandidateData, Notification, StatusInfo, LpOverviewData, QuickActionResult } from "../hooks/useWebSocket";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import DashboardTab from "./DashboardTab";
import CandidatesTab from "./CandidatesTab";
import ActivityTab from "./ActivityTab";

interface DataSidebarProps {
  positions: PositionData | null;
  wallet: WalletData | null;
  candidates: CandidateData | null;
  notifications: Notification[];
  status: StatusInfo;
  lpOverview: LpOverviewData | null;
  onCommand: (text: string) => void;
  sendQuickAction: (action: string) => void;
  quickActionResult: QuickActionResult | null;
  clearQuickActionResult: () => void;
}

export default function DataSidebar({ positions, wallet, candidates, notifications, lpOverview, onCommand, sendQuickAction, quickActionResult, clearQuickActionResult }: DataSidebarProps) {
  const activeAlerts = positions?.positions.filter((position) => !position.in_range).length ?? 0;
  const openPositions = positions?.total_positions ?? 0;

  return (
    <Tabs defaultValue="dashboard" className="flex h-full flex-col gap-3 px-3 py-3 lg:px-4">
      <div className="flex items-start justify-between gap-3 rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(255,209,102,0.08),rgba(255,209,102,0.02))] px-4 py-3 shadow-[0_18px_34px_rgba(0,0,0,0.16)]">
        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-amber-200/70">
            Mission Control
          </span>
          <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
            <span className="text-xl font-semibold tracking-tight text-cream">Trading Desk</span>
            <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-ash/56">
              {openPositions} open positions
            </span>
          </div>
          <span className="max-w-md text-sm text-cream/76">
            Portfolio state, ranked deploys, and live activity with faster decision paths.
          </span>
        </div>
        <Badge variant={activeAlerts > 0 ? "destructive" : "secondary"}>
          {activeAlerts > 0 ? `${activeAlerts} alerts` : "stable"}
        </Badge>
      </div>

      <TabsList>
        <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
        <TabsTrigger value="candidates">Candidates</TabsTrigger>
        <TabsTrigger value="activity">Activity</TabsTrigger>
      </TabsList>

      <TabsContent value="dashboard" className="flex-1">
        <DashboardTab positions={positions} wallet={wallet} lpOverview={lpOverview} sendQuickAction={sendQuickAction} quickActionResult={quickActionResult} clearQuickActionResult={clearQuickActionResult} />
      </TabsContent>

      <TabsContent value="candidates" className="flex-1">
        <CandidatesTab candidates={candidates} onCommand={onCommand} />
      </TabsContent>

      <TabsContent value="activity" className="flex-1">
        <ActivityTab notifications={notifications} />
      </TabsContent>
    </Tabs>
  );
}
