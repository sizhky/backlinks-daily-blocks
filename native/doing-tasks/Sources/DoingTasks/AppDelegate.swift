import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  private let panel: any PanelPresenting
  private let store: TaskStore

  init(panel: any PanelPresenting = StatusPanelController(), store: TaskStore = TaskStore()) {
    self.panel = panel
    self.store = store
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    panel.install(store: store)
    panel.show()
  }

  func applicationShouldHandleReopen(
    _ sender: NSApplication,
    hasVisibleWindows flag: Bool
  ) -> Bool {
    panel.show()
    return false
  }
}
