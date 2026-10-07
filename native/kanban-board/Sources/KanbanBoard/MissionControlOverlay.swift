import AppKit
import ApplicationServices
import ScreenCaptureKit
import SwiftUI
import Vision
import KanbanCore

/// Draws desktop names over the "Desktop N" labels in Mission Control.
/// macOS cannot rename those labels without injecting into the Dock (SIP off), and on this macOS
/// the Dock's Mission Control AX group (`id=mc`) exposes no children. So the `mc` group only
/// signals "open"; label positions come from reading the top of the screen (ScreenCaptureKit,
/// own windows excluded) with Vision text recognition. Main display only. Needs Screen Recording.
@MainActor
final class MissionControlOverlay {
  static let interval: TimeInterval = 0.25
  static let rescan: TimeInterval = 0.4
  /// Top share of the screen that holds the Spaces bar.
  static let strip: CGFloat = 0.35

  private var timer: Timer?
  private var panels: [NSPanel] = []
  private let desktops = DesktopStore.shared
  private var scanning = false
  private var lastScan = Date.distantPast
  private var open = false

  func start() {
    guard timer == nil else { return }
    timer = Timer.scheduledTimer(withTimeInterval: Self.interval, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.update() }
    }
  }

  private func update() {
    let isOpen = desktops.spaces.contains(where: { $0.label != nil }) && Self.missionControlOpen()
    guard isOpen else {
      if open { open = false; hide() }
      return
    }
    open = true
    guard !scanning, Date().timeIntervalSince(lastScan) >= Self.rescan else { return }
    scanning = true
    Task {
      let found = await Self.scan()
      scanning = false
      lastScan = Date()
      guard open, !found.isEmpty else { return }
      // Main display only: Mission Control numbers each display's desktops from 1.
      show(found.compactMap { n, frame in
        desktops.spaces.first(where: { $0.display == 0 && $0.local == n })?.label.map { ($0, frame) }
      })
    }
  }

  static func missionControlOpen() -> Bool {
    guard let dock = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first else { return false }
    return AX.children(AXUIElementCreateApplication(dock.processIdentifier)).contains {
      AX.string($0, kAXIdentifierAttribute) == "mc"
    }
  }

  /// "Desktop N" text boxes on the main display, in AppKit screen coordinates.
  static func scan() async -> [(Int, CGRect)] {
    guard let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true),
          let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) else { return [] }
    let me = content.applications.filter { $0.processID == ProcessInfo.processInfo.processIdentifier }
    let filter = SCContentFilter(display: display, excludingApplications: me, exceptingWindows: [])
    let config = SCStreamConfiguration()
    let w = CGFloat(display.width), h = CGFloat(display.height) * strip
    config.sourceRect = CGRect(x: 0, y: 0, width: w, height: h)
    config.width = Int(w * 2)
    config.height = Int(h * 2)
    config.showsCursor = false
    guard let image = try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) else { return [] }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .fast
    request.usesLanguageCorrection = false
    try? VNImageRequestHandler(cgImage: image).perform([request])
    let screenH = CGFloat(display.height)
    return (request.results ?? []).compactMap { obs in
      guard let text = obs.topCandidates(1).first?.string,
            let m = text.trimmingCharacters(in: .whitespaces).wholeMatch(of: #/Desktop\s*(\d+)/#), let n = Int(m.1) else { return nil }
      let bb = obs.boundingBox  // normalized, bottom-left origin within the strip
      let top = (1 - bb.maxY) * h  // from the screen top, in points
      return (n, CGRect(x: bb.minX * w, y: screenH - (top + bb.height * h), width: bb.width * w, height: bb.height * h))
    }
  }

  private func show(_ marks: [(String, CGRect)]) {
    while panels.count < marks.count { panels.append(Self.panel()) }
    for (i, panel) in panels.enumerated() {
      guard i < marks.count else { panel.orderOut(nil); continue }
      let (label, text) = marks[i]
      // Cover the original text with a margin; widen for long names.
      let width = max(text.width + 24, CGFloat(label.count) * 10 + 24)
      panel.setFrame(NSRect(x: text.midX - width / 2, y: text.minY - 4, width: width, height: text.height + 8), display: false)
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
    let host = NSHostingView(rootView: NameTag(text: ""))
    host.sizingOptions = []  // the frame comes from the recognized text; SwiftUI must not resize the panel
    p.contentView = host
    return p
  }
}

struct NameTag: View {
  var text: String
  var body: some View {
    Text(text)
      .font(.system(size: 17, weight: .medium))
      .lineLimit(1)
      .minimumScaleFactor(0.6)
      .foregroundStyle(.white)
      .padding(.horizontal, 10)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Capsule().fill(Color.black.opacity(0.8)))
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
}
