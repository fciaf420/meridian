import { useEffect, useMemo, useRef, useState } from "react";
import { Send } from "lucide-react";
import type { CandidateData, ChatMessage, PositionData, StatusInfo, TimerInfo } from "../hooks/useWebSocket";
import { SUGGESTIONS } from "@/lib/commands";
import { Button } from "@/components/ui/button";
// ScrollArea replaced with native overflow-y-auto div for reliable scrolling

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
  timers: TimerInfo;
  positions: PositionData | null;
  candidates: CandidateData | null;
  onSend: (text: string) => void;
  onOpenCommandPalette: () => void;
}

type PromptSuggestion = {
  label: string;
  desc: string | null;
  kicker?: string;
};

export default function ChatPanel({
  messages,
  status,
  timers,
  positions,
  candidates,
  onSend,
  onOpenCommandPalette,
}: ChatPanelProps) {
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
  const livePrompts = useMemo<PromptSuggestion[]>(() => {
    const dynamic: PromptSuggestion[] = [];
    const oorCount = positions?.positions.filter((position) => !position.in_range).length ?? 0;
    const openCount = positions?.total_positions ?? 0;
    const topCandidate = candidates?.candidates[0];

    if (oorCount > 0) {
      dynamic.push({
        label: "Show my positions",
        desc: `${oorCount} positions need attention`,
        kicker: "Risk",
      });
    }

    if (topCandidate) {
      dynamic.push({
        label: "1",
        desc: `Deploy into ${topCandidate.name || topCandidate.pool.slice(0, 8)}`,
        kicker: "Top ranked",
      });
      dynamic.push({
        label: `What makes ${topCandidate.name || "pool #1"} interesting?`,
        desc: "Ask for the strongest signal",
        kicker: "Idea",
      });
    } else if (timers.screening !== "--") {
      dynamic.push({
        label: "/candidates",
        desc: `Next screening window in ${timers.screening}`,
        kicker: "Scan",
      });
    }

    if (status.screeningBusy) {
      dynamic.push({
        label: "/candidates",
        desc: "Screening cycle is live right now",
        kicker: "Live",
      });
    }

    if (!openCount) {
      dynamic.push({
        label: "/auto",
        desc: "Let the agent manage first deploy selection",
        kicker: "Automation",
      });
    }

    if (!dynamic.length) {
      return SUGGESTIONS.slice(0, 4).map((suggestion) => ({
        label: suggestion.label,
        desc: suggestion.desc,
        kicker: suggestion.label.startsWith("/") ? "Command" : "Prompt",
      }));
    }

    return dynamic.slice(0, 4);
  }, [candidates, positions, status.screeningBusy, timers.screening]);

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-[radial-gradient(circle_at_top,rgba(89,131,146,0.14),transparent_68%)]" />
      <div className="pointer-events-none absolute left-8 top-16 hidden font-mono text-[88px] font-semibold uppercase tracking-[-0.06em] text-amber-200/[0.035] xl:block">
        CONTROL
      </div>

      {/* Messages — calc height: viewport minus statusbar(40px) minus input area(~80px) */}
      <div className="overflow-y-auto" style={{ maxHeight: "calc(100vh - 120px)" }}>
        <div className="space-y-4 p-4">
          {messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-6 pt-6 text-center xl:items-start xl:justify-start xl:px-12 xl:pt-18 xl:text-left">
              <div className="space-y-3">
                <div className="mx-auto w-fit rounded-full border border-amber-200/12 bg-amber-200/8 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-amber-200/72 xl:mx-0">
                  Agent Console
                </div>
                <div>
                  <h2 className="text-3xl font-semibold tracking-tight text-cream sm:text-4xl xl:max-w-2xl xl:text-5xl">
                    Command the book without leaving the dashboard.
                  </h2>
                  <p className="mt-3 max-w-xl text-sm text-ash/74 xl:text-base">
                    Ask about positions, pool quality, deployment ideas, or fire off the next move from one control surface.
                  </p>
                </div>
              </div>

              <div className="grid w-full max-w-3xl gap-3 xl:grid-cols-2">
                {livePrompts.map((prompt) => (
                  <Button
                    key={prompt.label}
                    onClick={() => onSend(prompt.label)}
                    variant="outline"
                    className="h-auto min-h-[88px] justify-start rounded-[24px] border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.01))] px-4 py-3 text-left normal-case tracking-normal text-ash hover:-translate-y-0.5 hover:border-amber-200/35 hover:bg-amber-200/8 hover:text-cream"
                  >
                    <span className="flex w-full flex-col items-start gap-2">
                      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-amber-200/60">
                        {prompt.kicker}
                      </span>
                      <span className={`text-sm ${prompt.label.startsWith("/") || /^\d+$/.test(prompt.label) ? "font-mono text-steel" : ""}`}>
                        {prompt.label}
                      </span>
                      {prompt.desc && <span className="text-xs text-ash/50">{prompt.desc}</span>}
                    </span>
                  </Button>
                ))}
              </div>

              <div className="flex max-w-2xl flex-wrap justify-center gap-2 xl:justify-start">
                {SUGGESTIONS.slice(0, 6).map((s) => (
                  <Button
                    key={s.label}
                    onClick={() => onSend(s.label)}
                    variant="outline"
                    className="h-auto rounded-full border-white/10 bg-white/3 px-3 py-2 text-left normal-case tracking-normal text-ash hover:border-amber-200/35 hover:bg-amber-200/8 hover:text-cream"
                  >
                    <span className={`text-sm ${s.label.startsWith("/") ? "font-mono text-steel" : ""}`}>{s.label}</span>
                    {s.desc && <span className="text-xs text-ash/48">{s.desc}</span>}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={`flex animate-fade-in-up ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm shadow-[0_14px_30px_rgba(0,0,0,0.18)] ${
                  msg.role === "user"
                    ? "border border-steel/30 bg-steel/14 text-cream"
                    : "border border-white/8 bg-[linear-gradient(180deg,rgba(18,69,89,0.42),rgba(7,36,46,0.72))] text-cream/92"
                }`}
              >
                {msg.role === "assistant" ? stripHtml(msg.content) : msg.content}
              </div>
            </div>
          ))}

          {isBusy && (
            <div className="flex justify-start animate-fade-in-up">
              <div className="flex items-center gap-2 rounded-2xl border border-white/8 bg-[linear-gradient(180deg,rgba(18,69,89,0.42),rgba(7,36,46,0.72))] px-4 py-3 text-sm">
                <span className="h-2 w-2 rounded-full bg-emerald-300 animate-subtle-glow" />
                <span className="font-mono text-xs text-emerald-200">Processing...</span>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-white/8 bg-[linear-gradient(180deg,rgba(2,24,33,0.64),rgba(0,15,20,0.88))] p-4">
        <form onSubmit={handleSubmit}>
          <div className="relative flex gap-2 rounded-2xl border border-white/8 bg-[linear-gradient(180deg,rgba(6,30,39,0.9),rgba(1,22,30,0.96))] p-2 shadow-[0_16px_34px_rgba(0,0,0,0.18)]">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder={isBusy ? "Type message — will queue until agent is free..." : "Ask the agent... (type / for commands)"}
              className="flex-1 rounded-xl border border-white/6 bg-ink/70 px-4 py-2.5 pr-18 text-sm text-cream placeholder-ash/42 focus:border-steel focus:outline-none focus:ring-1 focus:ring-steel"
            />
            <span className="pointer-events-none absolute right-18 top-1/2 -translate-y-1/2 font-mono text-[10px] text-ash/30">Ctrl+K</span>
            <Button
              type="submit"
              disabled={!input.trim()}
              className="px-4"
            >
              <Send size={16} />
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
