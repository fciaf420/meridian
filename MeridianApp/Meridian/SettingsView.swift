//
//  SettingsView.swift
//  Meridian
//
//  Agent 5 — Settings. Configure backend connection (AppConfig), connect/disconnect,
//  and show a clear connection + auth status. Reads the shared AppStore via @EnvironmentObject.
//

import SwiftUI

/// Settings screen: edit the backend `AppConfig` (host / port / optional dashboard token),
/// connect or disconnect, and surface live connection + auth state from the `AppStore`.
///
/// Persistence is owned by Agent 1's `AppConfig` (UserDefaults / @AppStorage). This view
/// edits draft values locally and applies them by writing them back into the config and
/// asking the store to (re)connect. The same `@AppStorage` keys / defaults from the contract
/// are mirrored here so edits survive even if the store is rebuilt.
struct SettingsView: View {
    @EnvironmentObject private var store: AppStore

    // Mirror of AppConfig persistence. Keys + defaults match Agent 1's AppConfig
    // (host "127.0.0.1", port 3737, empty token) so the form is the source of truth
    // for what gets persisted, and survives relaunch.
    @AppStorage("meridian.host") private var host: String = "127.0.0.1"
    @AppStorage("meridian.port") private var port: Int = 3737
    @AppStorage("meridian.token") private var token: String = ""

    // Local draft edits — committed to @AppStorage only when the user taps Connect / Save.
    @State private var draftHost: String = ""
    @State private var draftPortText: String = ""
    @State private var draftToken: String = ""

    @State private var showToken: Bool = false

    @FocusState private var focusedField: Field?
    private enum Field: Hashable { case host, port, token }

    var body: some View {
        NavigationStack {
            Form {
                statusSection
                serverSection
                tokenSection
                actionSection
            }
            .navigationTitle("Settings")
            .scrollDismissesKeyboard(.interactively)
            .toolbar {
                ToolbarItem(placement: .keyboard) {
                    Spacer()
                }
                ToolbarItem(placement: .keyboard) {
                    Button("Done") { focusedField = nil }
                }
            }
        }
        .onAppear(perform: loadDraftFromConfig)
    }

    // MARK: - Status

