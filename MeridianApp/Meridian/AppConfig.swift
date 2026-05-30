//
//  AppConfig.swift
//  Meridian
//
//  Connection configuration for the meridian DLMM backend.
//  Persisted in UserDefaults via @AppStorage-compatible keys.
//

import Foundation

/// Connection configuration for the meridian backend.
/// Host/port/token are persisted in UserDefaults under stable keys so the
/// Settings screen (Agent N) and the AppStore agree on where to connect.
struct AppConfig: Equatable, Sendable {
    var host: String
    var port: Int
    var token: String

    static let defaultHost = "127.0.0.1"
    static let defaultPort = 3737

    /// UserDefaults keys — these MUST match what the Settings tab reads/writes.
    enum Keys {
        static let host = "meridian.host"
        static let port = "meridian.port"
        static let token = "meridian.token"
    }

    init(host: String = AppConfig.defaultHost,
         port: Int = AppConfig.defaultPort,
         token: String = "") {
        self.host = host
        self.port = port
        self.token = token
    }

    /// Load the persisted config (or sane defaults if never set).
    static func load(from defaults: UserDefaults = .standard) -> AppConfig {
        let host = defaults.string(forKey: Keys.host)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let storedPort = defaults.object(forKey: Keys.port) as? Int
        let token = defaults.string(forKey: Keys.token) ?? ""
        return AppConfig(
            host: (host?.isEmpty == false ? host! : defaultHost),
            port: (storedPort ?? defaultPort),
            token: token
        )
    }

    /// Persist the current config.
    func save(to defaults: UserDefaults = .standard) {
        defaults.set(host, forKey: Keys.host)
        defaults.set(port, forKey: Keys.port)
        defaults.set(token, forKey: Keys.token)
    }

    /// Normalize a possibly-empty/whitespacey host to something usable.
    var normalizedHost: String {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? AppConfig.defaultHost : trimmed
    }

    /// WebSocket URL: ws://<host>:<port>/ws?token=<token> (token omitted if empty).
    var webSocketURL: URL? {
        var components = URLComponents()
        components.scheme = "ws"
        components.host = normalizedHost
        components.port = port
        components.path = "/ws"
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedToken.isEmpty {
            components.queryItems = [URLQueryItem(name: "token", value: trimmedToken)]
        }
        return components.url
    }

    /// Base REST URL: http://<host>:<port>
    var restBaseURL: URL? {
        var components = URLComponents()
        components.scheme = "http"
        components.host = normalizedHost
        components.port = port
        return components.url
    }

    func restURL(path: String) -> URL? {
        guard let base = restBaseURL else { return nil }
        return base.appendingPathComponent(path)
    }
}
