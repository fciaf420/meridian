import type { Notification } from "../hooks/useWebSocket";
import NotificationFeed from "./NotificationFeed";

interface ActivityTabProps {
  notifications: Notification[];
}

export default function ActivityTab({ notifications }: ActivityTabProps) {
  return <NotificationFeed notifications={notifications} />;
}