    private var statusSection: some View {
        Section {
            HStack(spacing: 12) {
                Circle()
                    .fill(connectionColor)
                    .frame(width: 12, height: 12)
                    .overlay(
                        Circle()
                            .stroke(connectionColor.opacity(0.35), lineWidth: 6)
                    )
                VStack(alignment: .leading, spacing: 2) {
                    Text(connectionTitle)
                        .font(.headline)
                    Text(connectionSubtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: store.connected ? "bolt.horizontal.circle.fill" : "bolt.slash.circle")
                    .font(.title2)
                    .foregroundStyle(connectionColor)
                    .symbolRenderingMode(.hierarchical)
            }
            .padding(.vertical, 2)

            // Auth indicator — only meaningful once connected.
            HStack {
                Label {
                    Text(authText)
                } icon: {
                    Image(systemName: store.authed ? "lock.open.fill" : "lock.fill")
                }
                .foregroundStyle(authColor)
                Spacer()
                if store.authed {
                    Text("Read + Write")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.green)
                } else {
                    Text("Read-only")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
        } header: {
            Text("Connection")
        } footer: {
            Text("Read-only views (wallet, positions, pools) work without a token. A dashboard token is required only for fund-moving actions like deploy and auto.")
        }
    }

    // MARK: - Server config

    private var serverSection: some View {
        Section {
            LabeledContent("Host") {
                TextField("127.0.0.1", text: $draftHost)
                    .multilineTextAlignment(.trailing)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled(true)
                    .keyboardType(.URL)
                    .submitLabel(.next)
                    .focused($focusedField, equals: .host)
                    .onSubmit { focusedField = .port }
            }
            LabeledContent("Port") {
                TextField("3737", text: $draftPortText)
                    .multilineTextAlignment(.trailing)
                    .keyboardType(.numberPad)
                    .focused($focusedField, equals: .port)
                    .onChange(of: draftPortText) { _, newValue in
                        // Keep only digits, clamp to a valid TCP port range.
                        let digits = newValue.filter { $0.isNumber }
                        let trimmed = String(digits.prefix(5))
                        if trimmed != newValue {
                            draftPortText = trimmed
                        }
                    }
            }
        } header: {
            Text("Backend Server")
        } footer: {
            if let url = previewURL {
                Text("Will connect to \(url)")
                    .font(.footnote.monospaced())
            } else {
                Text("Enter a valid host and port (1–65535).")
                    .foregroundStyle(.red)
            }
        }
    }

    // MARK: - Token

    private var tokenSection: some View {
        Section {
            HStack {
                Group {
                    if showToken {
                        TextField("Optional dashboard token", text: $draftToken)
                    } else {
                        SecureField("Optional dashboard token", text: $draftToken)
                    }
                }
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
                .focused($focusedField, equals: .token)

                if !draftToken.isEmpty {
                    Button {
                        showToken.toggle()
                    } label: {
                        Image(systemName: showToken ? "eye.slash" : "eye")
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.borderless)
                }
            }
        } header: {
            Text("Dashboard Token (optional)")
        } footer: {
            Text("Only needed to authorize fund-moving commands (deploy / auto / close). Leave blank for read-only access.")
        }
    }

    // MARK: - Actions

    private var actionSection: some View {
        Section {
            if store.connected {
                Button(role: .destructive) {
                    store.disconnect()
                } label: {
                    Label("Disconnect", systemImage: "xmark.circle")
                        .frame(maxWidth: .infinity)
                }

                Button {
                    applyAndConnect()
                } label: {
                    Label("Save & Reconnect", systemImage: "arrow.clockwise")
                        .frame(maxWidth: .infinity)
                }
                .disabled(!hasValidConfig)
            } else {
                Button {
                    applyAndConnect()
                } label: {
                    Label("Connect", systemImage: "bolt.horizontal")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!hasValidConfig)
            }
        } footer: {
            if hasUnsavedChanges {
                Text("You have unsaved changes. Tap \(store.connected ? "Save & Reconnect" : "Connect") to apply.")
                    .foregroundStyle(.orange)
            }
        }
    }

    // MARK: - Derived state

    private var connectionColor: Color {
        store.connected ? .green : .secondary
    }

    private var connectionTitle: String {
        store.connected ? "Connected" : "Not Connected"
    }

    private var connectionSubtitle: String {
        store.connected ? "ws://\(host):\(port)/ws" : "Configure the backend below, then connect."
    }

    private var authText: String {
        store.authed ? "Authenticated" : "Not authenticated"
    }

    private var authColor: Color {
        store.authed ? .green : .secondary
    }

    private var parsedPort: Int? {
        guard let value = Int(draftPortText), (1...65535).contains(value) else { return nil }
        return value
    }

    private var trimmedHost: String {
        draftHost.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var hasValidConfig: Bool {
        !trimmedHost.isEmpty && parsedPort != nil
    }

    private var previewURL: String? {
        guard hasValidConfig, let p = parsedPort else { return nil }
        return "ws://\(trimmedHost):\(p)/ws"
    }

    private var hasUnsavedChanges: Bool {
        trimmedHost != host
            || parsedPort != port
            || draftToken.trimmingCharacters(in: .whitespacesAndNewlines) != token
    }

    // MARK: - Mutations

    private func loadDraftFromConfig() {
        draftHost = host
        draftPortText = String(port)
        draftToken = token
    }

    /// Commit the draft into persisted config, then (re)connect through the store.
    private func applyAndConnect() {
        guard let p = parsedPort else { return }
        focusedField = nil

        host = trimmedHost
        port = p
        token = draftToken.trimmingCharacters(in: .whitespacesAndNewlines)

        // Normalize the visible drafts to the committed values.
        draftHost = host
        draftPortText = String(port)
        draftToken = token

        // Reconnect with the freshly persisted config. The store owns the MeridianClient
        // and reads the persisted AppConfig on connect(); disconnect first if already live.
        if store.connected {
            store.disconnect()
        }
        store.connect()
    }
}

#Preview {
    SettingsView()
        .environmentObject(AppStore())
}
