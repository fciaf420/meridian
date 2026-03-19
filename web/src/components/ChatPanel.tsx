import { useState, useRef, useEffect } from "react";
import { Send } from "lucide-react";
import type { ChatMessage, StatusInfo } from "../hooks/useWebSocket";
import { SUGGESTIONS } from "@/lib/commands";
import { ScrollArea } from "@/components/ui/scroll-area";

function stripHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?b>/gi, "")
    .replace(/<\/?i>/gi, "")
    .replace(/<\/?em>/gi, "")
    .replace(/<\/?strong>/gi, "")
    .replace(/<\/?code>/gi, "`")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

interface ChatPanelProps {
  messages: ChatMessage[];
  status: StatusInfo;
  onSend: (text: string) => void;
  onOpenCommandPalette: () => void;
}

export default function ChatPanel({ messages, status, onSend, onOpenCommandPalette }: ChatPanelProps) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (value === "/") {
      onOpenCommandPalette();
      setInput("");
      return;
    }
    setInput(value);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    onSend(text);
    setInput("");
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.key === "k") {
      e.preventDefault();
      onOpenCommandPalette();
    }
  };

  const isBusy = status.busy || status.managementBusy || status.screeningBusy;

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full gap-6 text-center">
              <div>
                <h2 className="text-xl font-semibold text-cream">DLMM Agent</h2>
                <p className="text-sm text-ash/60 mt-1">Ask anything about your positions, pools, or strategies</p>
              </div>
              <div className="flex flex-wrap gap-2 justify-center max-w-lg">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.label}
                    onClick={() => onSend(s.label)}
                    className="px-3 py-1.5 text-sm rounded-lg border border-teal/30 text-ash hover:text-cream hover:border-steel/40 transition-colors flex items-center gap-1.5"
                  >
                    <span className={s.label.startsWith("/") ? "font-mono text-steel" : ""}>{s.label}</span>
                    {s.desc && <span className="text-ash/40 text-xs">{s.desc}</span>}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={`flex animate-fade-in-up ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                  msg.role === "user"
                    ? "bg-steel/15 border border-steel/30 text-cream"
                    : "bg-teal/40 border border-steel/20 border-l-2 border-l-steel text-cream/90"
                }`}
              >
                {msg.role === "assistant" ? stripHtml(msg.content) : msg.content}
              </div>
            </div>
          ))}

          {isBusy && (
            <div className="flex justify-start animate-fade-in-up">
              <div className="bg-teal/40 border border-steel/20 border-l-2 border-l-steel rounded-xl px-4 py-2.5 text-sm flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-steel animate-subtle-glow" />
                <span className="font-mono text-steel text-xs">Processing...</span>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="border-t border-teal/30 p-4">
        <form onSubmit={handleSubmit}>
          <div className="relative flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder={isBusy ? "Type message — will queue until agent is free..." : "Ask the agent... (type / for commands)"}
              className="flex-1 bg-ink border border-teal/30 rounded-lg px-4 py-2.5 text-sm text-cream placeholder-ash/40 focus:outline-none focus:ring-1 focus:ring-steel focus:border-steel"
            />
            <span className="absolute right-16 top-1/2 -translate-y-1/2 text-[10px] text-ash/30 font-mono">Ctrl+K</span>
            <button
              type="submit"
              disabled={!input.trim()}
              className="bg-steel hover:bg-steel/80 disabled:opacity-40 text-ink rounded-lg px-4 py-2.5 transition-colors"
            >
              <Send size={16} />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
