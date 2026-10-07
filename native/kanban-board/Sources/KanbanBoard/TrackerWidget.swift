import AppKit
import SwiftUI
import KanbanCore

/// Settings keys for the tracker widget (Settings > Widget).
enum WidgetKey {
  static let visible = "widget.visible"
  static let task = "widget.task", timer = "widget.timer", app = "widget.app"
  static let title = "widget.title", desktop = "widget.desktop", url = "widget.url"
  static let size = "widget.size", width = "widget.width"
}

/// Always-visible, transparent panel that shows what is being tracked right now: the Doing
/// card(s) with time since they entered Doing, and the current app, window, desktop, and URL.
/// Empty pixels pass clicks through; drag the text to move it. The frame persists.
@MainActor
final class TrackerWidget {
  private let panel: NSPanel
  private var observer: NSObjectProtocol?

  init(store: BoardStore) {
    panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 360, height: 60),
                    styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.level = .statusBar
    panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.hidesOnDeactivate = false
    // Fixed frame, no SwiftUI window sizing: `.preferredContentSize` made NSHostingView resize the
    // panel inside its own windowDidLayout, an infinite recursion when Mission Control opened.
    let host = DragHostingView(rootView: WidgetView().environmentObject(store).environmentObject(store.activity)
      .environmentObject(store.desktops))
    host.sizingOptions = []
    panel.contentView = host
    if !panel.setFrameUsingName("TrackerWidget"), let screen = NSScreen.main {
      panel.setFrameTopLeftPoint(NSPoint(x: screen.visibleFrame.midX - 180, y: screen.visibleFrame.maxY - 8))
    }
    panel.setFrameAutosaveName("TrackerWidget")
    defer { applySize() }
    UserDefaults.standard.register(defaults: [WidgetKey.visible: true, WidgetKey.task: true, WidgetKey.timer: true,
      WidgetKey.app: true, WidgetKey.title: true, WidgetKey.desktop: true, WidgetKey.url: false,
      WidgetKey.size: 13.0, WidgetKey.width: 360.0])
    observer = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.applySize(); self?.applyVisibility() }
    }
    applyVisibility()
  }

  /// Transparent area: width from settings, height for a few tasks plus the activity lines.
  private func applySize() {
    let width = UserDefaults.standard.double(forKey: WidgetKey.width)
    let size = UserDefaults.standard.double(forKey: WidgetKey.size)
    let target = NSSize(width: width, height: (size * 1.6 * 8).rounded())
    guard panel.frame.size != target else { return }
    let top = panel.frame.maxY
    panel.setFrame(NSRect(x: panel.frame.minX, y: top - target.height, width: target.width, height: target.height), display: true)
  }

  var isVisible: Bool { UserDefaults.standard.bool(forKey: WidgetKey.visible) }

  func toggle() { UserDefaults.standard.set(!isVisible, forKey: WidgetKey.visible) }

  private func applyVisibility() {
    if isVisible { if !panel.isVisible { panel.orderFrontRegardless() } } else if panel.isVisible { panel.orderOut(nil) }
  }
}

struct WidgetView: View {
  @EnvironmentObject var store: BoardStore
  @EnvironmentObject var activity: ActivityMonitor
  @EnvironmentObject var desktops: DesktopStore
  @AppStorage(WidgetKey.task) private var showTask = true
  @AppStorage(WidgetKey.timer) private var showTimer = true
  @AppStorage(WidgetKey.app) private var showApp = true
  @AppStorage(WidgetKey.title) private var showTitle = true
  @AppStorage(WidgetKey.desktop) private var showDesktop = true
  @AppStorage(WidgetKey.url) private var showURL = false
  @AppStorage(WidgetKey.size) private var size = 13.0
  @AppStorage(WidgetKey.width) private var width = 360.0
  @State private var toast: [DoingChange] = []
  @State private var hover = false

