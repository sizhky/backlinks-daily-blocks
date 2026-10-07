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
  /// `design` applies to the system font only; a chosen family keeps its own design.
  static func font(_ family: String, _ size: Double, _ weight: Font.Weight, design: Font.Design = .default) -> Font {
    family.isEmpty ? .system(size: size, weight: weight, design: design) : .custom(family, size: size).weight(weight)
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

  /// Doing cards, most recently started first: the hero is the task you switched to last.
  private var doing: [Card] {
    store.columns.filter { $0.name.caseInsensitiveCompare("Doing") == .orderedSame }.flatMap(\.cards)
      .sorted { ($0.since ?? .distantPast) > ($1.since ?? .distantPast) }
  }

  /// One scale for the whole widget, from the Text size setting (13 = Apple's small-widget body).
  private var unit: Double { size }
  private var margin: Double { width * 0.07 }
  private var corner: Double { width * 0.12 }
  private var tint: Color { WidgetStyle.color(color) }

  var body: some View {
    VStack(spacing: 0) {
      header
      Spacer(minLength: unit * 0.4)
      hero
      Spacer(minLength: unit * 0.4)
      footer
    }
    .multilineTextAlignment(.center)
    .foregroundStyle(tint)
    .shadow(color: .black.opacity(0.55), radius: 2, y: 1)
    .padding(margin)
    .frame(width: width, height: width)
    .clipped()
    // Near-zero alpha keeps the square invisible but grabbable when armed;
    // fully clear pixels would pass the mouse through to the window below.
    .background(RoundedRectangle(cornerRadius: corner, style: .continuous)
      .fill(Color.white.opacity(grip.armed ? 0.1 : 0.001)))
    .overlay {
      if !toast.isEmpty {
        ToastCover(changes: toast, unit: unit, family: family, corner: corner)
          .transition(.opacity.combined(with: .scale(scale: 0.96)))
      }
    }
    .animation(.spring(duration: 0.3, bounce: 0.15), value: toast)
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

  /// Where you are: desktop name, or Away.
  @ViewBuilder private var header: some View {
    if let c = activity.context {
      if showDesktop, let name = c.desktop ?? c.space.map({ "Desktop \($0)" }) {
        Label(name, systemImage: "rectangle.3.group")
          .font(WidgetStyle.font(family, unit * 0.78, .semibold))
          .labelStyle(.titleAndIcon).lineLimit(1).opacity(0.75)
      }
    } else {
      Label("Away", systemImage: "moon.fill")
        .font(WidgetStyle.font(family, unit * 0.78, .semibold)).opacity(0.75)
    }
  }

  /// What is being tracked: the timer as the one glanceable number, the task under it.
  @ViewBuilder private var hero: some View {
    if showTask, let card = doing.first {
      VStack(spacing: unit * 0.25) {
        if showTimer, let since = card.since {
          TimelineView(.periodic(from: .now, by: 1)) { ctx in
            Text(Self.clock(ctx.date.timeIntervalSince(since)))
              .font(WidgetStyle.font(family, unit * 2.6, .semibold, design: .rounded).monospacedDigit())
              .lineLimit(1).minimumScaleFactor(0.6)
              .contentTransition(.numericText())
          }
        }
        Text(card.title)
          .font(WidgetStyle.font(family, unit, .semibold))
          .lineLimit(2)
        if doing.count > 1 {
          Text("+\(doing.count - 1) more")
            .font(WidgetStyle.font(family, unit * 0.72, .medium)).opacity(0.6)
        }
      }
    } else if showTask {
      VStack(spacing: unit * 0.35) {
        Image(systemName: "circle.dashed").font(.system(size: unit * 2, weight: .light))
        Text("Not tracking").font(WidgetStyle.font(family, unit, .semibold))
      }
      .opacity(0.7)
    }
  }

  /// Context, quieter: app, then window title or address.
  @ViewBuilder private var footer: some View {
    if let c = activity.context {
      VStack(spacing: 1) {
        if showApp { Text(c.app).font(WidgetStyle.font(family, unit * 0.8, .semibold)).lineLimit(1) }
        if showTitle, !c.title.isEmpty, c.title != c.app {
          Text(c.title).font(WidgetStyle.font(family, unit * 0.75, .regular)).lineLimit(1).truncationMode(.middle)
        }
        if showURL, let url = c.url {
          Text(url).font(WidgetStyle.font(family, unit * 0.7, .regular)).lineLimit(1).truncationMode(.middle)
        }
      }
      .opacity(0.65)
    }
  }

  /// 0:42, 12:05, 1:02:09
  static func clock(_ t: TimeInterval) -> String {
    let s = max(0, Int(t)), h = s / 3600, m = s / 60 % 60, sec = s % 60
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
  }
}

/// Covers the whole widget while a Doing change is announced: symbol, verb, task.
struct ToastCover: View {
  let changes: [DoingChange]
  let unit: Double
  let family: String
  let corner: Double

  /// A start leads; otherwise the first change.
  private var lead: DoingChange { changes.first { $0.verb == "Started" } ?? changes[0] }

  var body: some View {
    VStack(spacing: unit * 0.35) {
      Image(systemName: symbol(lead.verb))
        .font(.system(size: unit * 2.2, weight: .semibold))
        .foregroundStyle(color(lead.verb))
        .symbolRenderingMode(.hierarchical)
      Text(lead.verb).font(WidgetStyle.font(family, unit * 0.85, .semibold)).foregroundStyle(color(lead.verb))
      Text(lead.title).font(WidgetStyle.font(family, unit, .semibold)).lineLimit(3)
      if changes.count > 1 {
        Text("+\(changes.count - 1) more").font(WidgetStyle.font(family, unit * 0.72, .medium)).opacity(0.6)
      }
    }
    .multilineTextAlignment(.center)
    .foregroundStyle(.white)
    .padding(unit)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(.ultraThickMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
    .environment(\.colorScheme, .dark)
  }

  private func symbol(_ verb: String) -> String {
    switch verb.lowercased() {
    case "started": "play.circle.fill"
    case "parked", "idle": "pause.circle.fill"
    case "done": "checkmark.circle.fill"
    case "cancelled": "xmark.circle.fill"
    default: "arrow.right.circle.fill"
    }
  }

  private func color(_ verb: String) -> Color {
    switch verb.lowercased() {
    case "started": .green
    case "parked", "idle": .orange
    case "done": .blue
    case "cancelled": .red
    default: .secondary
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
