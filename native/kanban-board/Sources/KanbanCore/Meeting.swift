import Foundation

/// An app that holds calls; a calendar names the ones its meetings use (Settings > Tracking).
public enum CallApp: String, Codable, CaseIterable, Sendable {
  case teams, zoom, meet, slack

  public var label: String {
    switch self { case .teams: "Teams"; case .zoom: "Zoom"; case .meet: "Google Meet"; case .slack: "Slack" }
  }
  /// The host of the app's join links (a Slack huddle link is app.slack.com/huddle/...).
  public var link: String {
    switch self { case .teams: "teams.microsoft.com"; case .zoom: "zoom.us"; case .meet: "meet.google.com"; case .slack: "slack.com/huddle" }
  }

  /// The apps whose join link is in the URL, location or notes.
  /// ```
  /// ["https://teams.microsoft.com/l/meetup-join/..."] -> [teams]
  /// ["Room 4", nil]                                   -> []
  /// ```
  public static func linked(_ texts: [String?]) -> Set<CallApp> {
    Set(allCases.filter { app in texts.contains { $0?.localizedCaseInsensitiveContains(app.link) == true } })
  }

  /// The apps an event on a calendar that allows `allowed` can be held in: its linked apps among the
  /// allowed ones, or every allowed app when the event has no link.
  /// ```
  /// linked [meet], allowed [teams, zoom] -> []
  /// linked [],     allowed [teams, zoom] -> [teams, zoom]
  /// ```
  public static func apps(_ texts: [String?], allowed: Set<CallApp>) -> Set<CallApp> {
    let found = linked(texts)
    return found.isEmpty ? allowed : found.intersection(allowed)
  }
}

/// One occurrence of a calendar event (EventKit), reduced to what a meeting card needs.
public struct MeetingEvent: Equatable, Codable, Sendable {
  /// Occurrence key: the event's external id plus its start, so each repeat of a series is its own card.
  public var key: String
  public var title: String
  public var org: String
  public var start: Date, end: Date
  /// The apps a call for this event runs in.
  public var apps: Set<CallApp>

  public init(id: String, title: String, org: String, start: Date, end: Date, apps: Set<CallApp>) {
    key = "\(id)@\(Int(start.timeIntervalSince1970))"
    (self.title, self.org, self.start, self.end, self.apps) = (title, org, start, end, apps)
  }
}

extension MeetingEvent {
  /// The running meeting, else the next one today: what the widget and board strip lead with.
  /// ```
  /// 10:00-10:30, 11:00-11:30 at 10:10 -> 10:00; at 10:40 -> 11:00; at 11:40 -> nil
  /// ```
  public static func next(_ events: [MeetingEvent], now: Date) -> MeetingEvent? {
    events.filter { $0.end > now }.min { ($0.start, $0.end) < ($1.start, $1.end) }
  }

  /// A short clock relation to `now`: "in 25m", "now · 12m left", "ended".
  public func when(_ now: Date) -> String {
    if now >= end { return "ended" }
    let mins = { (t: TimeInterval) in Int((t / 60).rounded(.up)) }
    func span(_ m: Int) -> String { m < 60 ? "\(m)m" : "\(m / 60)h" + (m % 60 == 0 ? "" : " \(m % 60)m") }
    return now >= start ? "now · \(span(mins(end.timeIntervalSince(now)))) left" : "in \(span(mins(start.timeIntervalSince(now))))"
  }
}

/// Meeting cards: while a call runs in one of a meeting's apps, that meeting has its own card in Doing;
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
  /// The apps of the running call's event.
  private var currentApps: Set<CallApp> = []
  /// Start of the running impromptu call; fixes its occurrence key across ticks.
  private var impromptuStart: Date?

  /// Event id of impromptu calls: a call with no calendar event (a Slack huddle).
  public static let impromptuID = "impromptu"

  public init() {}

  /// The meeting a call at `now` belongs to: the latest-starting event whose padded window holds `now`.
  public static func pick(_ events: [MeetingEvent], now: Date) -> MeetingEvent? {
    events.filter { $0.start.addingTimeInterval(-early) <= now && now < $0.end.addingTimeInterval(late) }
      .max { $0.start < $1.start }
  }

  /// `calls`: the apps that record from a microphone now.
  /// ```
  /// Teams call starts in Teams event A  -> [create A]
  /// Meet call during Teams-only event A -> []
  /// call silent for grace               -> [finish A]
  /// call again in A                     -> [resume A]
  /// call moves into back-to-back B      -> [finish A, create B]
  /// ```
  ///
  /// `impromptu`: app -> org for calls with no calendar event; such a call is its own meeting from its start.
  /// ```
  /// Slack call, no Slack event, impromptu [slack: Org] -> [create "Slack huddle"]
  /// Slack call during an event with a Slack link        -> [create that event]
  /// ```
  public mutating func tick(now: Date, calls: Set<CallApp>, events: [MeetingEvent], impromptu: [CallApp: String] = [:]) -> [Action] {
    var events = events
    let scheduled = Self.pick(events.filter { !$0.apps.isDisjoint(with: calls) }, now: now) != nil
    if !scheduled, let (app, org) = impromptu.sorted(by: { $0.key.rawValue < $1.key.rawValue }).first(where: { calls.contains($0.key) }) {
      let start = impromptuStart ?? now
      impromptuStart = start
      events.append(MeetingEvent(id: Self.impromptuID, title: "\(app.label) huddle", org: org, start: start, end: now, apps: [app]))
    }
    let actions = step(now: now, calls: calls, events: events)
    if current?.hasPrefix(Self.impromptuID + "@") != true { impromptuStart = nil }
    return actions
  }

  private mutating func step(now: Date, calls: Set<CallApp>, events: [MeetingEvent]) -> [Action] {
    let live = events.filter { !$0.apps.isDisjoint(with: calls) }
    let holding = current != nil && !currentApps.isDisjoint(with: calls)
    guard holding || Self.pick(live, now: now) != nil else {
      guard let key = current else { return [] }
      let since = quietSince ?? now
      quietSince = since
      guard now.timeIntervalSince(since) >= Self.grace else { return [] }
      (current, quietSince, currentApps) = (nil, nil, [])
      return files[key].map { [.finish(file: $0)] } ?? []
    }
    quietSince = nil
    guard let event = Self.pick(live, now: now), event.key != current else { return [] }
    var actions = current.flatMap { files[$0] }.map { [Action.finish(file: $0)] } ?? []
    actions.append(files[event.key].map { .resume(file: $0) } ?? .create(event))
    (current, currentApps) = (event.key, event.apps)
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
