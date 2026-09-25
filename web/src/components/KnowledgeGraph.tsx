import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import ForceGraph2D from "react-force-graph-2d";
import type {
  ForceGraphMethods,
  NodeObject,
  LinkObject,
} from "react-force-graph-2d";
import {
  X,
  Search,
  Network,
  Filter,
  Wallet,
  Droplets,
  Target,
  BookOpen,
  Puzzle,
  Sparkles,
  Clock,
  ChevronRight,
  ChevronDown,
  AlertTriangle,
  Lightbulb,
  Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface KnowledgeGraphProps {
  open: boolean;
  onClose: () => void;
  sendQuickAction: (action: string) => void;
  quickActionResult: { action: string; data: unknown; error?: string } | null;
  clearQuickActionResult: () => void;
}

interface GraphNode {
  id: string;
  type: "wallet" | "pool" | "position" | "strategy" | "lesson" | "pattern";
  label: string;
  size: number;
  color: string;
  data: Record<string, unknown>;
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
}

interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
  label?: string;
  style: "solid" | "dashed" | "thin";
  color?: string;
}

type GNode = NodeObject<GraphNode>;
type GLink = LinkObject<GraphNode, GraphLink>;

type TimeRange = "24h" | "7d" | "all";

const NODE_TYPES = [
  "pool",
  "position",
  "strategy",
  "lesson",
  "pattern",
] as const;

const TYPE_ICONS: Record<GraphNode["type"], typeof Wallet> = {
  wallet: Wallet,
  pool: Droplets,
  position: Target,
  strategy: Puzzle,
  lesson: BookOpen,
  pattern: Sparkles,
};

const TYPE_META: Record<
  GraphNode["type"],
  { label: string; color: string }
> = {
  wallet: { label: "Wallet", color: "#ffd166" },
  pool: { label: "Pools", color: "#598392" },
  position: { label: "Positions", color: "#6ee7b7" },
  strategy: { label: "Strategies", color: "#a78bfa" },
  lesson: { label: "Lessons", color: "#f472b6" },
  pattern: { label: "Patterns", color: "#38bdf8" },
};

/* ------------------------------------------------------------------ */
/*  Relative time formatter                                            */
/* ------------------------------------------------------------------ */

