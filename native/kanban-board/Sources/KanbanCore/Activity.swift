import Foundation

/// 2.1 One observation of the frontmost window (blueprint: .yeshwanth/blueprints/activity-tracking.md).
public struct Sample: Equatable, Sendable {
  public var app: String, bundle: String, title: String
  public var url: String?
  public var space: Int?
  /// Desktop name from the label store, when the desktop has one.
  public var desktop: String?
  public init(app: String, bundle: String, title: String, url: String? = nil, space: Int? = nil, desktop: String? = nil) {
    self.app = app; self.bundle = bundle; self.title = title; self.url = url; self.space = space; self.desktop = desktop
  }
}

/// 2.4 A closed run of equal samples: one JSON line in `<vault>/.activity/YYYYMMDD.jsonl`.
public struct Span: Codable, Equatable, Sendable {
  public var start: Date, end: Date
  public var app: String, bundle: String, title: String
  public var url: String?
  public var space: Int?
  public var desktop: String?

  /// ```
  /// {"app":"iTerm2","bundle":"com.googlecode.iterm2","end":"2026-10-07T05:10:00Z","space":2,"start":"2026-10-07T05:00:00Z","title":"penguin:api"}
  /// ```
  public var jsonLine: String {
    let e = JSONEncoder()
    e.dateEncodingStrategy = .iso8601
    e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return (try? String(decoding: e.encode(self), as: UTF8.self)) ?? ""
  }

  /// Log file name of the day the span starts, local time.
  public var fileName: String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyyMMdd"
    return f.string(from: start) + ".jsonl"
  }
}

/// 2.1 Merges equal consecutive samples into spans; spans shorter than `minimum` are dropped.
/// ```
/// add(A, 0) add(A, 5) add(B, 10) -> returns Span(A, 0...10)
/// ```
public struct SpanBuilder: Sendable {
  public static let minimum: TimeInterval = 5
  public private(set) var open: Span?
  public init() {}

  /// Records `sample` seen at `at`; returns the span that a different sample closes.
  public mutating func add(_ sample: Sample, at: Date) -> Span? {
    if var o = open, o.app == sample.app, o.bundle == sample.bundle, o.title == sample.title,
       o.url == sample.url, o.space == sample.space, o.desktop == sample.desktop {
      o.end = at
      open = o
      return nil
    }
    let closed = close(at: at)
    open = Span(start: at, end: at, app: sample.app, bundle: sample.bundle, title: sample.title, url: sample.url, space: sample.space, desktop: sample.desktop)
    return closed
  }

  /// Ends the open span at `at` (away, sleep, quit). The end never moves before the last sample.
  public mutating func close(at: Date) -> Span? {
    guard var o = open else { return nil }
    open = nil
    o.end = max(o.end, min(at, Date.distantFuture))
    return o.end.timeIntervalSince(o.start) >= Self.minimum ? o : nil
  }
}

/// 4.1 Maps observed context to a scope. Every given condition must match; app is a bundle id or
/// app name, title and url are case-insensitive regular expressions.
/// ```
/// {"project": "PenguinAI", "title": "penguin"}       iTerm title "penguin:api" -> PenguinAI cards
/// {"org": "Divami", "url": "divami\\.atlassian"}      Jira tab -> Divami cards
/// ```
public struct ActivityRule: Codable, Equatable, Sendable {
  public var app: String?, title: String?, url: String?
  public var space: Int?
  public var project: String?, org: String?

  public init(app: String? = nil, title: String? = nil, url: String? = nil, space: Int? = nil, project: String? = nil, org: String? = nil) {
    self.app = app; self.title = title; self.url = url; self.space = space; self.project = project; self.org = org
  }

