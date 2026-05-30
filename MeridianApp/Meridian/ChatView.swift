//
//  ChatView.swift
//  Meridian
//
//  Chat UI bound to store.chat. Sends free-form chat (store.sendChat) and
//  quick slash-commands (store.runCommand): /status /briefing /thresholds
//  /learn /evolve.
//

import SwiftUI

struct ChatView: View {
    @EnvironmentObject private var store: AppStore

    @State private var draft: String = ""
    @FocusState private var inputFocused: Bool

    private let quickCommands: [String] = ["/status", "/briefing", "/thresholds", "/learn", "/evolve"]

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                messageList
                Divider()
                quickCommandBar
                inputBar
            }
            .navigationTitle("Chat")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    ConnectionDot(connected: store.connected)
                }
            }
        }
    }

    // MARK: Messages

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if store.chat.isEmpty {
                        emptyState
                            .frame(maxWidth: .infinity)
                            .padding(.top, 60)
                    } else {
                        ForEach(store.chat) { line in
                            ChatBubble(line: line)
                                .id(line.id)
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: store.chat.count) { _, _ in
                guard let last = store.chat.last else { return }
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(last.id, anchor: .bottom)
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 40))
                .foregroundStyle(.secondary)
            Text("Talk to the Agent")
                .font(.headline)
            Text(store.connected
                 ? "Ask anything, or tap a quick command below."
                 : "Not connected. You can still type — messages send once connected.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
    }

    // MARK: Quick commands

    private var quickCommandBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(quickCommands, id: \.self) { cmd in
                    Button {
                        store.runCommand(cmd)
                    } label: {
                        Text(cmd)
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .background(Color.accentColor.opacity(0.14), in: Capsule())
                            .foregroundStyle(Color.accentColor)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
        }
    }

    // MARK: Input

    private var inputBar: some View {
        HStack(spacing: 10) {
            TextField("Message the agent…", text: $draft, axis: .vertical)
                .lineLimit(1...5)
                .textFieldStyle(.plain)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20))
                .focused($inputFocused)
                .submitLabel(.send)
                .onSubmit(send)

            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(canSend ? Color.accentColor : Color.secondary)
            }
            .disabled(!canSend)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        if text.hasPrefix("/") {
            store.runCommand(text)
        } else {
            store.sendChat(text)
        }
        draft = ""
    }
}

// MARK: - Bubble

private struct ChatBubble: View {
    let line: ChatLine

    var body: some View {
        HStack {
            if isUser { Spacer(minLength: 40) }

            VStack(alignment: isUser ? .trailing : .leading, spacing: 3) {
                Text(text.isEmpty ? " " : text)
                    .font(.callout)
                    .foregroundStyle(isUser ? Color.white : Color.primary)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(
                        isUser ? AnyShapeStyle(Color.accentColor)
                               : AnyShapeStyle(Color(.secondarySystemBackground)),
                        in: RoundedRectangle(cornerRadius: 16)
                    )

                if let ts = timestamp {
                    Text(ts, format: .dateTime.hour().minute())
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 4)
                }
            }

            if !isUser { Spacer(minLength: 40) }
        }
    }

    // MARK: Defensive field access (ChatLine owned by Agent 1)

    private var text: String {
        ActivityFieldReader.string(from: line, keys: ["text", "message", "content", "body"]) ?? ""
    }

    private var timestamp: Date? {
        ActivityFieldReader.date(from: line, keys: ["ts", "timestamp", "date", "time"])
    }

    /// Determine sender. Prefer an explicit role/sender/isUser flag; fall back to
    /// treating it as an agent message.
    private var isUser: Bool {
        if let flag = ActivityFieldReader.bool(from: line, keys: ["isUser", "fromUser", "mine", "outgoing"]) {
            return flag
        }
        if let role = ActivityFieldReader.string(from: line, keys: ["role", "sender", "from", "author", "kind"]) {
            let r = role.lowercased()
            return r == "user" || r == "me" || r == "self" || r == "you" || r == "outgoing"
        }
        return false
    }
}

// MARK: - Bool reader extension

extension ActivityFieldReader {
    static func bool(from value: Any, keys: [String]) -> Bool? {
        let mirror = Mirror(reflecting: value)
        for key in keys {
            for child in mirror.children where child.label == key {
                if let b = unwrapBool(child.value) { return b }
            }
        }
        return nil
    }

    private static func unwrapBool(_ any: Any) -> Bool? {
        let m = Mirror(reflecting: any)
        if m.displayStyle == .optional {
            guard let first = m.children.first else { return nil }
            return unwrapBool(first.value)
        }
        if let b = any as? Bool { return b }
        return nil
    }
}
