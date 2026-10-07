import AppKit
import SwiftUI
import KanbanCore

/// Settings keys for the tracker widget (Settings > Widget).
enum WidgetKey {
  static let visible = "widget.visible"
  static let task = "widget.task", timer = "widget.timer", app = "widget.app"
  static let title = "widget.title", desktop = "widget.desktop", url = "widget.url"
  static let size = "widget.size", width = "widget.width"
  static let color = "widget.color", font = "widget.font"
}

/// Widget font and colour from settings. An empty family means the system font.
enum WidgetStyle {
  static func font(_ family: String, _ size: Double, _ weight: Font.Weight) -> Font {
    family.isEmpty ? .system(size: size, weight: weight) : .custom(family, size: size).weight(weight)
  }

  static func color(_ hex: String) -> Color {
    guard let c = Hex.rgba(hex) else { return .white }
    return Color(.sRGB, red: c.r, green: c.g, blue: c.b, opacity: c.a)
  }

  static func hex(_ color: Color) -> String {
    let n = NSColor(color).usingColorSpace(.sRGB) ?? .white
    return Hex.string(r: n.redComponent, g: n.greenComponent, b: n.blueComponent, a: n.alphaComponent)
  }
}

/// Always-visible, transparent panel that shows what is being tracked right now: the Doing
/// card(s) with time since they entered Doing, and the current app, window, desktop, and URL.
/// Clicks pass through; holding Cmd over the widget arms it (highlight) so it can be dragged.
/// The frame persists.
@MainActor
final class TrackerWidget {
  private let panel: NSPanel
  private var observer: NSObjectProtocol?
  private var monitors: [Any] = []
  let grip = WidgetGrip()

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
      .environmentObject(store.desktops).environmentObject(grip))
    host.sizingOptions = []
    panel.contentView = host
    if !panel.setFrameUsingName("TrackerWidget"), let screen = NSScreen.main {
      panel.setFrameTopLeftPoint(NSPoint(x: screen.visibleFrame.midX - 180, y: screen.visibleFrame.maxY - 8))
    }
    panel.setFrameAutosaveName("TrackerWidget")
    defer { applySize() }
    UserDefaults.standard.register(defaults: [WidgetKey.visible: true, WidgetKey.task: true, WidgetKey.timer: true,
      WidgetKey.app: true, WidgetKey.title: true, WidgetKey.desktop: true, WidgetKey.url: false,
      WidgetKey.size: 13.0, WidgetKey.width: 240.0, WidgetKey.color: "#FFFFFF", WidgetKey.font: ""])
    observer = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.applySize(); self?.applyVisibility() }
    }
    applyVisibility()
    panel.ignoresMouseEvents = true
    // Global monitors see events aimed at other apps (the usual case, since the widget ignores the
    // mouse); local monitors see them while the widget itself is grabbed.
    let mask: NSEvent.EventTypeMask = [.flagsChanged, .mouseMoved, .leftMouseUp]
    if let g = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] _ in
      MainActor.assumeIsolated { self?.updateGrip() }
    }) { monitors.append(g) }
    if let l = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { [weak self] e in
      MainActor.assumeIsolated { self?.updateGrip() }
      return e
    }) { monitors.append(l) }
  }

  /// Armed = Cmd held with the pointer over the widget; only then does it take the mouse.
  private func updateGrip() {
    let armed = panel.isVisible && NSEvent.modifierFlags.contains(.command) && panel.frame.contains(NSEvent.mouseLocation)
    guard armed != grip.armed else { return }
    grip.armed = armed
    panel.ignoresMouseEvents = !armed
  }

  /// The panel is always a square of the Width setting, so the grab area, highlight, toast,
  /// and window bounds are the same rectangle. Content that does not fit is clipped.
  private func applySize() {
    let side = UserDefaults.standard.double(forKey: WidgetKey.width)
    let target = NSSize(width: side, height: side)
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
  @AppStorage(WidgetKey.width) private var width = 240.0
  @AppStorage(WidgetKey.color) private var color = "#FFFFFF"
  @AppStorage(WidgetKey.font) private var family = ""
  @State private var toast: [DoingChange] = []
  @EnvironmentObject var grip: WidgetGrip

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
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(card.title).font(WidgetStyle.font(family, size, .semibold)).lineLimit(2)
            Spacer(minLength: 4)
            if showTimer, let since = card.since {
              TimelineView(.periodic(from: .now, by: 1)) { ctx in
                Text(Self.clock(ctx.date.timeIntervalSince(since))).font(WidgetStyle.font(family, size, .semibold).monospacedDigit())
              }
            }
          }
        }
      }
      if let c = activity.context {
        let parts = [showDesktop ? (c.desktop ?? c.space.map { "Desktop \($0)" }) : nil, showApp ? c.app : nil].compactMap { $0 }
        if !parts.isEmpty { line(parts.joined(separator: " · "), dim: true) }
        if showTitle, !c.title.isEmpty { line(c.title, dim: true, lines: 2) }
        if showURL, let url = c.url { line(url, dim: true) }
      } else if showApp || showTitle {
        line("Away", dim: true)
      }
    }
    .foregroundStyle(WidgetStyle.color(color))
    .shadow(color: .black.opacity(0.9), radius: 1.5, y: 0.5)
    .padding(.horizontal, 10).padding(.vertical, 8)
    .frame(width: width, height: width, alignment: .topLeading)
    .clipped()
    // Near-zero alpha keeps the square invisible but grabbable when armed;
    // fully clear pixels would pass the mouse through to the window below.
    .background(RoundedRectangle(cornerRadius: 4).fill(Color.white.opacity(grip.armed ? 0.08 : 0.001)))
    .overlay { if !toast.isEmpty { ToastCover(changes: toast, size: size, family: family) } }
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

  private func line(_ text: String, weight: Font.Weight = .regular, dim: Bool = false, lines: Int = 1) -> some View {
    Text(text).font(WidgetStyle.font(family, size * 0.85, weight)).lineLimit(lines).truncationMode(.middle)
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
  let family: String
  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      ForEach(Array(changes.prefix(3).enumerated()), id: \.offset) { _, c in
        HStack(spacing: 6) {
          Text(c.verb).font(WidgetStyle.font(family, size, .bold)).foregroundStyle(color(c.verb))
          Text(c.title).font(WidgetStyle.font(family, size, .semibold)).lineLimit(2)
        }
      }
    }
    .foregroundStyle(.white)
    .padding(.horizontal, 10)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 4).fill(Color.black.opacity(0.88)))
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

/// Whether the widget currently takes the mouse (Cmd held over it).
@MainActor
final class WidgetGrip: ObservableObject {
  @Published var armed = false
}
