import { useCallback, useEffect, useRef, useState } from "react";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  ts?: string;
}

export interface Notification {
  id: string;
  event: string;
  data: Record<string, unknown>;
  ts: string;
}

export interface StatusInfo {
  busy: boolean;
  managementBusy: boolean;
  screeningBusy: boolean;
}

export interface TimerInfo {
  management: string;
  screening: string;
}

export interface PositionInfo {
  position: string;
  pair: string;
  pool: string;
  base_mint?: string | null;
  strategy?: "bid_ask" | "spot";
  in_range: boolean;
  active_bin: number;
  lower_bin: number;
  upper_bin: number;
  pnl_pct: number;
  pnl_sol?: number;
  pnl_usd?: number;
  unclaimed_fees_sol?: number;
  unclaimed_fees_usd?: number;
  age_minutes?: number;
}

export interface PositionData {
  total_positions: number;
  positions: PositionInfo[];
}

export interface WalletData {
  sol: number;
  sol_usd: number;
  sol_price: number;
  tokens?: Array<{ symbol: string; amount: number; usd: number }>;
}

export interface CandidateInfo {
  name: string;
  pool: string;
  fee_tvl_ratio?: number;
  fee_active_tvl_ratio?: number;
  volume?: number;
  volume_24h?: number;
  volume_window?: number;
  organic_score?: number;
  active_pct?: number;
  active_bin_pct?: number;
}

export interface CandidateData {
  candidates: CandidateInfo[];
  total_eligible: number;
  total_screened: number;
}

function isCandidateInfo(value: unknown): value is CandidateInfo {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.pool === "string";
}

function isCandidateData(value: unknown): value is CandidateData {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  return Array.isArray(payload.candidates)
    && payload.candidates.every(isCandidateInfo)
    && typeof payload.total_eligible === "number"
    && typeof payload.total_screened === "number";
}

export interface LpOverviewData {
  total_pnl: number;
  total_fees: number;
  win_rate_pct: number;
  closed_positions: number;
  open_positions: number;
  avg_hold_hours: number;
  roi_pct: number;
  pnl_unit: string;
  total_pnl_usd: number;
  total_pnl_sol: number;
  total_fees_usd: number;
  total_fees_sol: number;
  win_rate_usd_pct: number;
  win_rate_sol_pct: number;
  total_pools: number;
}

export interface QuickActionResult {
  action: string;
  data: unknown;
  error?: string;
}

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [status, setStatus] = useState<StatusInfo>({ busy: false, managementBusy: false, screeningBusy: false });
  const [timers, setTimers] = useState<TimerInfo>({ management: "--", screening: "--" });
  const [positions, setPositions] = useState<PositionData | null>(null);
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [candidates, setCandidates] = useState<CandidateData | null>(null);
  const [lpOverview, setLpOverview] = useState<LpOverviewData | null>(null);
  const [quickActionResult, setQuickActionResult] = useState<QuickActionResult | null>(null);

  const connect = useCallback(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      reconnectTimer.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        switch (msg.type) {
          case "init":
            if (msg.history) setMessages(msg.history);
            if (msg.status) setStatus(msg.status);
            if (msg.timers) setTimers(msg.timers);
            if (msg.positions) setPositions(msg.positions);
            if (msg.wallet) setWallet(msg.wallet);
            if (isCandidateData(msg.candidates)) setCandidates(msg.candidates);
            if (msg.lpOverview) setLpOverview(msg.lpOverview);
            break;
          case "chat:response":
            setMessages((prev) => [...prev, { role: "assistant", content: msg.text, ts: msg.ts }]);
            break;
          case "notification":
            setNotifications((prev) => [
              { id: crypto.randomUUID(), event: msg.event, data: msg.data, ts: msg.ts || new Date().toISOString() },
              ...prev,
            ].slice(0, 50));
            break;
          case "status":
            setStatus({ busy: msg.busy, managementBusy: msg.managementBusy, screeningBusy: msg.screeningBusy });
            break;
          case "timer":
            setTimers({ management: msg.management, screening: msg.screening });
            break;
          case "positions":
            if (msg.data) setPositions(msg.data);
            break;
          case "wallet":
            if (msg.data) setWallet(msg.data);
            break;
          case "candidates":
            if (isCandidateData(msg.data)) setCandidates(msg.data);
            break;
          case "quick-action:result":
            setQuickActionResult({ action: msg.action, data: msg.data });
            break;
          case "quick-action:error":
            setQuickActionResult({ action: msg.action, data: null, error: msg.error || "Unknown error" });
            break;
          case "error":
            setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${msg.text}`, ts: new Date().toISOString() }]);
            break;
        }
      } catch { /* ignore malformed messages */ }
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const sendMessage = useCallback((text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    setMessages((prev) => [...prev, { role: "user", content: text, ts: new Date().toISOString() }]);
    // Route slash commands, "auto", and bare numbers (pool picks) as commands
    const isCommand = text.startsWith("/") || text.toLowerCase() === "auto" || /^\d+$/.test(text.trim());
    if (isCommand) {
      const cmd = text.toLowerCase() === "auto" ? "/auto" : /^\d+$/.test(text.trim()) ? text.trim() : text;
      wsRef.current.send(JSON.stringify({ type: "command", command: cmd }));
    } else {
      wsRef.current.send(JSON.stringify({ type: "chat", text }));
    }
  }, []);

  const sendQuickAction = useCallback((action: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    setQuickActionResult(null);
    wsRef.current.send(JSON.stringify({ type: "quick-action", action }));
  }, []);

  const clearQuickActionResult = useCallback(() => {
    setQuickActionResult(null);
  }, []);

  return { connected, messages, notifications, status, timers, positions, wallet, candidates, lpOverview, sendMessage, sendQuickAction, quickActionResult, clearQuickActionResult };
}
