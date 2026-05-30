//
//  PoolsView.swift
//  Meridian
//
//  Candidate pools tab. Shows the ranked screening candidates from the
//  backend (store.candidates), with a Refresh action (/candidates), a
//  per-row Deploy action (numeric deploy command), and an Auto button
//  (/auto). Fund-moving actions are visibly gated when !store.authed.
//
//  Agent 3 — owns this file only.
//

import SwiftUI

struct PoolsView: View {
    @EnvironmentObject private var store: AppStore

    // Deploy confirmation state.
    @State private var pendingDeployIndex: Int? = nil
    @State private var showAutoConfirm = false

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Pools")
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        ConnectionDot(connected: store.connected)
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            store.refreshCandidates()
                        } label: {
                            Label("Refresh", systemImage: "arrow.clockwise")
                        }
                        .disabled(!store.connected)
                    }
                }
                .refreshable {
                    store.refreshCandidates()
                }
                .confirmationDialog(
                    "Deploy into this pool?",
                    isPresented: deployDialogBinding,
                    titleVisibility: .visible
                ) {
                    if let idx = pendingDeployIndex {
                        Button("Deploy candidate #\(idx + 1)", role: .destructive) {
                            store.deploy(index: idx)
                            pendingDeployIndex = nil
                        }
                    }
                    Button("Cancel", role: .cancel) {
                        pendingDeployIndex = nil
                    }
                } message: {
                    Text("This moves real funds. The agent will pick the active bin and deploy SOL into the selected pool.")
                }
                .confirmationDialog(
                    "Run Auto-deploy?",
                    isPresented: $showAutoConfirm,
                    titleVisibility: .visible
                ) {
                    Button("Auto-deploy best pool", role: .destructive) {
                        store.auto()
                    }
                    Button("Cancel", role: .cancel) { }
                } message: {
                    Text("The agent will screen candidates, pick the best one, and deploy SOL automatically.")
                }
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if store.candidates.isEmpty {
            emptyState
        } else {
            poolList
        }
    }

    private var poolList: some View {
        List {
            if !store.authed {
                Section {
                    AuthGateBanner()
                }
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
            }

            Section {
                ForEach(Array(store.candidates.enumerated()), id: \.offset) { pair in
                    PoolRow(
                        rank: pair.offset + 1,
                        candidate: pair.element,
                        authed: store.authed,
                        connected: store.connected,
                        onDeploy: { pendingDeployIndex = pair.offset }
                    )
                }
            } header: {
                HStack {
                    Text("Ranked Candidates")
                    Spacer()
                    Text("\(store.candidates.count)")
                        .foregroundStyle(.secondary)
                }
            } footer: {
                Text("Ranked by fee/active-TVL ratio, volume, then organic score. Tap a row to deploy.")
            }
        }
        .listStyle(.insetGrouped)
        .safeAreaInset(edge: .bottom) {
            autoBar
        }
    }

    private var emptyState: some View {
        VStack(spacing: 20) {
            if !store.authed {
                AuthGateBanner()
                    .padding(.horizontal)
            }

            ContentUnavailableView {
                Label("No Candidate Pools", systemImage: "chart.bar.xaxis")
            } description: {
                Text(store.connected
                     ? "Pull to refresh or tap Refresh to screen for eligible DLMM pools."
                     : "Not connected to the backend. Check host and port in Settings.")
            } actions: {
                Button {
                    store.refreshCandidates()
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderedProminent)
                .disabled(!store.connected)
            }

            Spacer()
        }
        .padding(.top)
        .safeAreaInset(edge: .bottom) {
            autoBar
        }
    }

    // MARK: - Auto bar

    private var autoBar: some View {
        VStack(spacing: 6) {
            Button {
                showAutoConfirm = true
            } label: {
                Label(store.authed ? "Auto-deploy Best Pool" : "Auto-deploy (token required)",
                      systemImage: "wand.and.stars")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .tint(store.authed ? .accentColor : .gray)
            .disabled(!store.authed || !store.connected)

            if !store.authed {
                Text("Set the dashboard token in Settings to enable fund-moving actions.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(.bar)
    }

    // MARK: - Bindings

    private var deployDialogBinding: Binding<Bool> {
        Binding(
            get: { pendingDeployIndex != nil },
            set: { newValue in
                if !newValue { pendingDeployIndex = nil }
            }
        )
    }
}

// MARK: - Pool Row

private struct PoolRow: View {
    let rank: Int
    let candidate: Candidate
    let authed: Bool
    let connected: Bool
    let onDeploy: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("#\(rank)")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 28, alignment: .leading)

                VStack(alignment: .leading, spacing: 2) {
                    Text(displayName)
                        .font(.headline)
                        .lineLimit(1)
                    if let bin = binStepText {
                        Text(bin)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()

                deployButton
            }

            // Metric chips.
            HStack(spacing: 8) {
                MetricChip(
                    label: "fee/aTVL",
                    value: ratioText,
                    systemImage: "percent",
                    tint: .green
                )
                MetricChip(
                    label: "vol",
                    value: volumeText,
                    systemImage: "chart.line.uptrend.xyaxis",
                    tint: .blue
                )
                MetricChip(
                    label: "organic",
                    value: organicText,
                    systemImage: "leaf",
                    tint: .teal
                )
            }

            if let active = activePctText {
                Text("Active range: \(active)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }

    private var deployButton: some View {
        Button {
            onDeploy()
        } label: {
            Text("Deploy")
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .tint(authed ? .accentColor : .gray)
        .disabled(!authed || !connected)
        .accessibilityLabel(authed ? "Deploy into pool \(rank)" : "Deploy disabled, set dashboard token in Settings")
    }

    // MARK: - Formatting helpers (all defensive)

    private var displayName: String {
        let n = candidate.name ?? ""
        return n.isEmpty ? "Unknown pool" : n
    }

    private var binStepText: String? {
        guard let step = candidate.binStep else { return nil }
        return "bin step \(step)"
    }

    private var ratioText: String {
        guard let r = candidate.bestFeeTvlRatio else { return "—" }
        return PoolFormat.percent(r)
    }

    private var volumeText: String {
        guard let v = candidate.volume else { return "—" }
        return PoolFormat.compactUSD(v)
    }

    private var organicText: String {
        guard let o = candidate.organicScore else { return "—" }
        return PoolFormat.score(o)
    }

    private var activePctText: String? {
        guard let a = candidate.activePct else { return nil }
        return PoolFormat.percent(a)
    }
}

// MARK: - Metric Chip

private struct MetricChip: View {
    let label: String
    let value: String
    let systemImage: String
    let tint: Color

    var body: some View {
        VStack(spacing: 2) {
            HStack(spacing: 4) {
                Image(systemName: systemImage)
                    .font(.caption2)
                    .foregroundStyle(tint)
                Text(value)
                    .font(.caption.weight(.semibold))
                    .monospacedDigit()
            }
            Text(label)
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .background(tint.opacity(0.10), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

// MARK: - Auth Gate Banner

private struct AuthGateBanner: View {
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "lock.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Read-only mode")
                    .font(.subheadline.weight(.semibold))
                Text("Deploy and Auto are disabled. Set the dashboard token in Settings to move funds.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

// MARK: - Formatting

private enum PoolFormat {
    /// Backend ratios/percentages arrive as already-scaled percent values
    /// (e.g. 12.5 == 12.5%). Render defensively with one decimal.
    static func percent(_ value: Double) -> String {
        guard value.isFinite else { return "—" }
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.minimumFractionDigits = value == value.rounded() ? 0 : 1
        f.maximumFractionDigits = 2
        let n = f.string(from: NSNumber(value: value)) ?? "\(value)"
        return "\(n)%"
    }

    static func score(_ value: Double) -> String {
        guard value.isFinite else { return "—" }
        if value == value.rounded() {
            return String(Int(value))
        }
        return String(format: "%.1f", value)
    }

    /// Compact USD volume: $1.2k, $3.4M, etc.
    static func compactUSD(_ value: Double) -> String {
        guard value.isFinite else { return "—" }
        let abs = Swift.abs(value)
        let sign = value < 0 ? "-" : ""
        switch abs {
        case 1_000_000_000...:
            return "\(sign)$\(trim(abs / 1_000_000_000))B"
        case 1_000_000...:
            return "\(sign)$\(trim(abs / 1_000_000))M"
        case 1_000...:
            return "\(sign)$\(trim(abs / 1_000))k"
        default:
            return "\(sign)$\(trim(abs))"
        }
    }

    private static func trim(_ value: Double) -> String {
        if value >= 100 || value == value.rounded() {
            return String(Int(value.rounded()))
        }
        return String(format: "%.1f", value)
    }
}

// MARK: - Preview

#Preview {
    PoolsView()
        .environmentObject(AppStore())
}
