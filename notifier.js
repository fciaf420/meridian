// notifier.js — Central event hub (pub/sub)
// All notification sources emit here; Telegram and WebSocket subscribe.

import { EventEmitter } from "events";

const emitter = new EventEmitter();

// Supported events:
//   chat:response    — agent reply to user message
//   cycle:management — management cycle report
//   cycle:screening  — screening cycle report
//   deploy           — position deployed
//   close            — position closed
//   out_of_range     — position out of range
//   briefing         — morning briefing HTML
//   status           — busy state changes

export function emit(event, data) {
  emitter.emit(event, data);
}

export function on(event, handler) {
  emitter.on(event, handler);
}

export function off(event, handler) {
  emitter.off(event, handler);
}
