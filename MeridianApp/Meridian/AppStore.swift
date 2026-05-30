//
//  AppStore.swift
//  Meridian
//
//  @MainActor ObservableObject that owns a MeridianClient, routes inbound
//  WebSocket messages into @Published state, and exposes high-level actions
//  (connect, deploy, auto, chat, commands) to the SwiftUI tab views.
//

import Foundation
import Combine
import SwiftUI

@MainActor
final class AppStore: ObservableObject {

    // MARK: - Connection / auth

    @Published var connectionState: ConnectionState = .disconnected
    @Published var connected: Bool = false
    @Published var authed: Bool = false
    @Published var authRequired: Bool = false

    // MARK: - Data state

    @Published var wallet: Wallet?
    @Published var positions: [Position] = []
    @Published var candidates: [Candidate] = []
    @Published var status: StatusInfo?
    @Published var timers: Timers?

    @Published var totalEligible: Int?
    @Published var totalScreened: Int?

    // MARK: - Logs

    /// Notifications log, newest first.
    @Published var activity: [ActivityEntry] = []
    /// Chat transcript, oldest first (natural reading order).
    @Published var chat: [ChatLine] = []

    /// Last error surfaced by the backend (for a transient banner).
    @Published var lastError: String?

    // MARK: - Config

    @Published var config: AppConfig

    // MARK: - Private

    private let client: MeridianClient
    private let maxActivity = 200
    private let maxChat = 500

    // MARK: - Init

    init(config: AppConfig = AppConfig.load(), client: MeridianClient = MeridianClient()) {
        self.config = config
        self.client = client
        self.client.delegate = self
    }

    // MARK: - Lifecycle

    /// Connect using the current config. Persists the config first.
    func connect() {
        config.save()
        client.connect(config: config)
    }

    /// Connect using an updated config (also persists it).
    func connect(with newConfig: AppConfig) {
        config = newConfig
        connect()
    }

    func disconnect() {
        client.disconnect()
    }

    /// Reconnect — used by Settings after the user edits host/port/token.
    func reconnect() {
        client.disconnect()
        connect()
    }

    // MARK: - Actions

    /// Ask the backend for fresh top-pool candidates.
    func refreshCandidates() {
        client.quickAction("top-pools")
    }

    /// Deploy real funds into candidate #index (1-based, matching the backend).
    func deploy(index: Int) {
        client.send(command: String(index))
    }

    /// Run the autonomous deploy cycle.
    func auto() {
        client.send(command: "/auto")
    }

    /// Send a free-form chat message to the agent and echo it locally.
    func sendChat(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        appendChat(ChatLine(role: .user, text: trimmed))
        client.send(text: trimmed)
    }

    /// Run an arbitrary slash command (e.g. "/status", "/briefing").
    func runCommand(_ command: String) {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        client.send(command: trimmed)
    }

    /// Authenticate with the configured token (or an explicit one).
    func authenticate(token: String? = nil) {
        let t = (token ?? config.token).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        client.authenticate(token: t)
    }

    /// Convenience for the Activity/Pools tabs to fire any quick-action.
    func quickAction(_ action: String) {
        client.quickAction(action)
    }

    // MARK: - Mutation helpers

    private func appendChat(_ line: ChatLine) {
        chat.append(line)
        if chat.count > maxChat {
            chat.removeFirst(chat.count - maxChat)
        }
    }

    private func appendActivity(_ entry: ActivityEntry) {
        activity.insert(entry, at: 0)
        if activity.count > maxActivity {
            activity.removeLast(activity.count - maxActivity)
        }
    }

    private func apply(_ payload: InitPayload) {
        if let a = payload.authed { authed = a }
        if let r = payload.authRequired { authRequired = r }
        if let s = payload.status { status = s }
        if let t = payload.timers { timers = t }
        if let w = payload.wallet { wallet = w }
        if let p = payload.positions {
            positions = p.positions
        }
        if let c = payload.candidates {
            candidates = c.candidates
            totalEligible = c.totalEligible
            totalScreened = c.totalScreened
        }
    }

