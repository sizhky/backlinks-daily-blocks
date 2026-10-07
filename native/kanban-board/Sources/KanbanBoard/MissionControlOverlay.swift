import AppKit
import ApplicationServices
import SwiftUI
import KanbanCore

/// Draws desktop names over the "Desktop N" buttons in Mission Control's Spaces bar.
/// macOS cannot rename those labels without injecting into the Dock (SIP off), so this reads
/// the Dock's Accessibility tree for the button frames and floats a name panel over each one.
@MainActor
final class MissionControlOverlay {
  static let interval: TimeInterval = 0.25
  private var timer: Timer?
  private var panels: [NSPanel] = []
  private let desktops = DesktopStore.shared

  func start() {
    guard timer == nil else { return }
    timer = Timer.scheduledTimer(withTimeInterval: Self.interval, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.update() }
    }
  }

  private func update() {
    guard desktops.spaces.contains(where: { $0.label != nil }),
          let dock = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first,
          let mc = AX.children(AXUIElementCreateApplication(dock.processIdentifier)).first(where: AX.isMissionControl)
    else { return hide() }
    var marks: [(String, CGRect)] = []
    for (display, group) in AX.children(mc).enumerated() {
      for (local, frame) in AX.desktopButtons(in: group, depth: 0) {
        guard let space = desktops.spaces.first(where: { $0.display == display && $0.local == local }), let label = space.label else { continue }
        marks.append((label, frame))
      }
    }
    show(marks)
  }

  private func show(_ marks: [(String, CGRect)]) {
    while panels.count < marks.count { panels.append(Self.panel()) }
    let top = NSScreen.screens.first?.frame.maxY ?? 0
    for (i, panel) in panels.enumerated() {
      guard i < marks.count else { panel.orderOut(nil); continue }
      let (label, ax) = marks[i]
      let h = min(ax.height, 22)
      // AX frames are top-left based on the primary screen; AppKit is bottom-left.
      panel.setFrame(NSRect(x: ax.minX, y: top - ax.maxY, width: ax.width, height: h), display: false)
      (panel.contentView as? NSHostingView<NameTag>)?.rootView = NameTag(text: label)
      panel.orderFrontRegardless()
    }
  }

  private func hide() { for p in panels where p.isVisible { p.orderOut(nil) } }

  private static func panel() -> NSPanel {
    let p = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
    p.level = NSWindow.Level(rawValue: Int(CGShieldingWindowLevel()))
    p.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
    p.ignoresMouseEvents = true
    p.isOpaque = false
    p.backgroundColor = .clear
    p.hasShadow = false
    p.contentView = NSHostingView(rootView: NameTag(text: ""))
    return p
  }
}

struct NameTag: View {
  var text: String
  var body: some View {
    Text(text)
      .font(.system(size: 12, weight: .semibold))
      .lineLimit(1)
      .foregroundStyle(.white)
      .padding(.horizontal, 8)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Capsule().fill(Color.black.opacity(0.85)))
  }
}

enum AX {
  static func attr(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
  }

  static func children(_ e: AXUIElement) -> [AXUIElement] {
    attr(e, kAXChildrenAttribute) as? [AXUIElement] ?? []
  }

  static func string(_ e: AXUIElement, _ name: String) -> String? { attr(e, name) as? String }

  static func isMissionControl(_ e: AXUIElement) -> Bool {
    string(e, kAXIdentifierAttribute) == "mc" || string(e, kAXTitleAttribute) == "Mission Control"
  }

  static func frame(_ e: AXUIElement) -> CGRect? {
    guard let p = attr(e, kAXPositionAttribute), let s = attr(e, kAXSizeAttribute) else { return nil }
    var point = CGPoint.zero, size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
  }

  /// `Desktop N` buttons under a display group, as (N, frame).
  static func desktopButtons(in e: AXUIElement, depth: Int) -> [(Int, CGRect)] {
    guard depth < 6 else { return [] }
    var out: [(Int, CGRect)] = []
    for child in children(e) {
      let title = string(child, kAXTitleAttribute) ?? string(child, kAXDescriptionAttribute) ?? ""
      if string(child, kAXRoleAttribute) == kAXButtonRole as String, let m = title.wholeMatch(of: #/Desktop (\d+)/#),
         let n = Int(m.1), let f = frame(child) {
        out.append((n, f))
      } else {
        out += desktopButtons(in: child, depth: depth + 1)
      }
    }
    return out
  }
}
