import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

type LessonItem = {
  id: number;
  rule: string;
  tags?: string[];
  pinned?: boolean;
  role?: string;
  outcome?: string | null;
  created_at?: string;
};

type DarwinWeight = {
  signal: string;
  weight: number;
  direction: string;
};

type DarwinPayload = {
  enabled: boolean;
  last_recalc: string | null;
  recalc_count: number;
  weights: DarwinWeight[];
};

type ExperimentSummary = {
  id: string;
  section: string;
  hypothesis: string;
  status: string;
  started_at: string;
  baseline?: {
    win_rate?: number | null;
    avg_pnl_pct?: number | null;
    positions?: number | null;
  } | null;
  trial?: {
    win_rate?: number | null;
    avg_pnl_pct?: number | null;
    positions?: number | null;
  } | null;
};

type AutoresearchPayload = {
  enabled: boolean;
  cooldownRemaining: number;
  active: ExperimentSummary | null;
  keptOverrideSections: string[];
  recentExperiments: ExperimentSummary[];
  recentLessons: LessonItem[];
};

type MemoryFact = {
  key: string;
  value: string;
  hits: number;
};

type MemoryNugget = {
  name: string;
  fact_count: number;
  capacity_used_pct?: number | null;
  facts: MemoryFact[];
};

type MemoryPayload = {
  total_nuggets: number;
  total_facts: number;
  recalled_facts: number;
  context: string | null;
  nuggets: MemoryNugget[];
};

type InsightsPayload = {
  lessons: {
    total: number;
    lessons: LessonItem[];
  };
  memory: MemoryPayload | null;
  darwin: DarwinPayload;
  autoresearch: AutoresearchPayload;
};

function fmtPct(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return "--";
  return `${value.toFixed(1)}%`;
}

function fmtTimestamp(value: string | null | undefined) {
  if (!value) return "--";
  const ts = new Date(value);
  return Number.isNaN(ts.getTime()) ? value : ts.toLocaleString();
}

function directionLabel(direction: string) {
  switch (direction) {
    case "higher":
      return "higher is better";
    case "lower":
      return "lower is better";
    case "present=better":
      return "presence is better";
    case "absent=better":
      return "absence is better";
    default:
      return "direction unknown";
  }
}

function statusVariant(status: string) {
  if (status === "kept") return "default";
  if (status.includes("revert")) return "destructive";
  if (status === "active") return "secondary";
  return "outline";
}