function fmtRelativeTime(raw: unknown): string {
  if (raw == null) return "--";
  const s = String(raw);
  const ts = new Date(s).getTime();
  if (isNaN(ts)) return s;
  const diff = Date.now() - ts;
  if (diff < 0) return s;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: ts < Date.now() - 365 * 86400000 ? "numeric" : undefined,
  });
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function KnowledgeGraph({
  open,
  onClose,
  sendQuickAction,
  quickActionResult,
  clearQuickActionResult,
}: KnowledgeGraphProps) {
  /* ---------- state ---------- */
  const [graphData, setGraphData] = useState<{
    nodes: GraphNode[];
    links: GraphLink[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeFilters, setActiveFilters] = useState<Set<string>>(
    () => new Set(["wallet", ...NODE_TYPES]),
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  const [selectedNode, setSelectedNode] = useState<GNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<GNode | null>(null);
  const [visible, setVisible] = useState(false);
  const [expandedPools, setExpandedPools] = useState<Set<string>>(() => new Set());
  const [globalInsights, setGlobalInsights] = useState<{type: "warning"|"opportunity"|"info"; text: string}[]>([]);
  const [insightsExpanded, setInsightsExpanded] = useState(true);

  /* ---------- refs ---------- */
  const graphRef = useRef<
    ForceGraphMethods<NodeObject<GraphNode>, LinkObject<GraphNode, GraphLink>> | undefined
  >(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(800);
  const [canvasHeight, setCanvasHeight] = useState(600);

  /* ---------- ResizeObserver ---------- */
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !open) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0) setCanvasWidth(rect.width);
      if (rect.height > 0) setCanvasHeight(rect.height);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, graphData]);

  /* ---------- open / close lifecycle ---------- */
  useEffect(() => {
    if (open) {
      setVisible(true);
      setLoading(true);
      setError(null);
      sendQuickAction("knowledge-graph");
    } else {
      setVisible(false);
    }
  }, [open, sendQuickAction]);

  /* ---------- configure d3 forces for better spacing ---------- */
  useEffect(() => {
    if (!graphData || !graphRef.current) return;
    const fg = graphRef.current;
    fg.d3Force?.("charge")?.strength?.(-80);
    fg.d3Force?.("link")?.distance?.(() => 50);
    fg.d3Force?.("center")?.strength?.(0.08);
  }, [graphData]);

  /* ---------- receive data ---------- */
  useEffect(() => {
    if (
      quickActionResult &&
      quickActionResult.action === "knowledge-graph"
    ) {
      if (quickActionResult.error) {
        setError(quickActionResult.error);
        setLoading(false);
        return;
      }
      const raw = quickActionResult.data as {
        nodes?: GraphNode[];
        links?: GraphLink[];
        insights?: {type: "warning"|"opportunity"|"info"; text: string}[];
      } | null;
      if (raw && Array.isArray(raw.nodes) && Array.isArray(raw.links)) {
        setGraphData({ nodes: raw.nodes, links: raw.links });
        if (Array.isArray(raw.insights)) setGlobalInsights(raw.insights);
        // Center the graph after a brief delay for layout to settle
        setTimeout(() => {
          graphRef.current?.zoomToFit?.(400, 60);
        }, 500);
      } else {
        setError("Invalid graph data received.");
      }
      setLoading(false);
    }
  }, [quickActionResult]);

  /* ---------- keyboard ---------- */
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (selectedNode) {
          setSelectedNode(null);
        } else {
          handleClose();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedNode]);

  /* ---------- close handler ---------- */
  const handleClose = useCallback(() => {
    setVisible(false);
    clearQuickActionResult();
    // wait for fade out then call onClose
    setTimeout(() => {
      onClose();
      setGraphData(null);
      setSelectedNode(null);
      setSearchQuery("");
      setActiveFilters(new Set(["wallet", ...NODE_TYPES]));
      setTimeRange("all");
      setExpandedPools(new Set());
      setGlobalInsights([]);
    }, 200);
  }, [onClose, clearQuickActionResult]);

  /* ---------- build pool -> children mapping from edges ---------- */
  const poolChildren = useMemo(() => {
    if (!graphData) return new Map<string, Set<string>>();
    const map = new Map<string, Set<string>>();
    for (const link of graphData.links) {
      const srcId = typeof link.source === "string" ? link.source : (link.source as GraphNode).id;
      const tgtId = typeof link.target === "string" ? link.target : (link.target as GraphNode).id;
      // skip wallet edges
      if (srcId === "wallet" || tgtId === "wallet") continue;
      // find which end is a pool
      const srcNode = graphData.nodes.find((n) => n.id === srcId);
      const tgtNode = graphData.nodes.find((n) => n.id === tgtId);
      if (srcNode?.type === "pool" && tgtNode?.type !== "pool") {
        if (!map.has(srcId)) map.set(srcId, new Set());
        map.get(srcId)!.add(tgtId);
      } else if (tgtNode?.type === "pool" && srcNode?.type !== "pool") {
        if (!map.has(tgtId)) map.set(tgtId, new Set());
        map.get(tgtId)!.add(srcId);
      }
    }
    return map;
  }, [graphData]);

  /* ---------- filtering (expand/collapse aware) ---------- */
  const filteredData = useMemo(() => {
    if (!graphData) return { nodes: [] as GNode[], links: [] as GLink[] };

    const now = Date.now();
    const cutoff =
      timeRange === "24h"
        ? now - 24 * 60 * 60 * 1000
        : timeRange === "7d"
          ? now - 7 * 24 * 60 * 60 * 1000
          : 0;

    const lowerSearch = searchQuery.toLowerCase();

    // Collect all child IDs of expanded pools
    const expandedChildIds = new Set<string>();
    for (const poolId of expandedPools) {
      const children = poolChildren.get(poolId);
      if (children) for (const c of children) expandedChildIds.add(c);
    }

    const visibleNodes = graphData.nodes.filter((node) => {
      // wallet always visible
      if (node.type === "wallet") return true;
      // pools always visible (they're the primary level)
      if (node.type === "pool") {
        if (!activeFilters.has("pool")) return false;
        if (lowerSearch && !node.label.toLowerCase().includes(lowerSearch)) return false;
        return true;
      }
      // child nodes only visible if their parent pool is expanded
      if (!expandedChildIds.has(node.id)) return false;
      // type filter
      if (!activeFilters.has(node.type)) return false;
      // time filter for positions
      if (node.type === "position" && cutoff > 0) {
        const created = node.data.deployed_at ?? node.data.created_at;
        if (created && typeof created === "string") {
          const ts = new Date(created).getTime();
          if (!isNaN(ts) && ts < cutoff) return false;
        }
      }
      // search filter
      if (lowerSearch && !node.label.toLowerCase().includes(lowerSearch)) return false;
      return true;
    });

    const visibleIds = new Set(visibleNodes.map((n) => n.id));

    const visibleLinks = graphData.links.filter((link) => {
      const srcId = typeof link.source === "string" ? link.source : (link.source as GraphNode).id;
      const tgtId = typeof link.target === "string" ? link.target : (link.target as GraphNode).id;
      return visibleIds.has(srcId) && visibleIds.has(tgtId);
    });

    return {
      nodes: visibleNodes as GNode[],
      links: visibleLinks as GLink[],
    };
  }, [graphData, activeFilters, searchQuery, timeRange, expandedPools, poolChildren]);

  /* ---------- dimming set for search ---------- */
  const dimmedIds = useMemo(() => {
    if (!searchQuery || !graphData) return new Set<string>();
    const lower = searchQuery.toLowerCase();
    const dimmed = new Set<string>();
    for (const node of graphData.nodes) {
      if (!node.label.toLowerCase().includes(lower) && node.type !== "wallet") {
        dimmed.add(node.id);
      }
    }
    return dimmed;
  }, [graphData, searchQuery]);

  /* ---------- toggle filter ---------- */
  const toggleFilter = useCallback((type: string) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  /* ---------- node click ---------- */
  const handleNodeClick = useCallback((node: GNode) => {
    if (node.type === "pool") {
      const isExpanding = !expandedPools.has(node.id);
      setExpandedPools((prev) => {
        const next = new Set(prev);
        if (next.has(node.id)) next.delete(node.id);
        else next.add(node.id);
        return next;
      });
      // When expanding, position children in a wide circle around the pool
      if (isExpanding && graphData) {
        const children = poolChildren.get(node.id);
        if (children && children.size > 0) {
          const total = children.size;
          const radius = Math.max(140, total * 25);
          let i = 0;
          for (const childId of children) {
            const childNode = graphData.nodes.find((n) => n.id === childId) as GNode | undefined;
            if (childNode) {
              const angle = (2 * Math.PI * i) / total - Math.PI / 2;
              childNode.x = (node.x ?? 0) + radius * Math.cos(angle);
              childNode.y = (node.y ?? 0) + radius * Math.sin(angle);
              childNode.fx = undefined;
              childNode.fy = undefined;
              i++;
            }
          }
          // Reheat simulation so layout adjusts
          setTimeout(() => graphRef.current?.d3ReheatSimulation?.(), 50);
        }
      }
    }
    setSelectedNode(node);
  }, [expandedPools, graphData, poolChildren]);

  /* ---------- node hover ---------- */
  const handleNodeHover = useCallback((node: GNode | null) => {
    setHoveredNode(node);
  }, []);

  /* ---------- node drag end ---------- */
  const handleNodeDragEnd = useCallback((node: GNode) => {
    node.fx = node.x;
    node.fy = node.y;
  }, []);

  /* ---------- animation frame for pulsing live positions ---------- */
  const frameRef = useRef(0);
  useEffect(() => {
    if (!open) return;
    let raf: number;
    const tick = () => {
      frameRef.current = performance.now();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [open]);

  /* ---------- custom node renderer ---------- */
  const drawNode = useCallback(
    (node: GNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const r = (node.size ?? 4) * 1.1;
      const isHovered = hoveredNode?.id === node.id;
      const isDimmed = dimmedIds.has(node.id);
      const alpha = isDimmed ? 0.25 : 1;
      const fillColor = node.color || "#598392";

      ctx.save();
      ctx.globalAlpha = alpha;

      // Subtle glow for all nodes (no offsetY)
      ctx.shadowColor = "rgba(0,0,0,0.45)";
      ctx.shadowBlur = 6;

      switch (node.type) {
        case "wallet": {
          // Circle with double ring and golden glow
          const grad = ctx.createRadialGradient(x, y, 0, x, y, r * 1.3);
          grad.addColorStop(0, "#ffe9a0");
          grad.addColorStop(0.6, "#ffd166");
          grad.addColorStop(1, "#b8860b");

          if (isHovered) {
            ctx.shadowColor = "#ffd166";
            ctx.shadowBlur = 22;
          }

          // Outer double ring
          ctx.beginPath();
          ctx.arc(x, y, r * 1.45, 0, 2 * Math.PI);
          ctx.strokeStyle = "rgba(255,209,102,0.35)";
          ctx.lineWidth = 1.5;
          ctx.stroke();

          // Main circle
          ctx.beginPath();
          ctx.arc(x, y, r * 1.3, 0, 2 * Math.PI);
          ctx.fillStyle = grad;
          ctx.fill();

          // Subtle outer ring (universal)
          ctx.beginPath();
          ctx.arc(x, y, r * 1.3, 0, 2 * Math.PI);
          ctx.strokeStyle = "rgba(255,255,255,0.15)";
          ctx.lineWidth = 1;
          ctx.stroke();

          // "W" letter in center
          ctx.shadowColor = "transparent";
          ctx.shadowBlur = 0;
          const wSize = Math.max(r * 0.8, 3);
          ctx.font = `bold ${wSize}px 'IBM Plex Sans', sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = "rgba(60,30,0,0.7)";
          ctx.fillText("W", x, y + 0.5);
          break;
        }
        case "pool": {
          // Circle with radial gradient and subtle outer ring
          const isExpanded = expandedPools.has(node.id);
          const childCount = poolChildren.get(node.id)?.size ?? 0;

          const grad = ctx.createRadialGradient(x - r * 0.25, y - r * 0.25, 0, x, y, r);
          grad.addColorStop(0, lightenColor(fillColor, 40));
          grad.addColorStop(1, fillColor);

          if (isHovered) {
            ctx.shadowColor = fillColor;
            ctx.shadowBlur = 16;
          }

          // Subtle outer ring
          ctx.beginPath();
          ctx.arc(x, y, r * 1.15, 0, 2 * Math.PI);
          ctx.strokeStyle = `${fillColor}40`;
          ctx.lineWidth = 1;
          ctx.stroke();

          // Main circle
          ctx.beginPath();
          ctx.arc(x, y, r, 0, 2 * Math.PI);
          ctx.fillStyle = grad;
          ctx.fill();

          // Universal outer ring
          ctx.beginPath();
          ctx.arc(x, y, r, 0, 2 * Math.PI);
          ctx.strokeStyle = "rgba(255,255,255,0.15)";
          ctx.lineWidth = 1;
          ctx.stroke();

          // "+N" or "-" count inside
          ctx.shadowColor = "transparent";
          ctx.shadowBlur = 0;
          if (childCount > 0) {
            const innerSize = Math.max(r * 0.7, 3);
            ctx.font = `bold ${innerSize}px 'IBM Plex Mono', monospace`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillStyle = "rgba(255,255,255,0.75)";
            ctx.fillText(isExpanded ? "-" : `+${childCount}`, x, y + 0.5);
          }

          // expand/collapse badge indicator
          if (childCount > 0) {
            const badgeR = Math.max(4, r * 0.45);
            ctx.beginPath();
            ctx.arc(x + r * 0.85, y - r * 0.85, badgeR, 0, 2 * Math.PI);
            ctx.fillStyle = isExpanded ? "#22c55e" : "#94a3b8";
            ctx.fill();
            ctx.fillStyle = "#0a1f2a";
            ctx.font = `bold ${badgeR * 1.2}px sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(isExpanded ? "\u2212" : String(childCount), x + r * 0.85, y - r * 0.85);
          }
          break;
        }
        case "position": {
          // Circle with "$" inside, pulsing ring if live
          const isLive = node.data.live === true || node.data.in_range === true;
          if (isLive) {
            const pulseAlpha =
              0.15 + 0.15 * Math.sin(frameRef.current / 400);
            ctx.beginPath();
            ctx.arc(x, y, r * 1.6, 0, 2 * Math.PI);
            ctx.fillStyle = `rgba(110,231,183,${pulseAlpha})`;
            ctx.fill();
          }

          if (isHovered) {
            ctx.shadowColor = fillColor;
            ctx.shadowBlur = 16;
          }

          // Main circle with gradient
          const grad = ctx.createRadialGradient(x - r * 0.2, y - r * 0.2, 0, x, y, r);
          grad.addColorStop(0, lightenColor(fillColor, 50));
          grad.addColorStop(1, fillColor);

          ctx.beginPath();
          ctx.arc(x, y, r, 0, 2 * Math.PI);
          ctx.fillStyle = grad;
          ctx.fill();

          // Universal outer ring
          ctx.beginPath();
          ctx.arc(x, y, r, 0, 2 * Math.PI);
          ctx.strokeStyle = "rgba(255,255,255,0.15)";
          ctx.lineWidth = 1;
          ctx.stroke();

          // "$" symbol inside
          ctx.shadowColor = "transparent";
          ctx.shadowBlur = 0;
          const dollarSize = Math.max(r * 0.75, 3);
          ctx.font = `bold ${dollarSize}px 'IBM Plex Mono', monospace`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = "rgba(255,255,255,0.6)";
          ctx.fillText("$", x, y + 0.5);
          break;
        }
        case "strategy": {
          // Circle with "S" inside
          if (isHovered) {
            ctx.shadowColor = fillColor;
            ctx.shadowBlur = 16;
          }

          const grad = ctx.createRadialGradient(x - r * 0.2, y - r * 0.2, 0, x, y, r);
          grad.addColorStop(0, lightenColor(fillColor, 30));
          grad.addColorStop(1, fillColor);

          ctx.beginPath();
          ctx.arc(x, y, r, 0, 2 * Math.PI);
          ctx.fillStyle = grad;
          ctx.fill();

          // Universal outer ring
          ctx.beginPath();
          ctx.arc(x, y, r, 0, 2 * Math.PI);
          ctx.strokeStyle = "rgba(255,255,255,0.15)";
          ctx.lineWidth = 1;
          ctx.stroke();

          // "S" letter inside
          ctx.shadowColor = "transparent";
          ctx.shadowBlur = 0;
          const sSize = Math.max(r * 0.75, 3);
          ctx.font = `bold ${sSize}px 'IBM Plex Sans', sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = "rgba(255,255,255,0.55)";
          ctx.fillText("S", x, y + 0.5);
          break;
        }
        case "lesson": {
          // Circle with "L" inside
          if (isHovered) {
            ctx.shadowColor = fillColor;
            ctx.shadowBlur = 16;
          }

          const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
          grad.addColorStop(0, lightenColor(fillColor, 40));
          grad.addColorStop(1, fillColor);

          ctx.beginPath();
          ctx.arc(x, y, r, 0, 2 * Math.PI);
          ctx.fillStyle = grad;
          ctx.fill();

          // Universal outer ring
          ctx.beginPath();
          ctx.arc(x, y, r, 0, 2 * Math.PI);
          ctx.strokeStyle = "rgba(255,255,255,0.15)";
          ctx.lineWidth = 1;
          ctx.stroke();

          // "L" letter inside
          ctx.shadowColor = "transparent";
          ctx.shadowBlur = 0;
          const lSize = Math.max(r * 0.8, 3);
          ctx.font = `bold ${lSize}px 'IBM Plex Sans', sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = "rgba(255,255,255,0.55)";
          ctx.fillText("L", x, y + 0.5);
          break;
        }
        case "pattern": {
          // Circle with "P" inside
          if (isHovered) {
            ctx.shadowColor = fillColor;
            ctx.shadowBlur = 16;
          }

          const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
          grad.addColorStop(0, lightenColor(fillColor, 40));
          grad.addColorStop(1, fillColor);

          ctx.beginPath();
          ctx.arc(x, y, r, 0, 2 * Math.PI);
          ctx.fillStyle = grad;
          ctx.fill();

          // Universal outer ring
          ctx.beginPath();
          ctx.arc(x, y, r, 0, 2 * Math.PI);
          ctx.strokeStyle = "rgba(255,255,255,0.15)";
          ctx.lineWidth = 1;
          ctx.stroke();

          // "P" letter inside
          ctx.shadowColor = "transparent";
          ctx.shadowBlur = 0;
          const pSize = Math.max(r * 0.7, 3);
          ctx.font = `bold ${pSize}px 'IBM Plex Sans', sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = "rgba(255,255,255,0.55)";
          ctx.fillText("P", x, y + 0.2);
          break;
        }
      }

      // Reset shadow for label drawing
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;

      // Label below shape -- only show for pool/wallet always, others only on hover
      const showLabel = node.type === "pool" || node.type === "wallet" || isHovered;
      if (showLabel) {
        const fontSize = Math.max(10 / globalScale, 2);
        ctx.font = `500 ${fontSize}px 'IBM Plex Sans', sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.shadowColor = "rgba(0,0,0,0.9)";
        ctx.shadowBlur = 4;
        ctx.fillStyle = isHovered ? "#ffffff" : "rgba(239,246,224,0.85)";
        const maxLen = node.type === "pool" || node.type === "wallet" ? 16 : 14;
        const truncLabel = node.label.length > maxLen ? node.label.slice(0, maxLen) + "\u2026" : node.label;
        ctx.fillText(truncLabel, x, y + r * 1.5 + 2);
        ctx.shadowBlur = 0;
      }

      // hover tooltip
      if (isHovered && node.data) {
        const stats = getNodeStats(node);
        if (stats.length > 0) {
          const fontSize = Math.max(10 / globalScale, 2);
          const lineHeight = fontSize * 1.3;
          const tipY = y + r * 1.5 + 2 + (showLabel ? fontSize + 6 : 4);
          const padding = 8 / globalScale;
          const boxW =
            Math.max(...stats.map((s) => ctx.measureText(s).width)) +
            padding * 2;
          const boxH = stats.length * lineHeight + padding * 2;
          const cornerRadius = 4 / globalScale;

          ctx.fillStyle = "rgba(0,0,0,0.85)";
          ctx.strokeStyle = "rgba(255,255,255,0.1)";
          ctx.lineWidth = 0.8 / globalScale;
          ctx.shadowColor = "rgba(0,0,0,0.5)";
          ctx.shadowBlur = 8;
          ctx.beginPath();
          ctx.roundRect(
            x - boxW / 2,
            tipY,
            boxW,
            boxH,
            cornerRadius,
          );
          ctx.fill();
          ctx.stroke();
          ctx.shadowBlur = 0;

          ctx.fillStyle = "rgba(200,220,200,0.92)";
          ctx.textAlign = "left";
          stats.forEach((line, i) => {
            ctx.fillText(
              line,
              x - boxW / 2 + padding,
              tipY + padding + i * lineHeight,
            );
          });
        }
      }

      ctx.restore();
    },
    [hoveredNode, dimmedIds, expandedPools, poolChildren],
  );

  /* ---------- pointer area ---------- */
  const drawNodeArea = useCallback(
    (
      node: GNode,
      color: string,
      ctx: CanvasRenderingContext2D,
    ) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const r = Math.max((node.size ?? 4) * 2.0, 16);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
    },
    [],
  );

  /* ---------- link accessors ---------- */
  const linkColor = useCallback(
    (_link: GLink) => {
      return "rgba(255,255,255,0.08)";
    },
    [],
  );
  const linkWidth = useCallback(
    (link: GLink) => ((link as GraphLink).style === "thin" ? 0.3 : 0.8),
    [],
  );
  const linkLineDash = useCallback(
    (link: GLink) =>
      (link as GraphLink).style === "dashed" ? [4, 4] : null,
    [],
  );

  /* ---------- directional arrows for solid links ---------- */
  const linkDirectionalArrowLength = useCallback(
    (link: GLink) => ((link as GraphLink).style === "solid" ? 4 : 0),
    [],
  );
  const linkDirectionalArrowRelPos = useCallback(() => 0.75, []);

  /* ---------- early return when closed ---------- */
  if (!open && !visible) return null;

  const activeFilterCount = NODE_TYPES.filter((t) => activeFilters.has(t)).length;

  return (
    <TooltipProvider>
      <div
        className={`fixed inset-0 z-100 flex flex-col transition-opacity duration-200 ${
          visible ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        style={{
          background:
            "linear-gradient(180deg, rgb(5,32,42) 0%, rgb(1,22,30) 100%)",
        }}
      >
        {/* ---- Header ---- */}
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-white/8 px-4">
          {/* Title */}
          <div className="flex items-center gap-2 text-cream">
            <Network size={16} className="text-teal" />
            <span className="font-semibold text-sm tracking-wide">
              Mind Map
            </span>
          </div>

          {/* Filter toggles */}
          <div className="ml-4 flex items-center gap-1">
            <Filter size={13} className="text-ash/40 mr-1" />
            {NODE_TYPES.map((type) => {
              const meta = TYPE_META[type];
              const active = activeFilters.has(type);
              const Icon = TYPE_ICONS[type];
              return (
                <Button
                  key={type}
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleFilter(type)}
                  className={`h-7 gap-1.5 rounded-full px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-all duration-150 ${
                    active
                      ? "text-cream/90 ring-1 ring-inset ring-white/15"
                      : "text-ash/30 ring-0"
                  }`}
                  style={{
                    backgroundColor: active
                      ? `${meta.color}18`
                      : "transparent",
                  }}
                >
                  <Icon
                    size={11}
                    style={{ color: active ? meta.color : "#666" }}
                  />
                  {meta.label}
                </Button>
              );
            })}
            {activeFilterCount < NODE_TYPES.length && (
              <Badge
                variant="outline"
                className="ml-1 h-5 border-steel/30 text-[9px] text-ash/60"
              >
                {activeFilterCount}/{NODE_TYPES.length}
              </Badge>
            )}
          </div>

          {/* Search */}
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search
                size={13}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ash/40 pointer-events-none"
              />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search nodes..."
                className="h-7 w-48 rounded-xl border border-steel/20 bg-white/4 pl-7 pr-3 font-mono text-[11px] text-cream/80 placeholder:text-ash/30 outline-none focus:border-teal/50 focus:ring-1 focus:ring-teal/20 transition-all"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-ash/40 hover:text-cream transition-colors"
                >
                  <X size={11} />
                </button>
              )}
            </div>

            {/* Time range */}
            <div className="flex items-center rounded-xl border border-steel/20 overflow-hidden">
              {(["24h", "7d", "all"] as TimeRange[]).map((t) => (
                <Button
                  key={t}
                  variant="ghost"
                  size="sm"
                  onClick={() => setTimeRange(t)}
                  className={`h-7 rounded-none px-3 py-1 font-mono text-[10px] uppercase tracking-wider ${
                    timeRange === t
                      ? "bg-teal/30 text-cream shadow-inner"
                      : "text-ash/40 hover:text-ash/70 hover:bg-white/4"
                  }`}
                >
                  <Clock size={10} className={timeRange === t ? "text-teal" : "text-ash/30"} />
                  {t}
                </Button>
              ))}
            </div>

            {/* Close */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleClose}
                  className="ml-1 h-7 w-7 rounded-lg p-0 text-ash/60 hover:text-cream"
                >
                  <X size={16} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <span className="text-xs">Close mind map</span>
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* ---- Global Insights Bar ---- */}
        {globalInsights.length > 0 && (
          <div className="shrink-0 border-b border-white/8">
            <div className="flex items-center gap-2 px-4 h-8">
              <button
                onClick={() => setInsightsExpanded(!insightsExpanded)}
                className="flex items-center gap-1 shrink-0 text-ash/50 hover:text-ash/80 transition-colors"
              >
                {insightsExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                <span className="font-mono text-[9px] uppercase tracking-wider">
                  Insights ({globalInsights.length})
                </span>
              </button>
              {insightsExpanded && (
                <div className="flex-1 overflow-x-auto overflow-y-hidden flex items-center gap-1.5 scrollbar-none">
                  {globalInsights.map((insight, i) => (
                    <span
                      key={i}
                      className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[9px] leading-tight ${
                        insight.type === "warning"
                          ? "bg-red-500/15 text-red-300/90 border border-red-500/20"
                          : insight.type === "opportunity"
                          ? "bg-emerald-500/15 text-emerald-300/90 border border-emerald-500/20"
                          : "bg-steel/15 text-ash/70 border border-steel/20"
                      }`}
                    >
                      {insight.type === "warning" && <AlertTriangle size={9} />}
                      {insight.type === "opportunity" && <Lightbulb size={9} />}
                      {insight.type === "info" && <Info size={9} />}
                      {insight.text}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ---- Body ---- */}
        <div ref={containerRef} className="relative flex-1 overflow-hidden">
          {/* Loading */}
          {loading && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4">
              <div className="relative flex items-center justify-center">
                {/* Outer pulsing ring */}
                <div className="absolute h-14 w-14 animate-ping rounded-full border border-teal/20" />
                {/* Middle spinning ring */}
                <div className="h-10 w-10 animate-spin rounded-full border-2 border-teal/20 border-t-teal" />
                {/* Center dot */}
                <div className="absolute h-2 w-2 rounded-full bg-teal animate-pulse" />
              </div>
              <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-ash/50 animate-pulse">
                Building knowledge graph...
              </span>
            </div>
          )}

          {/* Error */}
          {error && !loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center">
              <Card className="max-w-sm border-red-400/20">
                <CardContent className="p-6 text-center">
                  <div className="mb-3 text-red-400/80 text-lg">!</div>
                  <div className="text-sm text-red-400/90">{error}</div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleClose}
                    className="mt-4 text-ash/60"
                  >
                    Dismiss
                  </Button>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Graph */}
          {graphData && !loading && !error && (
            <div className="absolute inset-0">
              <ForceGraph2D
                ref={graphRef}
                graphData={filteredData}
                nodeCanvasObject={drawNode}
                nodePointerAreaPaint={drawNodeArea}
                linkColor={linkColor}
                linkWidth={linkWidth}
                linkLineDash={linkLineDash}
                linkDirectionalArrowLength={linkDirectionalArrowLength}
                linkDirectionalArrowRelPos={linkDirectionalArrowRelPos}
                linkDirectionalArrowColor={linkColor}
                onNodeClick={handleNodeClick}
                onNodeHover={handleNodeHover}
                onNodeDragEnd={handleNodeDragEnd}
                autoPauseRedraw={false}
                cooldownTime={3000}
                d3AlphaDecay={0.03}
                d3VelocityDecay={0.25}
                backgroundColor="rgba(0,0,0,0)"
                width={canvasWidth}
                height={canvasHeight}
              />
            </div>
          )}


          {/* ---- Legend ---- */}
          <Card className="absolute bottom-4 left-4 z-20 !rounded-xl !bg-ink/85 !border-white/8 !shadow-lg backdrop-blur-md">
            <CardHeader className="!px-3 !py-2 !pb-1">
              <CardTitle className="!text-[9px] text-ash/50">Legend</CardTitle>
            </CardHeader>
            <CardContent className="!px-3 !py-0 !pb-2.5">
              <div className="flex flex-col gap-1.5">
                {(
                  Object.entries(TYPE_META) as [
                    GraphNode["type"],
                    { label: string; color: string },
                  ][]
                ).map(([type, meta]) => {
                  const Icon = TYPE_ICONS[type];
                  return (
                    <div
                      key={type}
                      className="flex items-center gap-2 text-[10px] text-cream/70"
                    >
                      <LegendShape type={type} color={meta.color} />
                      <Icon size={10} style={{ color: meta.color, opacity: 0.7 }} />
                      <span>{meta.label}</span>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* ---- Detail Panel ---- */}
          <Card
            className={`absolute right-0 top-0 bottom-0 z-20 w-[300px] !rounded-none !rounded-l-2xl !border-r-0 !border-white/10 transition-transform duration-200 ${
              selectedNode ? "translate-x-0" : "translate-x-full"
            }`}
            style={{
              background:
                "linear-gradient(180deg, rgba(18,69,89,0.92), rgba(9,43,56,0.92))",
              backdropFilter: "blur(16px)",
            }}
          >
            {selectedNode && (
              <div className="flex h-full flex-col">
                {/* Panel header */}
                <div className="flex items-center justify-between border-b border-white/8 px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    {(() => {
                      const Icon = TYPE_ICONS[selectedNode.type as GraphNode["type"]];
                      const meta = TYPE_META[selectedNode.type as GraphNode["type"]];
                      return Icon ? (
                        <div
                          className="flex h-6 w-6 items-center justify-center rounded-md"
                          style={{ backgroundColor: `${meta?.color ?? "#598392"}20` }}
                        >
                          <Icon size={13} style={{ color: meta?.color ?? "#598392" }} />
                        </div>
                      ) : (
                        <span
                          className="h-2.5 w-2.5 rounded-full"
                          style={{
                            backgroundColor: meta?.color ?? "#598392",
                          }}
                        />
                      );
                    })()}
                    <span className="font-mono text-[10px] uppercase tracking-wider text-ash/70">
                      {selectedNode.type}
                    </span>
                  </div>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelectedNode(null)}
                        className="h-7 w-7 rounded-lg p-0 text-ash/60 hover:text-cream"
                      >
                        <X size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      <span className="text-xs">Close panel (Esc)</span>
                    </TooltipContent>
                  </Tooltip>
                </div>

                {/* Panel body */}
                <ScrollArea className="flex-1">
                  <div className="px-4 py-3">
                    <h3 className="mb-1 text-sm font-semibold text-cream leading-snug">
                      {selectedNode.label}
                    </h3>
                    <span className="font-mono text-[9px] text-ash/40">
                      {selectedNode.id !== selectedNode.label ? truncAddr(str(selectedNode.id)) : ""}
                    </span>
                    <Separator className="my-3" />
                    <NodeDetail node={selectedNode} />
                  </div>
                </ScrollArea>
              </div>
            )}
          </Card>
        </div>
      </div>
    </TooltipProvider>
  );
}

