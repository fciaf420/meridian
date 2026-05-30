//
//  MeridianApp.swift
//  Meridian
//
//  App entry point. Hosts a single @StateObject AppStore and injects it into
//  the view hierarchy via .environmentObject. Connects on launch.
//

import SwiftUI

@main
struct MeridianApp: App {
    @StateObject private var store = AppStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .task {
                    // Attempt to connect on launch. If no backend is reachable
                    // the client retries with backoff and the UI shows a
                    // "not connected" state — the app never crashes.
                    store.connect()
                }
        }
    }
}
