import AppKit
import ApplicationServices
import Combine
import Foundation
import KanbanCore

/// 2 Activity capture (blueprint: .yeshwanth/blueprints/activity-tracking.md). Samples the
/// frontmost window every 5 s and appends closed spans to `<vault>/.activity/YYYYMMDD.jsonl`.
/// It records observations only; `BoardStore` turns the current context into moves.
@MainActor
final class ActivityMonitor: ObservableObject {
  static let interval: TimeInterval = 5
  static let idleAfter: TimeInterval = 300

  /// Current context; nil while away (idle, locked, asleep).
  @Published private(set) var context: Sample?
  /// When the current context began (for away: the last input or the sleep moment).
  private(set) var contextSince = Date()
  @Published private(set) var rules: [ActivityRule] = []

  private var builder = SpanBuilder()
  private var timer: Timer?
  /// `<vault>/.activity`, set by `start`.
  private(set) var dir: URL?
  private var asleepSince: Date?
  /// Today's logged seconds per desktop (`ActivityLog.desktopSeconds`) and the log file they cover.
  private var dayDesktops: [String: TimeInterval] = [:]
  /// Today's logged spans, for idle gaps (`idleToday`).
  private var daySpans: [Span] = []
  private var dayFile = ""
  private var rulesStamp: Date?

  func start(vault: URL) {
    guard timer == nil else { return }
    dir = vault.appendingPathComponent(".activity", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir!, withIntermediateDirectories: true)
    dayFile = Span.fileName(Date())
    daySpans = (try? Data(contentsOf: dir!.appendingPathComponent(dayFile))).map(ActivityLog.parse) ?? []
    dayDesktops = ActivityLog.desktopSeconds(daySpans)
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

  /// The span still being recorded (not yet in the log file), for live views.
  var openSpan: Span? { builder.open }

  /// Idle stretches of today from `from` to `now`: gaps of at least `idleAfter` with no span, the open span included.
  func idleToday(from: Date, now: Date) -> [(Date, Date)] {
    var spans = Span.fileName(now) == dayFile ? daySpans : []
    if var open = openSpan { open.end = now; spans.append(open) }
    return ActivityLog.idle(spans, from: from, now: now, minGap: Self.idleAfter)
  }

  /// Today's seconds on the current desktop and on all desktops, the open span included; nil while away.
  func desktopToday(at now: Date) -> (here: TimeInterval, all: TimeInterval)? {
    guard let c = context, let key = Desktops.key(uuid: c.uuid, space: c.space) else { return nil }
    var totals = Span.fileName(now) == dayFile ? dayDesktops : [:]
    if let open = openSpan, let k = Desktops.key(uuid: open.uuid, space: open.space) {
      totals[k, default: 0] += max(0, now.timeIntervalSince(max(open.start, Calendar.current.startOfDay(for: now))))
    }
    return (totals[key] ?? 0, totals.values.reduce(0, +))
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
    guard let (sample, incognito) = Probe.sample() else { return }
    // Incognito windows are never logged: the open span ends, and switch rules see the app without its title or URL.
    if incognito {
      setContext(Sample(app: sample.app, bundle: sample.bundle, title: "", space: sample.space, desktop: sample.desktop, uuid: sample.uuid), since: now)
      write(builder.close(at: now))
      return
    }
    setContext(sample, since: now)
    write(builder.add(sample, at: now))
  }

  private func setContext(_ sample: Sample?, since: Date) {
    guard sample != context else { return }
    context = sample
    contextSince = since
  }

  private func write(_ span: Span?) {
    guard let span else { return }
    append(span.jsonLine, to: span.fileName)
    if span.fileName != dayFile { (dayFile, dayDesktops, daySpans) = (span.fileName, [:], []) }
    daySpans.append(span)
    for (k, v) in ActivityLog.desktopSeconds([span]) { dayDesktops[k, default: 0] += v }
  }

  /// Logs a finished stretch or break, one line per local day it touches.
  func record<T: DayLine>(_ line: T) {
    for piece in ActivityLog.splitByDay(line) { append(piece.jsonLine, to: piece.fileName) }
  }

  private func append(_ text: String, to fileName: String) {
    guard let dir else { return }
    let url = dir.appendingPathComponent(fileName)
    let line = Data((text + "\n").utf8)
    if let handle = try? FileHandle(forWritingTo: url) {
      defer { try? handle.close() }
      _ = try? handle.seekToEnd()
      try? handle.write(contentsOf: line)
    } else {
      try? line.write(to: url)
    }
  }

  /// Writes `rules.json` (Settings > Tracking) and applies it at once.
  func saveRules(_ new: [ActivityRule]) {
    guard let url = dir?.appendingPathComponent("rules.json") else { return }
    try? ActivityRule.encode(new).write(to: url, options: .atomic)
    rules = new
    rulesStamp = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
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
/// (Automation), and the active desktop from `DesktopStore`. Chromium browsers and Arc report an
/// incognito front window (`mode`) as `incognito` instead of a URL; Safari has no scripting property for private windows.
enum Probe {
  static let incognito = "kb:incognito"
  static let browsers: [String: String] = [
    "com.apple.Safari": #"tell application id "com.apple.Safari" to return URL of front document"#,
    "com.google.Chrome": chromium("com.google.Chrome"),
    "company.thebrowser.Browser": chromium("company.thebrowser.Browser"),
    "com.brave.Browser": chromium("com.brave.Browser"),
    "com.microsoft.edgemac": chromium("com.microsoft.edgemac"),
  ]

  private static func chromium(_ id: String) -> String {
    """
    tell application id "\(id)"
    if mode of front window is "incognito" then return "\(incognito)"
    return URL of active tab of front window
    end tell
    """
  }

  @MainActor
  static func sample() -> (Sample, incognito: Bool)? {
    guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
    let bundle = app.bundleIdentifier ?? ""
    let desktops = DesktopStore.shared
    desktops.refresh()
    let link = browsers[bundle].flatMap(url)
    let sample = Sample(app: app.localizedName ?? bundle, bundle: bundle, title: link == incognito ? "" : title(pid: app.processIdentifier),
                        url: link == incognito ? nil : link, space: desktops.current?.number, desktop: desktops.current?.label,
                        uuid: desktops.current?.uuid)
    return (sample, link == incognito)
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