/* ------------------------------------------------------------------ */
/*  Color utility for gradients                                        */
/* ------------------------------------------------------------------ */

function lightenColor(hex: string, amount: number): string {
  const h = hex.replace("#", "");
  const num = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  const r = Math.min(255, ((num >> 16) & 0xff) + amount);
  const g = Math.min(255, ((num >> 8) & 0xff) + amount);
  const b = Math.min(255, (num & 0xff) + amount);
  return `rgb(${r},${g},${b})`;
}

/* ------------------------------------------------------------------ */
/*  Legend shape mini-component                                         */
/* ------------------------------------------------------------------ */

function LegendShape({
  type,
  color,
}: {
  type: GraphNode["type"];
  color: string;
}) {
  const size = 10;
  const half = size / 2;
  const letters: Record<GraphNode["type"], string> = {
    wallet: "W",
    pool: "+",
    position: "$",
    strategy: "S",
    lesson: "L",
    pattern: "P",
  };

  return (
    <svg width={size} height={size}>
      <circle cx={half} cy={half} r={half - 0.5} fill={color} />
      <text
        x={half}
        y={half}
        textAnchor="middle"
        dominantBaseline="central"
        fill="rgba(255,255,255,0.7)"
        fontSize="6"
        fontWeight="bold"
        fontFamily="IBM Plex Sans, sans-serif"
      >
        {letters[type]}
      </text>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Node detail renderers                                              */
/* ------------------------------------------------------------------ */

function NodeDetail({ node }: { node: GNode }) {
  const d = (node.data ?? {}) as Record<string, unknown>;

  switch (node.type as GraphNode["type"]) {
    case "pool":
      return (
        <div className="flex flex-col gap-0">
          {Array.isArray(d.insights) && (d.insights as {type: string; text: string}[]).length > 0 && (
            <>
              <div className="flex flex-col gap-1.5 mb-1">
                {(d.insights as {type: string; text: string}[]).map((ins, i) => (
                  <div
                    key={i}
                    className={`flex items-start gap-2 rounded-lg px-2.5 py-2 text-[10px] leading-relaxed border-l-2 ${
                      ins.type === "warning"
                        ? "border-l-red-400 bg-red-500/8 text-red-300/90"
                        : ins.type === "opportunity"
                        ? "border-l-emerald-400 bg-emerald-500/8 text-emerald-300/90"
                        : "border-l-steel bg-steel/8 text-ash/70"
                    }`}
                  >
                    {ins.type === "warning" && <AlertTriangle size={12} className="shrink-0 mt-0.5" />}
                    {ins.type === "opportunity" && <Lightbulb size={12} className="shrink-0 mt-0.5" />}
                    {ins.type === "info" && <Info size={12} className="shrink-0 mt-0.5" />}
                    <span>{ins.text}</span>
                  </div>
                ))}
              </div>
              <Separator className="my-2.5" />
            </>
          )}
          <DetailSection title="Performance">
            <DetailRow label="Total Deploys" value={str(d.total_deploys)} />
            <DetailRow label="Win Rate" value={fmtPct(d.win_rate)} />
            <DetailRow label="Avg PnL %" value={fmtPct(d.avg_pnl_pct)} />
          </DetailSection>
          <Separator className="my-2.5" />
          <DetailSection title="Recent Activity">
            <DetailRow label="Last Outcome" value={str(d.last_outcome)} />
            <DetailRow label="Last Deploy" value={fmtRelativeTime(d.last_deployed_at)} />
          </DetailSection>
          {Array.isArray(d.notes) && d.notes.length > 0 && (
            <>
              <Separator className="my-2.5" />
              <DetailSection title="Notes">
                <div className="flex flex-col gap-1.5">
                  {(d.notes as string[]).map((note, i) => (
                    <div key={i} className="rounded-lg border border-white/5 bg-white/4 px-2.5 py-2 font-mono text-[10px] text-cream/70 leading-relaxed">
                      {note}
                    </div>
                  ))}
                </div>
              </DetailSection>
            </>
          )}
        </div>
      );

    case "position":
      return (
        <div className="flex flex-col gap-0">
          <DetailSection title="Position Info">
            <DetailRow label="Pool" value={str(d.pool_name)} />
            <DetailRow label="Strategy" value={str(d.strategy)} />
            <DetailRow label="Amount" value={fmtSol(d.amount_sol)} />
          </DetailSection>
          <Separator className="my-2.5" />
          <DetailSection title="Performance">
            <DetailRow label="PnL %" value={fmtPct(d.pnl_pct)} />
            <DetailRow label="Peak PnL %" value={fmtPct(d.peak_pnl_pct)} />
            <DetailRow label="Unclaimed Fees" value={fmtSol(d.unclaimed_fees_sol)} />
          </DetailSection>
          <Separator className="my-2.5" />
          <DetailSection title="Status">
            <DetailRow label="Status" value={d.live ? "Live" : d.closed ? "Closed" : "--"} />
            <DetailRow label="In Range" value={d.in_range === true ? "Yes" : d.in_range === false ? "No" : "--"} />
            <DetailRow label="Deployed" value={fmtRelativeTime(d.deployed_at)} />
          </DetailSection>
        </div>
      );

    case "strategy":
      return (
        <div className="flex flex-col gap-0">
          {Array.isArray(d.insights) && (d.insights as {type: string; text: string}[]).length > 0 && (
            <>
              <div className="flex flex-col gap-1.5 mb-1">
                {(d.insights as {type: string; text: string}[]).map((ins, i) => (
                  <div
                    key={i}
                    className={`flex items-start gap-2 rounded-lg px-2.5 py-2 text-[10px] leading-relaxed border-l-2 ${
                      ins.type === "warning"
                        ? "border-l-red-400 bg-red-500/8 text-red-300/90"
                        : ins.type === "opportunity"
                        ? "border-l-emerald-400 bg-emerald-500/8 text-emerald-300/90"
                        : "border-l-steel bg-steel/8 text-ash/70"
                    }`}
                  >
                    {ins.type === "warning" && <AlertTriangle size={12} className="shrink-0 mt-0.5" />}
                    {ins.type === "opportunity" && <Lightbulb size={12} className="shrink-0 mt-0.5" />}
                    {ins.type === "info" && <Info size={12} className="shrink-0 mt-0.5" />}
                    <span>{ins.text}</span>
                  </div>
                ))}
              </div>
              <Separator className="my-2.5" />
            </>
          )}
          <DetailSection title="Details">
            <DetailRow label="Key" value={str(d.key ?? d.name)} />
            <DetailRow label="Value" value={str(d.value ?? d.description)} />
          </DetailSection>
          <Separator className="my-2.5" />
          <DetailSection title="Usage">
            <DetailRow label="Hit Count" value={str(d.hit_count ?? d.hits)} />
            <DetailRow
              label="Last Hit"
              value={fmtRelativeTime(d.last_hit_session ?? d.lastHit)}
            />
          </DetailSection>
        </div>
      );

    case "lesson":
      return (
        <div className="flex flex-col gap-0">
          <DetailSection title="Rule">
            <div className="rounded-lg border border-white/6 bg-white/4 px-3 py-2.5 text-[11px] text-cream/80 leading-relaxed">
              {str(d.rule)}
            </div>
          </DetailSection>
          {Array.isArray(d.tags) && d.tags.length > 0 && (
            <>
              <Separator className="my-2.5" />
              <DetailSection title="Tags">
                <div className="flex flex-wrap gap-1.5">
                  {(d.tags as string[]).map((tag, i) => (
                    <Badge
                      key={i}
                      variant="outline"
                      className="border-steel/30 text-[9px] text-ash/70"
                    >
                      {tag}
                    </Badge>
                  ))}
                </div>
              </DetailSection>
            </>
          )}
          <Separator className="my-2.5" />
          <DetailSection title="Metadata">
            <DetailRow label="Outcome" value={str(d.outcome)} />
            <DetailRow label="Created" value={fmtRelativeTime(d.created_at)} />
          </DetailSection>
        </div>
      );

    case "pattern":
      return (
        <div className="flex flex-col gap-0">
          <DetailSection title="Details">
            <DetailRow label="Key" value={str(d.key ?? d.name)} />
            <DetailRow label="Value" value={str(d.value ?? d.description)} />
            <DetailRow label="Hit Count" value={str(d.hit_count ?? d.hits)} />
          </DetailSection>
        </div>
      );

    case "wallet":
      return (
        <div className="flex flex-col gap-0">
          <DetailSection title="Balance">
            <DetailRow label="SOL Balance" value={fmtSol(d.sol)} />
            <DetailRow label="USD Value" value={fmtUsd(d.sol_usd)} />
          </DetailSection>
          <Separator className="my-2.5" />
          <DetailSection title="Market">
            <DetailRow label="SOL Price" value={fmtUsd(d.sol_price)} />
          </DetailSection>
        </div>
      );

    default:
      return (
        <pre className="whitespace-pre-wrap break-words font-mono text-[10px] text-cream/60">
          {JSON.stringify(d, null, 2)}
        </pre>
      );
  }
}

/* ------------------------------------------------------------------ */
/*  Detail section wrapper                                             */
/* ------------------------------------------------------------------ */

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <ChevronRight size={10} className="text-ash/30" />
        <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-ash/50">
          {title}
        </span>
      </div>
      <div className="flex flex-col gap-2 pl-4">
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Detail row                                                         */
/* ------------------------------------------------------------------ */

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  if (!value || value === "--") return null;
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-ash/50">
        {label}
      </span>
      <span className="text-right text-[11px] text-cream/85 break-all leading-snug">
        {value}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function getNodeStats(node: GNode): string[] {
  const d = node.data ?? {};
  const lines: string[] = [];
  const type = node.type as GraphNode["type"];

  if (type === "pool") {
    if (d.win_rate != null) lines.push(`Win: ${fmtPct(d.win_rate)}`);
    if (d.total_deploys != null) lines.push(`Deploys: ${d.total_deploys}`);
    if (d.avg_pnl_pct != null) lines.push(`Avg PnL: ${fmtPct(d.avg_pnl_pct)}`);
  } else if (type === "position") {
    if (d.pnl_pct != null) lines.push(`PnL: ${fmtPct(d.pnl_pct)}`);
    if (d.strategy) lines.push(`Strat: ${d.strategy}`);
  } else if (type === "strategy") {
    if (d.hits != null) lines.push(`Hits: ${d.hits}`);
  } else if (type === "lesson") {
    if (d.outcome) lines.push(`Outcome: ${d.outcome}`);
  } else if (type === "pattern") {
    if (d.hits != null) lines.push(`Hits: ${d.hits}`);
  } else if (type === "wallet") {
    if (d.sol != null) lines.push(`SOL: ${fmtSol(d.sol)}`);
  }

  return lines;
}

function str(v: unknown): string {
  if (v == null) return "--";
  return String(v);
}

function truncAddr(addr: string): string {
  if (!addr || addr === "--" || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function fmtPct(v: unknown): string {
  if (v == null) return "--";
  const n = Number(v);
  return isNaN(n) ? String(v) : `${n.toFixed(1)}%`;
}

function fmtSol(v: unknown): string {
  if (v == null) return "--";
  const n = Number(v);
  return isNaN(n) ? String(v) : `${n.toFixed(4)} SOL`;
}

function fmtUsd(v: unknown): string {
  if (v == null) return "--";
  const n = Number(v);
  return isNaN(n)
    ? String(v)
    : `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
