import { useState, useRef, useEffect } from "react";
import { Send } from "lucide-react";
import type { ChatMessage, StatusInfo } from "../hooks/useWebSocket";

const COMMANDS = [
  { label: "/status", desc: "Wallet & positions" },
  { label: "/briefing", desc: "Morning briefing (last 24h)" },
  { label: "/candidates", desc: "Top pool picks" },
  { label: "/thresholds", desc: "Screening thresholds + stats" },
  { label: "/learn", desc: "Study top LPers & save lessons" },
  { label: "/evolve", desc: "Evolve thresholds from performance" },
  { label: "/auto", desc: "Agent picks & deploys automatically" },
];

const SUGGESTIONS = [
  ...COMMANDS,
  { label: "1", desc: "Deploy into pool #1" },
  { label: "Show my positions", desc: null },
  { label: "What pools look good?", desc: null },
];

interface ChatPanelProps {
  messages: ChatMessage[];
  status: StatusInfo;
  onSend: (text: string) => void;
}

export default function ChatPanel({ messages, status, onSend }: ChatPanelProps) {
  const [input, setInput] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Filter commands when input starts with "/" or matches "auto"
  const showAutocomplete = input.startsWith("/") && input.length < 20;
  const filtered = showAutocomplete
    ? COMMANDS.filter((c) => c.label.toLowerCase().startsWith(input.toLowerCase()))
    : [];

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIdx(0);
  }, [input]);

  const pickCommand = (label: string) => {
    onSend(label);
    setInput("");
    inputRef.current?.focus();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // If autocomplete is open and user presses Enter, pick the selected command
    if (filtered.length > 0) {
      pickCommand(filtered[selectedIdx].label);
      return;
    }
    const text = input.trim();
    if (!text) return;
    onSend(text);
    setInput("");
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (filtered.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Tab") {
      e.preventDefault();
      setInput(filtered[selectedIdx].label);
    } else if (e.key === "Escape") {
      setInput("");
    }
  };

  const isBusy = status.busy || status.managementBusy || status.screeningBusy;

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-6 text-center">
            <div>
              <h2 className="text-xl font-semibold text-zinc-200">DLMM Agent</h2>
              <p className="text-sm text-zinc-500 mt-1">Ask anything about your positions, pools, or strategies</p>
            </div>
            <div className="flex flex-wrap gap-2 justify-center max-w-lg">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.label}
                  onClick={() => onSend(s.label)}
                  className="px-3 py-1.5 text-sm rounded-lg border border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors flex items-center gap-1.5"
                >
                  <span className={s.label.startsWith("/") ? "font-mono text-emerald-400/80" : ""}>{s.label}</span>
                  {s.desc && <span className="text-zinc-600 text-xs">— {s.desc}</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                msg.role === "user"
                  ? "bg-emerald-700/30 text-emerald-100 border border-emerald-700/40"
                  : "bg-zinc-800/60 text-zinc-200 border border-zinc-700/40"
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}

        {isBusy && (
          <div className="flex justify-start">
            <div className="bg-zinc-800/60 border border-zinc-700/40 rounded-xl px-4 py-2.5 text-sm text-zinc-400">
              <span className="inline-flex gap-1">
                <span className="animate-bounce" style={{ animationDelay: "0ms" }}>.</span>
                <span className="animate-bounce" style={{ animationDelay: "150ms" }}>.</span>
                <span className="animate-bounce" style={{ animationDelay: "300ms" }}>.</span>
              </span>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-zinc-800 p-4 relative">
        {/* Command autocomplete dropdown */}
        {filtered.length > 0 && (
          <div className="absolute bottom-full left-4 right-4 mb-1 bg-zinc-900 border border-zinc-700 rounded-lg overflow-hidden shadow-xl">
            {filtered.map((cmd, i) => (
              <button
                key={cmd.label}
                onClick={() => pickCommand(cmd.label)}
                onMouseEnter={() => setSelectedIdx(i)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left transition-colors ${
                  i === selectedIdx ? "bg-zinc-800" : "hover:bg-zinc-800/50"
                }`}
              >
                <span className="font-mono text-emerald-400">{cmd.label}</span>
                <span className="text-zinc-500 text-xs">{cmd.desc}</span>
              </button>
            ))}
            <div className="px-4 py-1.5 text-[10px] text-zinc-600 border-t border-zinc-800">
              <kbd className="px-1 py-0.5 bg-zinc-800 rounded text-zinc-500">↑↓</kbd> navigate
              <span className="mx-2">·</span>
              <kbd className="px-1 py-0.5 bg-zinc-800 rounded text-zinc-500">Tab</kbd> complete
              <span className="mx-2">·</span>
              <kbd className="px-1 py-0.5 bg-zinc-800 rounded text-zinc-500">Enter</kbd> send
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isBusy ? "Agent is working..." : "Ask the agent... (type / for commands)"}
              disabled={isBusy}
              className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-emerald-600 focus:border-emerald-600 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={isBusy || !input.trim()}
              className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 disabled:hover:bg-emerald-700 text-white rounded-lg px-4 py-2.5 transition-colors"
            >
              <Send size={16} />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
