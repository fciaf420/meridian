//
//  MeridianClient.swift
//  Meridian
//
//  URLSessionWebSocketTask-based client for the meridian backend WS protocol.
//  Connects to ws://<host>:<port>/ws?token=<token>, auto-reconnects with
//  exponential backoff, and forwards decoded inbound messages to a delegate
//  (the AppStore). All callbacks are delivered on the MainActor.
//

import Foundation

/// Discriminated inbound messages, decoded from the server's JSON "type" field.
enum InboundMessage: Sendable {
    case initial(InitPayload)
    case positions(PositionsPayload)
    case wallet(Wallet)
    case candidates(CandidatesPayload)
    case notification(NotificationMsg)
    case chatResponse(ChatMessage)
    case status(StatusInfo)
    case timer(Timers)
    case authResult(ok: Bool)
    case error(text: String)
    case quickActionResult(action: String, data: AnyJSON?)
    case quickActionError(action: String, error: String)
    case unknown(type: String)
}

/// Connection lifecycle the client reports to its delegate.
enum ConnectionState: Sendable, Equatable {
    case disconnected
    case connecting
    case connected
}

/// Delegate that receives connection-state changes and inbound messages.
/// AppStore conforms to this; all methods are invoked on the MainActor.
@MainActor
protocol MeridianClientDelegate: AnyObject {
    func clientDidChangeState(_ state: ConnectionState)
    func clientDidReceive(_ message: InboundMessage)
}

/// WebSocket client. Not an actor — it confines its mutable state to a private
/// serial queue and hops to MainActor for all delegate callbacks.
final class MeridianClient: NSObject, @unchecked Sendable {

    weak var delegate: MeridianClientDelegate?

    private let queue = DispatchQueue(label: "meridian.client")
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var config: AppConfig?

    private var shouldStayConnected = false
    private var reconnectAttempts = 0
    private var isReceiving = false

    private let maxBackoff: TimeInterval = 30

    override init() {
        super.init()
    }

    // MARK: - Public API

    /// Connect (or reconnect) to the backend described by `config`.
    func connect(config: AppConfig) {
        queue.async { [weak self] in
            guard let self else { return }
            self.config = config
            self.shouldStayConnected = true
            self.reconnectAttempts = 0
            self.openSocket()
        }
    }

    /// Tear down the connection and stop reconnecting.
    func disconnect() {
        queue.async { [weak self] in
            guard let self else { return }
            self.shouldStayConnected = false
            self.closeSocket()
            self.notifyState(.disconnected)
        }
    }

    /// Send a free-form chat message to the agent.
    func send(text: String) {
        sendJSON(["type": "chat", "text": text])
    }

    /// Send a slash command (e.g. "/status", "/auto", or a bare number "1").
    /// The server's handleCommand reads the `command` field.
    func send(command: String) {
        sendJSON(["type": "command", "command": command])
    }

    /// Trigger a quick-action (e.g. "top-pools", "lessons", "memory").
    func quickAction(_ action: String) {
        sendJSON(["type": "quick-action", "action": action])
    }

    /// Authenticate an already-open connection with the dashboard token.
    func authenticate(token: String) {
        sendJSON(["type": "auth", "token": token])
    }

    // MARK: - Socket lifecycle (queue-confined)

    private func openSocket() {
        guard shouldStayConnected, let config, let url = config.webSocketURL else {
            notifyState(.disconnected)
            return
        }

        closeSocket()
        notifyState(.connecting)

        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = 30
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        self.session = session

        let task = session.webSocketTask(with: url)
        self.task = task
        self.isReceiving = false
        task.resume()
        receiveLoop()
    }

