import AppKit
import CoreAudio
import EventKit
import Foundation
import KanbanCore

/// Calendar meetings (EventKit): Outlook shows up once its account is added in System Settings >
/// Internet Accounts. Only calendars mapped to an org (Settings > Tracking) make meeting cards, and only
/// for calls in the apps the calendar names.
@MainActor
final class CalendarSource: ObservableObject {
  static let shared = CalendarSource()
  /// JSON `[calendarIdentifier: org]`.
  static let orgsKey = "tracking.calendarOrgs"

  let store = EKEventStore()
  @Published private(set) var access = EKEventStore.authorizationStatus(for: .event)
  @Published private(set) var calendars: [EKCalendar] = []

  private init() { if access == .fullAccess { load() } }

  func requestAccess() {
    store.requestFullAccessToEvents { _, _ in
      Task { @MainActor in
        self.access = EKEventStore.authorizationStatus(for: .event)
        if self.access == .fullAccess { self.load() }
      }
    }
  }

  func load() {
    store.refreshSourcesIfNecessary()
    calendars = store.calendars(for: .event).sorted { ($0.source.title, $0.title) < ($1.source.title, $1.title) }
    loadToday()
  }

  static var orgs: [String: String] {
    get {
      UserDefaults.standard.data(forKey: orgsKey).flatMap { try? JSONDecoder().decode([String: String].self, from: $0) } ?? [:]
    }
    set { UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: orgsKey) }
  }

  /// JSON `[calendarIdentifier: [CallApp]]`; a calendar with no entry uses Teams.
  static let appsKey = "tracking.calendarApps"

  static var apps: [String: Set<CallApp>] {
    get {
      UserDefaults.standard.data(forKey: appsKey).flatMap { try? JSONDecoder().decode([String: Set<CallApp>].self, from: $0) } ?? [:]
    }
    set { UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: appsKey) }
  }

  static func apps(_ calendar: String) -> Set<CallApp> { apps[calendar] ?? [.teams] }

  /// Org of impromptu Slack huddles (no calendar event); empty is off.
  static let slackOrgKey = "tracking.slackOrg"

  /// `MeetingTracker.tick`'s impromptu map: Slack -> its org when set.
  static var impromptu: [CallApp: String] {
    let org = UserDefaults.standard.string(forKey: slackOrgKey) ?? ""
    return org.isEmpty ? [:] : [.slack: org]
  }

  /// Today's timed events on calendars mapped to an org, past and upcoming (`loadToday`); the Timeline,
  /// the board strip and the widget show them. An event with no call apps still shows.
  @Published private(set) var today: [MeetingEvent] = []

  func loadToday(now: Date = Date()) {
    let start = Calendar.current.startOfDay(for: now)
    let fresh = fetch(from: start, to: Calendar.current.date(byAdding: .day, value: 1, to: start) ?? now)
      .sorted { ($0.start, $0.title) < ($1.start, $1.title) }
    if fresh != today { today = fresh }
  }

  /// Meetings around `now` that a call can hold: those with at least one call app.
  func events(around now: Date) -> [MeetingEvent] {
    let pad = MeetingTracker.late + 3600
    return fetch(from: now.addingTimeInterval(-pad), to: now.addingTimeInterval(pad)).filter { !$0.apps.isEmpty }
  }

  /// Timed events between `from` and `to` on calendars mapped to an org, each with the call apps it can be held in.
  private func fetch(from: Date, to: Date) -> [MeetingEvent] {
    let orgs = Self.orgs
    guard access == .fullAccess, !orgs.isEmpty else { return [] }
    let cals = store.calendars(for: .event).filter { orgs[$0.calendarIdentifier] != nil }
    guard !cals.isEmpty else { return [] }
    let predicate = store.predicateForEvents(withStart: from, end: to, calendars: cals)
    return store.events(matching: predicate).compactMap { e in
      let cal = e.calendar.calendarIdentifier
      guard !e.isAllDay, let org = orgs[cal] else { return nil }
      let apps = CallApp.apps([e.url?.absoluteString, e.location, e.notes], allowed: Self.apps(cal))
      let id = e.calendarItemExternalIdentifier ?? e.calendarItemIdentifier
      return MeetingEvent(id: id, title: e.title ?? "Meeting", org: org, start: e.startDate, end: e.endDate, apps: apps)
    }
  }
}

/// Calls by app: a process of the app records from a microphone (Teams keeps the input open while
/// muted). Google Meet runs in a browser, so a recording browser counts as Meet. Where macOS gives no
/// per-process audio list, a recording default input counts for every call app that is running.
enum CallDetector {
  /// Bundle id prefixes per app; Safari records in its WebKit GPU process.
  static let bundles: [CallApp: [String]] = [
    .teams: ["com.microsoft.teams"],
    .zoom: ["us.zoom."],
    .meet: Probe.browsers.keys.sorted() + ["com.apple.WebKit.GPU"],
    .slack: ["com.tinyspeck.slackmacgap"],
  ]

  static func app(_ bundle: String) -> CallApp? {
    bundles.first { $0.value.contains { bundle.hasPrefix($0) } }?.key
  }

  static var calls: Set<CallApp> {
    guard let processes = audioProcesses() else {
      guard defaultInputRunning() else { return [] }
      return Set(NSWorkspace.shared.runningApplications.compactMap { $0.bundleIdentifier.flatMap(app) })
    }
    return Set(processes.filter { flag($0, kAudioProcessPropertyIsRunningInput) }.compactMap { bundle($0).flatMap(app) })
  }

  private static func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  }

  private static func audioProcesses() -> [AudioObjectID]? {
    var addr = address(kAudioHardwarePropertyProcessObjectList)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr, size > 0 else { return nil }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return nil }
    return ids
  }

  private static func bundle(_ id: AudioObjectID) -> String? {
    var addr = address(kAudioProcessPropertyBundleID)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr else { return nil }
    return value?.takeRetainedValue() as String?
  }

  private static func flag(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> Bool {
    var addr = address(selector)
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr && value != 0
  }

  private static func defaultInputRunning() -> Bool {
    var addr = address(kAudioHardwarePropertyDefaultInputDevice)
    var device: AudioDeviceID = 0
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &device) == noErr else { return false }
    return flag(device, kAudioDevicePropertyDeviceIsRunningSomewhere)
  }
}
