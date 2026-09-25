import type { CandidateData } from "../hooks/useWebSocket";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";

interface CandidatesTabProps {
  candidates: CandidateData | null;
  onCommand: (text: string) => void;
}

function formatVolume(v: number | undefined): string {
  if (v == null) return "--";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/4 px-4 py-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ash/56">
        {label}
      </div>
      <div className="mt-2 font-mono text-lg text-cream">
        {value}
      </div>
    </div>
  );
}

export default function CandidatesTab({ candidates, onCommand }: CandidatesTabProps) {
  if (!candidates) {
    return (
      <div className="flex flex-col gap-2 p-3">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-28 w-full rounded-2xl" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  const topCandidate = candidates.candidates[0];

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-3 p-1">
        <div className="flex items-center justify-between px-1">
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ash/56">
              Top Pools
            </span>
            <span className="text-xs text-ash/56">
              Ranked opportunities with direct actions from the table.
            </span>
          </div>
          <span className="font-mono text-[10px] text-ash/60">
            {candidates.total_eligible} eligible / {candidates.total_screened} screened
          </span>
        </div>

        {topCandidate && (
          <Card className="relative overflow-hidden">
            <div className="absolute -right-10 top-0 size-32 rounded-full bg-[radial-gradient(circle,rgba(255,209,102,0.18),transparent_70%)]" />
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <CardTitle>Best Right Now</CardTitle>
                  <CardDescription>
                    Highest-conviction candidate from the latest screening batch.
                  </CardDescription>
                </div>
                <Badge>Rank #1</Badge>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Metric label="Pool" value={topCandidate.name || topCandidate.pool.slice(0, 8)} />
                <Metric
                  label="Fee / TVL"
                  value={topCandidate.fee_active_tvl_ratio != null ? `${topCandidate.fee_active_tvl_ratio.toFixed(2)}%` : "--"}
                />
                <Metric label="Volume" value={formatVolume(topCandidate.volume)} />
                <Metric
                  label="Organic"
                  value={topCandidate.organic_score != null ? `${topCandidate.organic_score.toFixed(0)}` : "--"}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => onCommand("1")}>Deploy #1</Button>
                <Button
                  variant="secondary"
                  onClick={() => onCommand(`What makes ${topCandidate.name || topCandidate.pool} the best candidate right now?`)}
                >
                  Ask Why
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {candidates.candidates.length > 0 ? (
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">#</TableHead>
                    <TableHead>Pool</TableHead>
                    <TableHead className="text-right">Fee/TVL</TableHead>
                    <TableHead className="text-right">Volume</TableHead>
                    <TableHead className="text-right">Organic</TableHead>
                    <TableHead className="text-right">Active %</TableHead>
                    <TableHead className="text-right">Action</TableHead>
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
                        <TableCell className="max-w-[160px]">
                          <div className="flex flex-col gap-1">
                            <span className="truncate font-medium text-cream">
                              {c.name || c.pool.slice(0, 8)}
                            </span>
                            <span className="truncate text-[10px] text-ash/44">
                              {c.pool}
                            </span>
                          </div>
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
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button size="sm" onClick={() => onCommand(String(i + 1))}>
                              Deploy
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => onCommand(`What do you think about pool ${c.pool} (${c.name || "unknown"})?`)}
                            >
                              Ask
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="flex min-h-32 items-center justify-center text-sm text-ash/40">
              No candidates available
            </CardContent>
          </Card>
        )}
      </div>
    </ScrollArea>
  );
}