    private func closeSocket() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        isReceiving = false
    }

    private func scheduleReconnect() {
        guard shouldStayConnected else { return }
        reconnectAttempts += 1
        let delay = min(maxBackoff, pow(2.0, Double(min(reconnectAttempts, 5))))
        // jitter 0...0.5s
        let jitter = Double.random(in: 0...0.5)
        notifyState(.connecting)
        queue.asyncAfter(deadline: .now() + delay + jitter) { [weak self] in
            guard let self, self.shouldStayConnected else { return }
            self.openSocket()
        }
    }

    // MARK: - Receive loop

    private func receiveLoop() {
        guard let task else { return }
        task.receive { [weak self] result in
            guard let self else { return }
            self.queue.async {
                switch result {
                case .success(let message):
                    self.handle(message)
                    // keep listening
                    self.receiveLoop()
                case .failure:
                    // Socket dropped — reconnect if we still want to be connected.
                    self.closeSocket()
                    self.scheduleReconnect()
                }
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let data: Data?
        switch message {
        case .data(let d): data = d
        case .string(let s): data = s.data(using: .utf8)
        @unknown default: data = nil
        }
        guard let data, !data.isEmpty else { return }
        guard let inbound = Self.decode(data) else { return }
        dispatch(inbound)
    }

    /// Decode a raw JSON frame into an InboundMessage. Never throws.
    static func decode(_ data: Data) -> InboundMessage? {
        let decoder = JSONDecoder()
        // Peek the "type" discriminator.
        struct TypeOnly: Decodable { let type: String? }
        let type = (try? decoder.decode(TypeOnly.self, from: data))?.type ?? ""

        switch type {
        case "init":
            let p = (try? decoder.decode(InitPayload.self, from: data)) ?? InitPayload()
            return .initial(p)
        case "positions":
            struct Wrap: Decodable { let data: PositionsPayload? }
            let w = try? decoder.decode(Wrap.self, from: data)
            return .positions(w?.data ?? PositionsPayload())
        case "wallet":
            struct Wrap: Decodable { let data: Wallet? }
            let w = try? decoder.decode(Wrap.self, from: data)
            return .wallet(w?.data ?? Wallet())
        case "candidates":
            struct Wrap: Decodable { let data: CandidatesPayload? }
            let w = try? decoder.decode(Wrap.self, from: data)
            return .candidates(w?.data ?? CandidatesPayload())
        case "notification":
            let n = (try? decoder.decode(NotificationMsg.self, from: data)) ?? NotificationMsg()
            return .notification(n)
        case "chat:response":
            let m = (try? decoder.decode(ChatMessage.self, from: data)) ?? ChatMessage()
            return .chatResponse(m)
        case "status":
            let s = (try? decoder.decode(StatusInfo.self, from: data)) ?? StatusInfo()
            return .status(s)
        case "timer":
            let t = (try? decoder.decode(Timers.self, from: data)) ?? Timers()
            return .timer(t)
        case "auth:result":
            struct Wrap: Decodable { let ok: Bool? }
            let w = try? decoder.decode(Wrap.self, from: data)
            return .authResult(ok: w?.ok ?? false)
        case "error":
            struct Wrap: Decodable { let text: String? }
            let w = try? decoder.decode(Wrap.self, from: data)
            return .error(text: w?.text ?? "Unknown error")
        case "quick-action:result":
            struct Wrap: Decodable { let action: String?; let data: AnyJSON? }
            let w = try? decoder.decode(Wrap.self, from: data)
            return .quickActionResult(action: w?.action ?? "", data: w?.data)
        case "quick-action:error":
            struct Wrap: Decodable { let action: String?; let error: String? }
            let w = try? decoder.decode(Wrap.self, from: data)
            return .quickActionError(action: w?.action ?? "", error: w?.error ?? "error")
        default:
            return .unknown(type: type)
        }
    }

    // MARK: - Sending

    private func sendJSON(_ object: [String: Any]) {
        // Serialize on the calling thread so only the Sendable String crosses
        // into the @Sendable queue closure.
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object),
              let string = String(data: data, encoding: .utf8) else { return }
        sendRaw(string)
    }

    private func sendRaw(_ string: String) {
        queue.async { [weak self] in
            guard let self, let task = self.task else { return }
            task.send(.string(string)) { _ in
                // Send failures surface via the receive loop dropping; ignore here.
            }
        }
    }

    // MARK: - Delegate hops (to MainActor)

    private func notifyState(_ state: ConnectionState) {
        if state == .connected { reconnectAttempts = 0 }
        Task { @MainActor [weak self] in
            self?.delegate?.clientDidChangeState(state)
        }
    }

    private func dispatch(_ message: InboundMessage) {
        Task { @MainActor [weak self] in
            self?.delegate?.clientDidReceive(message)
        }
    }
}

// MARK: - URLSessionWebSocketDelegate

extension MeridianClient: URLSessionWebSocketDelegate {
    func urlSession(_ session: URLSession,
                    webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {
        queue.async { [weak self] in
            self?.reconnectAttempts = 0
            self?.notifyState(.connected)
        }
    }

    func urlSession(_ session: URLSession,
                    webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                    reason: Data?) {
        queue.async { [weak self] in
            guard let self else { return }
            self.closeSocket()
            self.scheduleReconnect()
        }
    }

    func urlSession(_ session: URLSession,
                    task: URLSessionTask,
                    didCompleteWithError error: Error?) {
        queue.async { [weak self] in
            guard let self else { return }
            // Only react if this is the active session's task failing.
            if error != nil {
                self.closeSocket()
                self.scheduleReconnect()
            }
        }
    }
}
