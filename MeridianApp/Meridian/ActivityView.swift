//
//  ActivityView.swift
//  Meridian
//
//  Live feed of agent notifications (deploy / close / out_of_range / briefing /
//  cycle:management / cycle:screening). Reads store.activity (newest first).
//

import SwiftUI

struct ActivityView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        NavigationStack {
            Group {
                if store.activity.isEmpty {
                    emptyState
                } else {
                    List {
                        ForEach(store.activity) { entry in
                            ActivityRow(entry: entry)
                                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                        }
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("Activity")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    ConnectionDot(connected: store.connected)
                }
            }
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No Activity Yet", systemImage: "bell.slash")
        } description: {
            Text(store.connected
                 ? "Live events from the agent — deploys, closes, out-of-range alerts, briefings and cycle reports — will appear here."
                 : "Not connected. Connect to the backend in Settings to receive live events.")
        }
    }
}

// MARK: - Row

private struct ActivityRow: View {
    let entry: ActivityEntry

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                Circle()
                    .fill(style.color.opacity(0.15))
                    .frame(width: 38, height: 38)
                Image(systemName: style.icon)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(style.color)
            }

            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(style.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Spacer(minLength: 8)
                    if let ts = timestamp {
                        Text(ts, format: .relative(presentation: .named))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }

                if !detail.isEmpty {
                    Text(detail)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, 2)
    }

    // MARK: Field access (defensive — tolerate whatever ActivityEntry exposes)

    private var rawEvent: String {
        ActivityFieldReader.string(from: entry, keys: ["event", "kind", "type"]) ?? "event"
    }

    private var detail: String {
        ActivityFieldReader.string(from: entry, keys: ["message", "detail", "summary", "text", "title"]) ?? ""
    }

    private var timestamp: Date? {
        ActivityFieldReader.date(from: entry, keys: ["ts", "timestamp", "date", "time"])
    }

    private var style: EventStyle { EventStyle.from(event: rawEvent) }
}

// MARK: - Event styling

private struct EventStyle {
    let title: String
    let icon: String
    let color: Color

    static func from(event raw: String) -> EventStyle {
        switch raw.lowercased() {
        case "deploy":
            return EventStyle(title: "Deployed Position", icon: "arrow.up.forward.circle.fill", color: .green)
        case "close":
            return EventStyle(title: "Closed Position", icon: "checkmark.circle.fill", color: .blue)
        case "out_of_range", "out-of-range", "outofrange":
            return EventStyle(title: "Out of Range", icon: "exclamationmark.triangle.fill", color: .orange)
        case "briefing":
            return EventStyle(title: "Briefing", icon: "doc.text.fill", color: .purple)
        case "cycle:management", "cycle_management":
            return EventStyle(title: "Management Cycle", icon: "arrow.triangle.2.circlepath", color: .teal)
        case "cycle:screening", "cycle_screening":
            return EventStyle(title: "Screening Cycle", icon: "magnifyingglass.circle.fill", color: .indigo)
        default:
            let pretty = raw
                .replacingOccurrences(of: ":", with: " ")
                .replacingOccurrences(of: "_", with: " ")
                .capitalized
            return EventStyle(title: pretty.isEmpty ? "Event" : pretty,
                              icon: "bell.fill", color: .gray)
        }
    }
}

// MARK: - Connection indicator

struct ConnectionDot: View {
    let connected: Bool
    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(connected ? Color.green : Color.red)
                .frame(width: 9, height: 9)
            Text(connected ? "Live" : "Offline")
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - Reflection-based defensive field reader
//
// ActivityEntry is owned by Agent 1; its concrete field set is decided there.
// Rather than hard-binding to a property that may not exist (which would fail
// to compile against the real type), we read via Mirror so this view compiles
// and renders regardless of which of the common field names are present.

enum ActivityFieldReader {
    static func string(from value: Any, keys: [String]) -> String? {
        let mirror = Mirror(reflecting: value)
        for key in keys {
            for child in mirror.children where child.label == key {
                if let s = unwrapString(child.value), !s.isEmpty { return s }
            }
        }
        return nil
    }

    static func date(from value: Any, keys: [String]) -> Date? {
        let mirror = Mirror(reflecting: value)
        for key in keys {
            for child in mirror.children where child.label == key {
                if let d = unwrapDate(child.value) { return d }
            }
        }
        return nil
    }

    private static func unwrapString(_ any: Any) -> String? {
        let m = Mirror(reflecting: any)
        if m.displayStyle == .optional {
            guard let first = m.children.first else { return nil }
            return unwrapString(first.value)
        }
        if let s = any as? String { return s }
        return nil
    }

    private static func unwrapDate(_ any: Any) -> Date? {
        let m = Mirror(reflecting: any)
        if m.displayStyle == .optional {
            guard let first = m.children.first else { return nil }
            return unwrapDate(first.value)
        }
        if let d = any as? Date { return d }
        if let s = any as? String { return parseISO(s) }
        if let t = any as? Double { return Date(timeIntervalSince1970: t > 1_000_000_000_000 ? t / 1000 : t) }
        if let t = any as? Int { return Date(timeIntervalSince1970: Double(t) > 1_000_000_000_000 ? Double(t) / 1000 : Double(t)) }
        return nil
    }

    nonisolated(unsafe) private static let iso = ISO8601DateFormatter()
    nonisolated(unsafe) private static let isoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static func parseISO(_ s: String) -> Date? {
        isoFrac.date(from: s) ?? iso.date(from: s)
    }
}