export default function IntelTab() {
  const [data, setData] = useState<InsightsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchInsights = useCallback(async (mode: "initial" | "refresh" = "initial") => {
    if (mode === "initial") setLoading(true);
    if (mode === "refresh") setRefreshing(true);
    setError(null);

    try {
      const response = await fetch("/api/insights");
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const next = (await response.json()) as InsightsPayload;
      setData(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load insight data");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchInsights();
  }, [fetchInsights]);

  if (loading) {
    return (
      <div className="flex flex-col gap-3 p-1">
        <Skeleton className="h-28 w-full rounded-[24px]" />
        <Skeleton className="h-48 w-full rounded-[24px]" />
        <Skeleton className="h-48 w-full rounded-[24px]" />
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="flex min-h-40 flex-col items-center justify-center gap-3 p-6 text-center">
          <div className="text-sm text-red-400">{error}</div>
          <Button onClick={() => fetchInsights("refresh")} variant="outline">
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-3 p-1">
        <Card className="relative overflow-hidden">
          <div className="absolute inset-x-[-20%] top-0 h-px bg-gradient-to-r from-transparent via-amber-200/80 to-transparent" />
          <CardContent className="flex items-start justify-between gap-4 p-5">
            <div className="space-y-2">
              <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-amber-200/70">
                Intelligence Layer
              </div>
              <div className="text-xl font-semibold tracking-tight text-cream">
                Lessons, memory, Darwin weights, and autoresearch state.
              </div>
              <div className="flex flex-wrap gap-2 text-xs text-ash/60">
                <Badge variant="outline">{data?.lessons.total ?? 0} lessons</Badge>
                <Badge variant={data?.darwin.enabled ? "secondary" : "outline"}>
                  Darwin {data?.darwin.enabled ? "enabled" : "disabled"}
                </Badge>
                <Badge variant={data?.autoresearch.enabled ? "secondary" : "outline"}>
                  Autoresearch {data?.autoresearch.enabled ? "enabled" : "disabled"}
                </Badge>
              </div>
            </div>

            <Button
              onClick={() => fetchInsights("refresh")}
              variant="outline"
              disabled={refreshing}
              className="shrink-0"
            >
              {refreshing ? "Refreshing..." : "Refresh"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-amber-200/66">Lessons</div>
                <div className="mt-1 text-base font-medium tracking-tight text-cream">Recent reusable rules</div>
              </div>
              <Badge variant="outline">{data?.lessons.lessons.length ?? 0} shown</Badge>
            </div>

            {data?.lessons.lessons.length ? (
              <div className="flex flex-col gap-2">
                {data.lessons.lessons.map((lesson) => (
                  <div key={lesson.id} className="rounded-2xl border border-white/8 bg-white/4 px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="text-sm text-cream/90">{lesson.rule}</div>
                      <div className="flex shrink-0 gap-1">
                        {lesson.pinned ? <Badge variant="secondary">Pinned</Badge> : null}
                        {lesson.outcome ? <Badge variant="outline">{lesson.outcome}</Badge> : null}
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ash/56">
                      <span>ID {lesson.id}</span>
                      <span>{lesson.role ?? "all"}</span>
                      <span>{lesson.created_at ?? "--"}</span>
                      {(lesson.tags || []).map((tag) => (
                        <span key={`${lesson.id}-${tag}`} className="rounded-md bg-steel/18 px-2 py-0.5 font-mono uppercase tracking-[0.14em]">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-ash/46">No lessons recorded yet.</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="mb-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-amber-200/66">Memory</div>
              <div className="mt-1 text-base font-medium tracking-tight text-cream">Prompt-injected nuggets</div>
            </div>

            {data?.memory ? (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2 text-xs text-ash/60">
                  <Badge variant="outline">{data.memory.total_nuggets} nuggets</Badge>
                  <Badge variant="secondary">{data.memory.total_facts} facts</Badge>
                  <Badge variant="secondary">{data.memory.recalled_facts} recalled</Badge>
                </div>

                {data.memory.context ? (
                  <pre className="whitespace-pre-wrap break-words rounded-2xl border border-white/8 bg-white/4 px-4 py-3 font-mono text-[11px] leading-relaxed text-cream/85">
                    {data.memory.context}
                  </pre>
                ) : null}

                <div className="grid gap-3 lg:grid-cols-2">
                  {data.memory.nuggets.map((nugget) => (
                    <div key={nugget.name} className="rounded-2xl border border-white/8 bg-white/4 px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-ash/60">{nugget.name}</div>
                          <div className="mt-1 text-sm text-cream/86">{nugget.fact_count} facts</div>
                        </div>
                        {nugget.capacity_used_pct != null ? (
                          <Badge variant="outline">{fmtPct(nugget.capacity_used_pct)}</Badge>
                        ) : null}
                      </div>

                      <div className="mt-3 flex flex-col gap-2">
                        {nugget.facts.length ? (
                          nugget.facts.map((fact) => (
                            <div key={`${nugget.name}-${fact.key}`} className="rounded-xl border border-white/6 bg-black/10 px-3 py-2">
                              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ash/56">{fact.key}</div>
                              <div className="mt-1 text-sm text-cream/84">{fact.value}</div>
                              <div className="mt-1 text-[10px] text-ash/52">hits: {fact.hits}</div>
                            </div>
                          ))
                        ) : (
                          <div className="text-sm text-ash/46">No facts stored.</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-sm text-ash/46">No promoted memory facts yet.</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-amber-200/66">Darwin Weights</div>
                <div className="mt-1 text-base font-medium tracking-tight text-cream">Learned signal ranking</div>
              </div>
              <div className="text-right text-xs text-ash/56">
                <div>{data?.darwin.recalc_count ?? 0} recalcs</div>
                <div>{fmtTimestamp(data?.darwin.last_recalc)}</div>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              {(data?.darwin.weights || []).map((entry) => (
                <div key={entry.signal} className="rounded-2xl border border-white/8 bg-white/4 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-cream/90">{entry.signal}</div>
                      <div className="mt-1 text-xs text-ash/56">{directionLabel(entry.direction)}</div>
                    </div>
                    <div className="font-mono text-lg text-cream">{entry.weight.toFixed(2)}</div>
                  </div>
                  <div className="mt-3 h-2 rounded-full bg-white/8">
                    <div
                      className="h-2 rounded-full bg-[linear-gradient(90deg,rgba(89,131,146,0.85),rgba(255,209,102,0.92))]"
                      style={{ width: `${Math.max(8, Math.min(100, (entry.weight / 2.5) * 100))}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-amber-200/66">Autoresearch</div>
                <div className="mt-1 text-base font-medium tracking-tight text-cream">Prompt experiments and lessons</div>
              </div>
              <Badge variant={data?.autoresearch.active ? "secondary" : "outline"}>
                {data?.autoresearch.active ? "Experiment active" : "Idle"}
              </Badge>
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              <div className="rounded-2xl border border-white/8 bg-white/4 px-4 py-3">
                <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-ash/60">Current State</div>
                <div className="mt-3 space-y-2 text-sm text-cream/84">
                  <div>Cooldown remaining: {data?.autoresearch.cooldownRemaining ?? 0}</div>
                  <div>Kept overrides: {(data?.autoresearch.keptOverrideSections || []).join(", ") || "none"}</div>
                  {data?.autoresearch.active ? (
                    <>
                      <Separator className="my-3" />
                      <div className="font-medium text-cream">Active: {data.autoresearch.active.section}</div>
                      <div>{data.autoresearch.active.hypothesis}</div>
                      <div className="text-xs text-ash/56">Started {fmtTimestamp(data.autoresearch.active.started_at)}</div>
                    </>
                  ) : (
                    <div className="text-ash/46">No active experiment.</div>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-white/8 bg-white/4 px-4 py-3">
                <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-ash/60">Recent Autoresearch Lessons</div>
                <div className="mt-3 flex flex-col gap-2">
                  {(data?.autoresearch.recentLessons || []).length ? (
                    data!.autoresearch.recentLessons.map((lesson) => (
                      <div key={`autoresearch-lesson-${lesson.id}`} className="rounded-xl border border-white/6 bg-black/10 px-3 py-2 text-sm text-cream/84">
                        <div>{lesson.rule}</div>
                        <div className="mt-1 text-[11px] text-ash/52">{lesson.created_at ?? "--"}</div>
                      </div>
                    ))
                  ) : (
                    <div className="text-sm text-ash/46">No autoresearch lessons logged yet.</div>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-4 flex flex-col gap-2">
              <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-ash/60">Recent Experiments</div>
              {(data?.autoresearch.recentExperiments || []).length ? (
                data!.autoresearch.recentExperiments.map((experiment) => (
                  <div key={experiment.id} className="rounded-2xl border border-white/8 bg-white/4 px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium text-cream">{experiment.section}</div>
                        <div className="mt-1 text-sm text-cream/82">{experiment.hypothesis}</div>
                      </div>
                      <Badge variant={statusVariant(experiment.status)}>{experiment.status}</Badge>
                    </div>
                    <div className="mt-3 grid gap-2 text-sm text-ash/64 sm:grid-cols-3">
                      <div>Started: {fmtTimestamp(experiment.started_at)}</div>
                      <div>Baseline WR: {fmtPct(experiment.baseline?.win_rate)}</div>
                      <div>Trial WR: {fmtPct(experiment.trial?.win_rate)}</div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-sm text-ash/46">No autoresearch experiments recorded yet.</div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </ScrollArea>
  );
}