  private var doing: [Card] {
    store.columns.filter { $0.name.caseInsensitiveCompare("Doing") == .orderedSame }.flatMap(\.cards)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      if showTask {
        if doing.isEmpty {
          line("Nothing in Doing", weight: .semibold, dim: true)
        }
        ForEach(doing) { card in
          HStack(spacing: 8) {
            Text(card.title).font(.system(size: size, weight: .semibold)).lineLimit(1)
            Spacer(minLength: 4)
            if showTimer, let since = card.since {
              TimelineView(.periodic(from: .now, by: 1)) { ctx in
                Text(Self.clock(ctx.date.timeIntervalSince(since))).font(.system(size: size, weight: .semibold).monospacedDigit())
              }
            }
          }
        }
      }
      if let c = activity.context {
        let parts = [showDesktop ? (c.desktop ?? c.space.map { "Desktop \($0)" }) : nil, showApp ? c.app : nil].compactMap { $0 }
        if !parts.isEmpty { line(parts.joined(separator: " · "), dim: true) }
        if showTitle, !c.title.isEmpty { line(c.title, dim: true) }
        if showURL, let url = c.url { line(url, dim: true) }
      } else if showApp || showTitle {
        line("Away", dim: true)
      }
    }
    .foregroundStyle(.white)
    .shadow(color: .black.opacity(0.9), radius: 1.5, y: 0.5)
    .padding(.horizontal, 10).padding(.vertical, 6)
    // Near-zero alpha keeps the widget invisible but makes the whole text block grabbable;
    // fully clear pixels would pass the mouse through to the window below.
    .background(RoundedRectangle(cornerRadius: 9).fill(Color.white.opacity(hover ? 0.08 : 0.001)))
    .onHover { hover = $0 }
    .frame(width: width, alignment: .leading)
    .overlay { if !toast.isEmpty { ToastCover(changes: toast, size: size) } }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .animation(.spring(duration: 0.25), value: toast)
    .onChange(of: store.widgetToast?.gen) {
      guard let t = store.widgetToast else { return }
      toast = t.changes
      let gen = t.gen
      Task {
        try? await Task.sleep(for: .seconds(2.5))
        if store.widgetToast?.gen == gen { toast = [] }
      }
    }
  }

  private func line(_ text: String, weight: Font.Weight = .regular, dim: Bool = false) -> some View {
    Text(text).font(.system(size: size * 0.85, weight: weight)).lineLimit(1).truncationMode(.middle)
      .opacity(dim ? 0.8 : 1)
  }

  /// 0:42, 12:05, 1:02:09
  static func clock(_ t: TimeInterval) -> String {
    let s = max(0, Int(t)), h = s / 3600, m = s / 60 % 60, sec = s % 60
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
  }
}

/// Covers the whole widget while a Doing change is announced.
struct ToastCover: View {
  let changes: [DoingChange]
  let size: Double
  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      ForEach(Array(changes.prefix(3).enumerated()), id: \.offset) { _, c in
        HStack(spacing: 6) {
          Text(c.verb).font(.system(size: size, weight: .bold)).foregroundStyle(color(c.verb))
          Text(c.title).font(.system(size: size, weight: .semibold)).lineLimit(1)
        }
      }
    }
    .foregroundStyle(.white)
    .padding(.horizontal, 10)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 9).fill(Color.black.opacity(0.88)))
    .transition(.opacity)
  }

  private func color(_ verb: String) -> Color {
    switch verb.lowercased() {
    case "started": .green
    case "parked", "idle": .orange
    case "done": .blue
    default: .gray
    }
  }
}

/// Hosting view that drags the panel from a mouse-down anywhere on the content.
/// `isMovableByWindowBackground` with `mouseDownCanMoveWindow` did not move a non-activating
/// panel; `performDrag(with:)` starts the window-server move directly. The widget has no
/// controls, so taking every hit is safe.
final class DragHostingView<Content: View>: NSHostingView<Content> {
  override func hitTest(_ point: NSPoint) -> NSView? { super.hitTest(point) == nil ? nil : self }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
}
