import { useWebSocket } from "./hooks/useWebSocket";
import ChatPanel from "./components/ChatPanel";
import NotificationFeed from "./components/NotificationFeed";
import StatusBar from "./components/StatusBar";

export default function App() {
  const { connected, messages, notifications, status, timers, sendMessage } = useWebSocket();

  return (
    <div className="h-screen flex flex-col">
      <StatusBar connected={connected} status={status} timers={timers} />

      <div className="flex flex-1 overflow-hidden">
        {/* Chat panel */}
        <div className="flex-[65] border-r border-zinc-800 flex flex-col">
          <ChatPanel messages={messages} status={status} onSend={sendMessage} />
        </div>

        {/* Sidebar */}
        <div className="flex-[35] flex flex-col">
          <div className="px-4 py-2.5 border-b border-zinc-800 text-xs font-semibold text-zinc-400 uppercase tracking-wider">
            Notifications
          </div>
          <div className="flex-1 overflow-hidden">
            <NotificationFeed notifications={notifications} />
          </div>
        </div>
      </div>
    </div>
  );
}