    private func humanTitle(for event: String) -> String {
        switch event {
        case "deploy": return "Position deployed"
        case "close": return "Position closed"
        case "out_of_range": return "Position out of range"
        case "briefing": return "Briefing"
        case "cycle:management": return "Management cycle"
        case "cycle:screening": return "Screening cycle"
        default: return event
        }
    }

    /// Extract a short, human-readable detail string from a notification payload.
    private func detail(from data: AnyJSON?) -> String? {
        guard let data else { return nil }
        switch data {
        case .string(let s):
            return s
        case .object(let obj):
            // Prefer common descriptive keys.
            for key in ["text", "message", "summary", "pair", "name", "event"] {
                if let v = obj[key]?.stringValue, !v.isEmpty { return v }
            }
            // Fall back to a compact key:value preview.
            let parts = obj.prefix(4).compactMap { (k, v) -> String? in
                guard let sv = v.stringValue else { return nil }
                return "\(k): \(sv)"
            }
            return parts.isEmpty ? nil : parts.joined(separator: " · ")
        case .double(let d):
            return String(d)
        case .bool(let b):
            return String(b)
        default:
            return nil
        }
    }
}

// MARK: - MeridianClientDelegate

extension AppStore: MeridianClientDelegate {

    func clientDidChangeState(_ state: ConnectionState) {
        connectionState = state
        connected = (state == .connected)
        if state == .disconnected {
            // Keep last-known data on screen; just flip the flag.
        }
    }

    func clientDidReceive(_ message: InboundMessage) {
        switch message {
        case .initial(let payload):
            apply(payload)

        case .positions(let payload):
            positions = payload.positions

        case .wallet(let w):
            wallet = w

        case .candidates(let payload):
            candidates = payload.candidates
            totalEligible = payload.totalEligible
            totalScreened = payload.totalScreened

        case .notification(let note):
            let event = note.event ?? "event"
            appendActivity(ActivityEntry(
                event: event,
                title: humanTitle(for: event),
                detail: detail(from: note.data)
            ))
            // A briefing notification also reads nicely in chat.
            if event == "briefing", let text = detail(from: note.data) {
                appendChat(ChatLine(role: .system, text: text))
            }

        case .chatResponse(let msg):
            if let text = msg.text, !text.isEmpty {
                appendChat(ChatLine(role: .agent, text: text))
            }

        case .status(let s):
            status = s

        case .timer(let t):
            timers = t

        case .authResult(let ok):
            authed = ok
            if !ok {
                lastError = "Authentication failed — check your dashboard token."
            } else {
                lastError = nil
            }

        case .error(let text):
            lastError = text
            appendActivity(ActivityEntry(event: "error", title: "Error", detail: text))

        case .quickActionResult(let action, let data):
            handleQuickActionResult(action: action, data: data)

        case .quickActionError(let action, let error):
            lastError = "\(action): \(error)"

        case .unknown:
            break
        }
    }

    /// Route quick-action results into the relevant state where it maps cleanly.
    private func handleQuickActionResult(action: String, data: AnyJSON?) {
        guard let data else { return }
        switch action {
        case "top-pools":
            // The server returns the raw candidates array for this action.
            if let array = data.arrayValue,
               let encoded = try? JSONEncoder().encode(array),
               let decoded = try? JSONDecoder().decode([Candidate].self, from: encoded) {
                candidates = decoded
            } else if let nested = data["candidates"]?.arrayValue,
                      let encoded = try? JSONEncoder().encode(nested),
                      let decoded = try? JSONDecoder().decode([Candidate].self, from: encoded) {
                candidates = decoded
            }
        default:
            // Other quick-actions (lessons, memory, etc.) are consumed by their
            // own tab views via dedicated calls; nothing to route globally.
            break
        }
    }
}
