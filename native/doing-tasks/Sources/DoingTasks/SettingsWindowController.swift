import AppKit
import SwiftUI

@MainActor
final class SettingsWindowController {
  private var controller: NSWindowController?

  func show(store: TaskStore) {
    if controller == nil {
      let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 360, height: 130),
        styleMask: [.titled, .closable],
        backing: .buffered,
        defer: false
      )
      window.title = "Doing Tasks Settings"
      window.center()
      window.isReleasedWhenClosed = false
      window.contentViewController = NSHostingController(rootView: SettingsView(store: store))
      controller = NSWindowController(window: window)
    }
    NSApp.activate(ignoringOtherApps: true)
    controller?.showWindow(nil)
    controller?.window?.makeKeyAndOrderFront(nil)
  }
}

private struct SettingsView: View {
  @ObservedObject var store: TaskStore

  var body: some View {
    Form {
      Stepper(
        "Recent tasks: \(store.recentHours) hours",
        value: Binding(get: { store.recentHours }, set: { store.setRecentHours($0) }),
        in: 1...168
      )
      Text("Applies to every section except Doing.")
        .font(.caption)
        .foregroundStyle(.secondary)
    }
    .padding(20)
    .frame(width: 360, height: 130)
  }
}
