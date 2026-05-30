//
//  DashboardView.swift
//  Meridian
//
//  Dashboard tab: wallet summary, cron timers, busy/idle status,
//  and the list of open positions. Reads everything from the shared
//  AppStore (owned by Agent 1). Pull-to-refresh asks the store to
//  re-pull positions + wallet. Renders cleanly with no backend.
//

import SwiftUI

struct DashboardView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    connectionBanner
                    walletCard
                    timersCard
                    positionsSection
                }
                .padding(.horizontal)
                .padding(.bottom, 24)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Dashboard")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    statusPill
                }
            }
            .refreshable {
                await refresh()
            }
        }
    }

    // MARK: - Refresh

    private func refresh() async {
        // The store owns the actual WS refresh; call its public API.
        store.refreshCandidates()
        // Nudge the store to re-pull positions/wallet via a no-op-safe command.
        store.runCommand("/status")
    }

    // MARK: - Connection banner

    @ViewBuilder
    private var connectionBanner: some View {
        if !store.connected {
            HStack(spacing: 10) {
                Image(systemName: "wifi.slash")
                    .foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Not connected")
                        .font(.subheadline.weight(.semibold))
                    Text("Open Settings to configure the backend host and token.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.orange.opacity(0.12))
            )
        }
    }

    // MARK: - Status pill (toolbar)

    private var statusPill: some View {
        let busy = store.status?.busy ?? false
        return HStack(spacing: 6) {
            Circle()
                .fill(store.connected ? (busy ? Color.yellow : Color.green) : Color.gray)
                .frame(width: 9, height: 9)
            Text(store.connected ? (busy ? "Working" : "Idle") : "Offline")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Wallet card

    private var walletCard: some View {
        DashCard(title: "Wallet", systemImage: "wallet.bass.fill") {
            if let w = store.wallet {
                VStack(spacing: 14) {
                    HStack {
                        Text("Total Value")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text(Self.usd(w.totalUsd))
                            .font(.title2.weight(.bold))
                            .monospacedDigit()
                    }
                    Divider()
                    HStack(spacing: 12) {
                        balanceCell(
                            label: "SOL",
                            primary: Self.token(w.sol, max: 4),
                            secondary: Self.usd(w.solUsd)
                        )
                        Divider().frame(height: 38)
                        balanceCell(
                            label: "USDC",
                            primary: Self.token(w.usdc, max: 2),
                            secondary: Self.usd(w.usdc)
                        )
                    }
                }
            } else {
                placeholder("No wallet data")
            }
        }
    }

    private func balanceCell(label: String, primary: String, secondary: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(primary)
                .font(.headline)
                .monospacedDigit()
            Text(secondary)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Timers card

    private var timersCard: some View {
        DashCard(title: "Cron Timers", systemImage: "timer") {
            HStack(spacing: 12) {
                timerCell(
                    label: "Management",
                    value: store.timers?.management ?? "—",
                    icon: "arrow.triangle.2.circlepath",
                    busy: store.status?.managementBusy ?? false
                )
                Divider().frame(height: 44)
                timerCell(
                    label: "Screening",
                    value: store.timers?.screening ?? "—",
                    icon: "magnifyingglass",
                    busy: store.status?.screeningBusy ?? false
                )
            }
        }
    }

    private func timerCell(label: String, value: String, icon: String, busy: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 5) {
                Image(systemName: icon)
                    .font(.caption)
                    .foregroundStyle(busy ? Color.yellow : Color.accentColor)
                Text(label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                if busy {
                    Text("running")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.yellow)
                }
            }
            Text(value)
                .font(.title3.weight(.semibold))
                .monospacedDigit()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Positions

    private var positionsSection: some View {
        DashCard(
            title: "Open Positions",
            systemImage: "chart.line.uptrend.xyaxis",
            trailing: store.positions.isEmpty ? nil : "\(store.positions.count)"
        ) {
            if store.positions.isEmpty {
                placeholder(store.connected ? "No open positions" : "Connect to view positions")
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(store.positions.enumerated()), id: \.offset) { idx, pos in
                        PositionRow(position: pos)
                        if idx < store.positions.count - 1 {
                            Divider().padding(.vertical, 10)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Shared bits

    private func placeholder(_ text: String) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, 8)
    }

    // MARK: - Formatting helpers

    static func usd(_ value: Double?) -> String {
        let v = value ?? 0
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        f.maximumFractionDigits = 2
        return f.string(from: NSNumber(value: v)) ?? "$0.00"
    }

    static func token(_ value: Double?, max: Int) -> String {
        let v = value ?? 0
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.minimumFractionDigits = 0
        f.maximumFractionDigits = max
        return f.string(from: NSNumber(value: v)) ?? "0"
    }

    static func signedUsd(_ value: Double?) -> String {
        let v = value ?? 0
        let base = usd(abs(v))
        return v < 0 ? "-\(base)" : "+\(base)"
    }

    static func signedPct(_ value: Double?) -> String {
        let v = value ?? 0
        let sign = v < 0 ? "" : "+"
        return "\(sign)\(String(format: "%.2f", v))%"
    }

    static func sol(_ value: Double?) -> String {
        let v = value ?? 0
        return "\(String(format: "%.4f", v)) SOL"
    }
}

// MARK: - Position row

private struct PositionRow: View {
    let position: Position

    private var pnlUsd: Double { position.pnlUsd ?? 0 }
    private var inRange: Bool { position.inRange ?? false }
    private var pnlColor: Color { pnlUsd < 0 ? .red : .green }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(position.pair ?? "Unknown pair")
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
                rangeBadge
            }

            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("PnL")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(DashboardView.signedUsd(position.pnlUsd))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(pnlColor)
                        .monospacedDigit()
                    HStack(spacing: 6) {
                        Text(DashboardView.signedPct(position.pnlPct))
                        Text(DashboardView.sol(position.pnlSol))
                    }
                    .font(.caption2)
                    .foregroundStyle(pnlColor)
                    .monospacedDigit()
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text("Unclaimed Fees")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(DashboardView.usd(position.unclaimedFeesUsd))
                        .font(.subheadline.weight(.semibold))
                        .monospacedDigit()
                    Text(DashboardView.sol(position.unclaimedFeesSol))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }
        }
        .padding(.vertical, 2)
    }

    private var rangeBadge: some View {
        Text(inRange ? "IN RANGE" : "OUT OF RANGE")
            .font(.caption2.weight(.bold))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
                Capsule().fill((inRange ? Color.green : Color.red).opacity(0.15))
            )
            .foregroundStyle(inRange ? Color.green : Color.red)
    }
}

// MARK: - Reusable card container

private struct DashCard<Content: View>: View {
    let title: String
    let systemImage: String
    var trailing: String? = nil
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: systemImage)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                if let trailing {
                    Text(trailing)
                        .font(.caption.weight(.bold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(Color.secondary.opacity(0.15)))
                        .foregroundStyle(.secondary)
                }
            }
            content()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
        )
    }
}

#Preview {
    DashboardView()
        .environmentObject(AppStore())
}
