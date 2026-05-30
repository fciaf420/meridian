//
//  ContentView.swift
//  Meridian
//
//  Root TabView. The five tab view bodies (DashboardView, PoolsView,
//  ActivityView, ChatView, SettingsView) are implemented by the other agents.
//  This file wires them into a TabView and injects the shared AppStore.
//

import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        TabView {
            DashboardView()
                .tabItem { Label("Dashboard", systemImage: "chart.line.uptrend.xyaxis") }

            PoolsView()
                .tabItem { Label("Pools", systemImage: "drop.fill") }

            ActivityView()
                .tabItem { Label("Activity", systemImage: "bell.fill") }

            ChatView()
                .tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right.fill") }

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
        }
    }
}
