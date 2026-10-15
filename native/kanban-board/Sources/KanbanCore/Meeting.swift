import Foundation

/// One occurrence of a calendar event (EventKit), reduced to what a meeting card needs.
public struct MeetingEvent: Equatable, Codable, Sendable {
  /// Occurrence key: the event's external id plus its start, so each repeat of a series is its own card.
  public var key: String
  public var title: String
  public var org: String
  public var start: Date, end: Date

  public init(id: String, title: String, org: String, start: Date, end: Date) {
    key = "\(id)@\(Int(start.timeIntervalSince1970))"
    (self.title, self.org, self.start, self.end) = (title, org, start, end)
  }

  /// A Teams meeting carries its join link in the URL, location or notes.
  /// ```
  /// ["https://teams.microsoft.com/l/meetup-join/..."] -> true
  /// ["Room 4", nil]                                   -> false
  /// ```
  public static func isTeams(_ texts: [String?]) -> Bool {
    texts.contains { $0?.localizedCaseInsensitiveContains("teams.microsoft.com") == true }
  }
}

/// Meeting cards: while a Teams call runs, the current calendar meeting has its own card in Doing;
/// the card goes to Done once the call has been silent for `grace` seconds.
public struct MeetingTracker: Codable, Equatable, Sendable {
  public enum Action: Equatable, Sendable {
    /// Create the meeting's card in Doing.
    case create(MeetingEvent)
    /// Move the meeting's existing card back to Doing (rejoined call).
    case resume(file: String)
    /// Move the meeting's card to Done.
    case finish(file: String)
  }

  /// A call may start before the meeting and run past it.
  public static let early: TimeInterval = 5 * 60, late: TimeInterval = 15 * 60
  /// Seconds without a call before the card leaves Doing; a dropped connection keeps the card.
  public static let grace: TimeInterval = 60

  /// The event key of the running call.
  public private(set) var current: String?
  /// Event key -> card note file (each meeting card is its own note).
  public private(set) var files: [String: String] = [:]
  private var quietSince: Date?

  public init() {}

  /// The meeting a call at `now` belongs to: the latest-starting event whose padded window holds `now`.
  public static func pick(_ events: [MeetingEvent], now: Date) -> MeetingEvent? {
    events.filter { $0.start.addingTimeInterval(-early) <= now && now < $0.end.addingTimeInterval(late) }
      .max { $0.start < $1.start }
  }

  /// ```
  /// call starts in event A          -> [create A]
  /// call silent for grace           -> [finish A]
  /// call again in A                 -> [resume A]
  /// call moves into back-to-back B  -> [finish A, create B]
  /// ```
  public mutating func tick(now: Date, inCall: Bool, events: [MeetingEvent]) -> [Action] {
    guard inCall else {
      guard let key = current else { return [] }
      let since = quietSince ?? now
      quietSince = since
      guard now.timeIntervalSince(since) >= Self.grace else { return [] }
      (current, quietSince) = (nil, nil)
      return files[key].map { [.finish(file: $0)] } ?? []
    }
    quietSince = nil
    guard let event = Self.pick(events, now: now), event.key != current else { return [] }
    var actions = current.flatMap { files[$0] }.map { [Action.finish(file: $0)] } ?? []
    actions.append(files[event.key].map { .resume(file: $0) } ?? .create(event))
    current = event.key
    return actions
  }

  /// Records the note a `create` made; drops entries for meetings that started over two days ago.
  public mutating func record(_ key: String, file: String, now: Date) {
    files[key] = file
    files = files.filter { k, _ in
      k.split(separator: "@").last.flatMap { Double($0) }.map { now.timeIntervalSince1970 - $0 < 2 * 86_400 } ?? false
    }
  }
}
