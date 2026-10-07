import AppKit
import ApplicationServices
import Foundation
import KanbanCore

/// 2 Activity capture (blueprint: .yeshwanth/blueprints/activity-tracking.md). Samples the
/// frontmost window every 5 s and appends closed spans to `<vault>/.activity/YYYYMMDD.jsonl`.
/// It records observations only; `BoardStore` turns the current context into moves.
@MainActor
final class ActivityMonitor {
  static let interval: TimeInterval = 5
  static let idleAfter: TimeInterval = 300

  /// Current context; nil while away (idle, locked, asleep).
  private(set) var context: Sample?
  /// When the current context began (for away: the last input or the sleep moment).
  private(set) var contextSince = Date()
  private(set) var rules: [ActivityRule] = []

  private var builder = SpanBuilder()
  private var timer: Timer?
  private var dir: URL?
  private var asleepSince: Date?
  private var rulesStamp: Date?

  func start(vault: URL) {
    guard timer == nil else { return }
    dir = vault.appendingPathComponent(".activity", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir!, withIntermediateDirectories: true)
    let ws = NSWorkspace.shared.notificationCenter
    for name in [NSWorkspace.willSleepNotification, NSWorkspace.screensDidSleepNotification, NSWorkspace.sessionDidResignActiveNotification] {
      ws.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in MainActor.assumeIsolated { self?.away(Date()) } }
    }
    DistributedNotificationCenter.default().addObserver(forName: .init("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.away(Date()) }
    }
    for name in [NSWorkspace.didWakeNotification, NSWorkspace.screensDidWakeNotification, NSWorkspace.sessionDidBecomeActiveNotification] {
      ws.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in MainActor.assumeIsolated { self?.asleepSince = nil } }
    }
    DistributedNotificationCenter.default().addObserver(forName: .init("com.apple.screenIsUnlocked"), object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.asleepSince = nil }
    }
    NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.write(self?.builder.close(at: Date())) }
    }
    timer = Timer.scheduledTimer(withTimeInterval: Self.interval, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.tick() }
    }
    tick()
  }

  private func away(_ since: Date) {
    if asleepSince == nil { asleepSince = since }
    setContext(nil, since: since)
    write(builder.close(at: since))
  }

  private func tick() {
    loadRules()
    let now = Date()
    if let since = asleepSince { return setContext(nil, since: since) }
    let idle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
    if idle >= Self.idleAfter {
      let since = now.addingTimeInterval(-idle)
      setContext(nil, since: since)
      write(builder.close(at: since))
      return
    }
    guard let sample = Probe.sample() else { return }
    setContext(sample, since: now)
    write(builder.add(sample, at: now))
  }

  private func setContext(_ sample: Sample?, since: Date) {
    guard sample != context else { return }
    context = sample
    contextSince = since
  }

  private func write(_ span: Span?) {
    guard let span, let dir else { return }
    let url = dir.appendingPathComponent(span.fileName)
    let line = Data((span.jsonLine + "\n").utf8)
    if let handle = try? FileHandle(forWritingTo: url) {
      defer { try? handle.close() }
      _ = try? handle.seekToEnd()
      try? handle.write(contentsOf: line)
    } else {
      try? line.write(to: url)
    }
  }

  /// Rereads `rules.json` when its modification date changes.
  private func loadRules() {
    guard let url = dir?.appendingPathComponent("rules.json") else { return }
    let stamp = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
    guard stamp != rulesStamp else { return }
    rulesStamp = stamp
    rules = ActivityRule.parse(try? Data(contentsOf: url))
  }
}

/// Reads the frontmost app, its focused window title (Accessibility), the browser tab URL
/// (Automation), and the active desktop from `DesktopStore`.
enum Probe {
  static let browsers: [String: String] = [
    "com.apple.Safari": #"tell application id "com.apple.Safari" to return URL of front document"#,
    "com.google.Chrome": #"tell application id "com.google.Chrome" to return URL of active tab of front window"#,
    "company.thebrowser.Browser": #"tell application id "company.thebrowser.Browser" to return URL of active tab of front window"#,
    "com.brave.Browser": #"tell application id "com.brave.Browser" to return URL of active tab of front window"#,
    "com.microsoft.edgemac": #"tell application id "com.microsoft.edgemac" to return URL of active tab of front window"#,
  ]

  @MainActor
  static func sample() -> Sample? {
    guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
    let bundle = app.bundleIdentifier ?? ""
    let desktops = DesktopStore.shared
    desktops.refresh()
    return Sample(app: app.localizedName ?? bundle, bundle: bundle, title: title(pid: app.processIdentifier),
                  url: browsers[bundle].flatMap(url), space: desktops.current?.number, desktop: desktops.current?.label)
  }

  static func title(pid: pid_t) -> String {
    let element = AXUIElementCreateApplication(pid)
    var window: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXFocusedWindowAttribute as CFString, &window) == .success,
          let window, CFGetTypeID(window) == AXUIElementGetTypeID() else { return "" }
    var title: CFTypeRef?
    guard AXUIElementCopyAttributeValue(window as! AXUIElement, kAXTitleAttribute as CFString, &title) == .success else { return "" }
    return title as? String ?? ""
  }

  @MainActor
  static func url(_ source: String) -> String? {
    var error: NSDictionary?
    let out = NSAppleScript(source: source)?.executeAndReturnError(&error).stringValue
    return error == nil ? out : nil
  }
}
