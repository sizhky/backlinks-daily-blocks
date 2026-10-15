import AppKit
import CoreAudio
import EventKit
import Foundation
import KanbanCore

/// Calendar meetings (EventKit): Outlook shows up once its account is added in System Settings >
/// Internet Accounts. Only calendars mapped to an org (Settings > Tracking) make meeting cards.
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
  }

  static var orgs: [String: String] {
    get {
      UserDefaults.standard.data(forKey: orgsKey).flatMap { try? JSONDecoder().decode([String: String].self, from: $0) } ?? [:]
    }
    set { UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: orgsKey) }
  }

  /// Teams meetings around `now` on calendars mapped to an org.
  func events(around now: Date) -> [MeetingEvent] {
    let orgs = Self.orgs
    guard access == .fullAccess, !orgs.isEmpty else { return [] }
    let cals = store.calendars(for: .event).filter { orgs[$0.calendarIdentifier] != nil }
    guard !cals.isEmpty else { return [] }
    let pad = MeetingTracker.late + 3600
    let predicate = store.predicateForEvents(withStart: now.addingTimeInterval(-pad), end: now.addingTimeInterval(pad), calendars: cals)
    return store.events(matching: predicate).compactMap { e in
      guard !e.isAllDay, let org = orgs[e.calendar.calendarIdentifier],
            MeetingEvent.isTeams([e.url?.absoluteString, e.location, e.notes]) else { return nil }
      let id = e.calendarItemExternalIdentifier ?? e.calendarItemIdentifier
      return MeetingEvent(id: id, title: e.title ?? "Meeting", org: org, start: e.startDate, end: e.endDate)
    }
  }
}

/// A Teams call: Teams is running and a Teams process records from a microphone (Teams keeps the
/// input open while muted). Where macOS gives no per-process audio list, any recording input counts.
enum CallDetector {
  static let bundlePrefix = "com.microsoft.teams"

  static var inCall: Bool {
    guard NSWorkspace.shared.runningApplications.contains(where: { $0.bundleIdentifier?.hasPrefix(bundlePrefix) == true }) else { return false }
    guard let processes = audioProcesses() else { return defaultInputRunning() }
    return processes.contains { bundle($0)?.hasPrefix(bundlePrefix) == true && flag($0, kAudioProcessPropertyIsRunningInput) }
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
