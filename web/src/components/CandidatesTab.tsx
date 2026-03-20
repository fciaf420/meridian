import type { CandidateData } from "../hooks/useWebSocket";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";

interface CandidatesTabProps {
  candidates: CandidateData | null;
}

function formatVolume(v: number | undefined): string {
  if (v == null) return "--";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

export default function CandidatesTab({ candidates }: CandidatesTabProps) {
  if (!candidates) {
    return (
      <div className="p-3 space-y-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-3">
        <div className="flex items-center justify-between mb-3">
          <span className="font-mono text-[11px] uppercase tracking-wider text-ash">
            Top Pools
          </span>
          <span className="font-mono text-[10px] text-ash/60">
            {candidates.total_eligible} eligible / {candidates.total_screened} screened
          </span>
        </div>

        {candidates.candidates.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">#</TableHead>
                <TableHead>Pool</TableHead>
                <TableHead className="text-right">Fee/TVL</TableHead>
                <TableHead className="text-right">Volume</TableHead>
                <TableHead className="text-right">Organic</TableHead>
                <TableHead className="text-right">Active %</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {candidates.candidates.map((c, i) => {
                const ratio = c.fee_active_tvl_ratio ?? c.fee_tvl_ratio;
                const vol = c.volume ?? c.volume_window ?? c.volume_24h;
                const activePct = c.active_pct ?? c.active_bin_pct;
                return (
                  <TableRow key={c.pool}>
                    <TableCell className="text-ash/60">{i + 1}</TableCell>
                    <TableCell className="text-cream font-medium max-w-[120px] truncate">
                      {c.name || c.pool.slice(0, 8)}
                    </TableCell>
                    <TableCell className="text-right text-steel">
                      {ratio != null ? `${ratio.toFixed(2)}%` : "--"}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatVolume(vol)}
                    </TableCell>
                    <TableCell className="text-right">
                      {c.organic_score != null ? c.organic_score.toFixed(1) : "--"}
                    </TableCell>
                    <TableCell className="text-right">
                      {activePct != null ? `${activePct.toFixed(0)}%` : "--"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : (
          <div className="text-center py-8 text-ash/40 text-sm">
            No candidates available
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