  public func matches(_ s: Sample) -> Bool {
    guard app != nil || title != nil || url != nil || space != nil else { return false }
    if let app, app.caseInsensitiveCompare(s.bundle) != .orderedSame, app.caseInsensitiveCompare(s.app) != .orderedSame { return false }
    if let space, space != s.space { return false }
    if let title, s.title.range(of: title, options: [.regularExpression, .caseInsensitive]) == nil { return false }
    if let url, (s.url ?? "").range(of: url, options: [.regularExpression, .caseInsensitive]) == nil { return false }
    return true
  }

  func covers(_ card: Card) -> Bool {
    (project.map { p in card.projects.contains { $0.caseInsensitiveCompare(p) == .orderedSame } } ?? false)
      || (org.map { o in card.orgs.contains { $0.caseInsensitiveCompare(o) == .orderedSame } } ?? false)
  }

  /// Rules from `rules.json` (a JSON array); malformed data gives none.
  public static func parse(_ data: Data?) -> [ActivityRule] {
    data.flatMap { try? JSONDecoder().decode([ActivityRule].self, from: $0) } ?? []
  }
}

public struct SwitchMove: Equatable, Sendable {
  public let ref: String, title: String, column: String, at: Date
}

/// 4.1 Debounced task switching. A card has affinity when it has a desktop or a rule names its
/// project or org. Leaving its context parks it, stamped at the moment of leaving; returning
/// resumes it, but only when the engine parked it. Cards without affinity are never touched.
public struct SwitchEngine: Codable, Sendable {
  public var startAfter: TimeInterval = 10
  public var stopAfter: TimeInterval = 120
  /// Card ids (`Card.id`) the engine parked and may resume.
  public private(set) var parked: Set<String> = []
  struct Flip: Codable, Sendable { var owned: Bool; var since: Date; var acted: Bool }
  var flips: [String: Flip] = [:]

  public init() {}

  /// Whether the card belongs to the current context; nil when the context cannot tell
  /// (desktop-only card while the Space probe fails) or the card has no affinity.
  static func owns(_ card: Card, _ context: Sample?, _ rules: [ActivityRule]) -> Bool? {
    let ruled = rules.filter { $0.covers(card) }
    guard card.desktop != nil || !ruled.isEmpty else { return nil }
    guard let context else { return false }
    if ruled.contains(where: { $0.matches(context) }) { return true }
    if let d = card.desktop {
      guard let hit = Desktops.matches(d, number: context.space, label: context.desktop) else { return ruled.isEmpty ? nil : false }
      return hit
    }
    return false
  }

  /// `context` nil means away (idle, locked, asleep); `contextSince` is when it began.
  public mutating func step(now: Date, context: Sample?, contextSince: Date, cards: [Card], rules: [ActivityRule],
                            live: String = "Doing", paused: String = "Parked") -> [SwitchMove] {
    var moves: [SwitchMove] = []
    var seen = Set<String>()
    for card in cards {
      seen.insert(card.id)
      let inLive = card.col.caseInsensitiveCompare(live) == .orderedSame
      let inPaused = card.col.caseInsensitiveCompare(paused) == .orderedSame
      if parked.contains(card.id), !inLive, !inPaused { parked.remove(card.id) }
      guard let owned = Self.owns(card, context, rules) else { continue }
      if flips[card.id]?.owned != owned { flips[card.id] = Flip(owned: owned, since: contextSince, acted: false) }
      guard var f = flips[card.id], !f.acted else { continue }
      let held = now.timeIntervalSince(f.since)
      if inLive, !owned, held >= stopAfter {
        moves.append(SwitchMove(ref: card.ref, title: card.title, column: paused, at: f.since))
        parked.insert(card.id)
        f.acted = true
      } else if inPaused, owned, parked.contains(card.id), held >= startAfter {
        moves.append(SwitchMove(ref: card.ref, title: card.title, column: live, at: f.since))
        parked.remove(card.id)
        f.acted = true
      }
      flips[card.id] = f
    }
    flips = flips.filter { seen.contains($0.key) }
    return moves
  }
}
