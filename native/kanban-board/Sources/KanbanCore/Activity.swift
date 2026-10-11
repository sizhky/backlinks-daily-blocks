import Foundation

/// 2.1 One observation of the frontmost window (blueprint: .yeshwanth/blueprints/activity-tracking.md).
public struct Sample: Equatable, Sendable {
  public var app: String, bundle: String, title: String
  public var url: String?
  public var space: Int?
  /// Desktop name from the label store, when the desktop has one.
  public var desktop: String?
  /// Space UUID (`DesktopSpace.uuid`): stays with the desktop when numbers shift.
  public var uuid: String?
  public init(app: String, bundle: String, title: String, url: String? = nil, space: Int? = nil, desktop: String? = nil,
              uuid: String? = nil) {
    self.app = app; self.bundle = bundle; self.title = title; self.url = url; self.space = space; self.desktop = desktop
    self.uuid = uuid
  }
}

/// 2.4 A closed run of equal samples: one JSON line in `<vault>/.activity/YYYYMMDD.jsonl`.
public struct Span: Codable, Equatable, Sendable {
  public var start: Date, end: Date
  public var app: String, bundle: String, title: String
  public var url: String?
  public var space: Int?
  public var desktop: String?
  public var uuid: String?

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
  public var fileName: String { Self.fileName(start) }

  public static func fileName(_ day: Date) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyyMMdd"
    return f.string(from: day) + ".jsonl"
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
       o.url == sample.url, o.space == sample.space, o.desktop == sample.desktop, o.uuid == sample.uuid {
      o.end = at
      open = o
      return nil
    }
    let closed = close(at: at)
    open = Span(start: at, end: at, app: sample.app, bundle: sample.bundle, title: sample.title, url: sample.url, space: sample.space, desktop: sample.desktop,
                uuid: sample.uuid)
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
/// app name, title and url are case-insensitive regular expressions, desktop is a card-style
/// desktop reference (number 1-9 or name, `Desktops.matches`).
/// ```
/// {"project": "PenguinAI", "title": "penguin"}       iTerm title "penguin:api" -> PenguinAI cards
/// {"org": "Divami", "url": "divami\\.atlassian"}      Jira tab -> Divami cards
/// {"project": "PenguinAI", "desktop": "PenguinAI"}   Settings > Tracking desktop row
/// ```
public struct ActivityRule: Codable, Equatable, Sendable {
  public var app: String?, title: String?, url: String?
  public var space: Int?
  public var desktop: String?
  public var project: String?, org: String?

  public init(app: String? = nil, title: String? = nil, url: String? = nil, space: Int? = nil, desktop: String? = nil,
              project: String? = nil, org: String? = nil) {
    self.app = app; self.title = title; self.url = url; self.space = space; self.desktop = desktop
    self.project = project; self.org = org
  }

  public func matches(_ s: Sample) -> Bool {
    guard app != nil || title != nil || url != nil || space != nil || desktop != nil else { return false }
    if let app, app.caseInsensitiveCompare(s.bundle) != .orderedSame, app.caseInsensitiveCompare(s.app) != .orderedSame { return false }
    if let space, space != s.space { return false }
    if let desktop, Desktops.matches(desktop, number: s.space, label: s.desktop) != true { return false }
    if let title, s.title.range(of: title, options: [.regularExpression, .caseInsensitive]) == nil { return false }
    if let url, (s.url ?? "").range(of: url, options: [.regularExpression, .caseInsensitive]) == nil { return false }
    return true
  }

  /// A desktop rule pins a scope to a desktop (`desktop` or `space`).
  var pinsDesktop: Bool { desktop != nil || space != nil }

  func covers(orgs: [String], projects: [String]) -> Bool {
    (project.map { p in projects.contains { $0.caseInsensitiveCompare(p) == .orderedSame } } ?? false)
      || (org.map { o in orgs.contains { $0.caseInsensitiveCompare(o) == .orderedSame } } ?? false)
  }

  /// Rules that apply to a scope. The most specific desktop wins: a card desktop drops every
  /// desktop rule, a project desktop rule drops org desktop rules. Other rules always apply.
  /// ```
  /// card desktop 2, rules [project P -> 3, org O -> 4, org O url jira] -> [org O url jira]
  /// no card desktop, same rules                                     -> [project P -> 3, org O url jira]
  /// ```
  static func applying(_ rules: [ActivityRule], desktop: String?, orgs: [String], projects: [String]) -> [ActivityRule] {
    let ruled = rules.filter { $0.covers(orgs: orgs, projects: projects) }
    if desktop != nil { return ruled.filter { !$0.pinsDesktop } }
    let projectPin = ruled.contains { $0.pinsDesktop && $0.project != nil }
    return projectPin ? ruled.filter { !($0.pinsDesktop && $0.project == nil) } : ruled
  }

  /// Rules from `rules.json` (a JSON array); malformed data gives none.
  public static func parse(_ data: Data?) -> [ActivityRule] {
    data.flatMap { try? JSONDecoder().decode([ActivityRule].self, from: $0) } ?? []
  }

  public static func encode(_ rules: [ActivityRule]) -> Data {
    let e = JSONEncoder()
    e.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    return (try? e.encode(rules)) ?? Data("[]".utf8)
  }
}

/// A Settings > Tracking row: an org or project pinned to a desktop. Stored as a plain
/// `{org|project, desktop}` rule in `rules.json`; other rules in the file are kept as they are.
public struct DesktopPin: Equatable, Sendable, Identifiable {
  public enum Kind: String, Sendable { case org, project }
  public var kind: Kind, name: String, desktop: String
  public var id: String { kind.rawValue + "\t" + name.lowercased() }
  public init(kind: Kind, name: String, desktop: String) { self.kind = kind; self.name = name; self.desktop = desktop }

  var rule: ActivityRule {
    ActivityRule(desktop: desktop, project: kind == .project ? name : nil, org: kind == .org ? name : nil)
  }

  init?(_ r: ActivityRule) {
    guard let d = r.desktop, r.app == nil, r.title == nil, r.url == nil, r.space == nil else { return nil }
    switch (r.org, r.project) {
    case let (o?, nil): self.init(kind: .org, name: o, desktop: d)
    case let (nil, p?): self.init(kind: .project, name: p, desktop: d)
    default: return nil
    }
  }

  public static func pins(_ rules: [ActivityRule]) -> [DesktopPin] { rules.compactMap(DesktopPin.init) }

  /// The desktop a card lands on: its own `kbdesktop`, else its project's pin, else its org's pin
  /// (the precedence of `ActivityRule.applying`).
  /// ```
  /// own 2,   pins [project P -> 3]               -> 2
  /// own nil, pins [org O -> 4, project P -> 3]   -> 3
  /// own nil, pins [org O -> 4]                   -> 4
  /// ```
  public static func desktop(own: String?, orgs: [String], projects: [String], _ rules: [ActivityRule]) -> String? {
    if let own { return own }
    let all = pins(rules)
    func pinned(_ kind: Kind, _ names: [String]) -> String? {
      names.lazy.compactMap { n in all.first { $0.kind == kind && $0.name.caseInsensitiveCompare(n) == .orderedSame }?.desktop }.first
    }
    return pinned(.project, projects) ?? pinned(.org, orgs)
  }

  /// `rules` with the pin for `kind`/`name` set to `desktop`, or removed when `desktop` is nil.
  /// ```
  /// [url rule, pin(project P -> 2)] setting P -> 3 -> [url rule, pin(project P -> 3)]
  /// ```
  public static func setting(_ rules: [ActivityRule], kind: Kind, name: String, desktop: String?) -> [ActivityRule] {
    let key = DesktopPin(kind: kind, name: name, desktop: "").id
    var out = rules.filter { DesktopPin($0)?.id != key }
    if let desktop { out.append(DesktopPin(kind: kind, name: name, desktop: desktop).rule) }
    return out
  }
}

public struct SwitchMove: Equatable, Sendable {
  public let ref: String, title: String, column: String, at: Date
}

/// 4.1 Debounced task switching. A card has affinity when it has a desktop or a rule names its
/// project or org. Going away (idle, locked, asleep) parks it, stamped at the start of away; returning
/// to its context resumes it, but only when the engine parked it. Another context only makes the card
/// inactive (`Focus`). Cards without affinity are never touched.
public struct SwitchEngine: Codable, Sendable {
  public var startAfter: TimeInterval = 10
  public var stopAfter: TimeInterval = 120
  /// Card ids (`Card.id`) the engine parked and may resume.
  public private(set) var parked: Set<String> = []
  struct Flip: Codable, Sendable { var owned: Bool; var away: Bool?; var since: Date; var acted: Bool }
  var flips: [String: Flip] = [:]

  public init() {}

  /// Whether the card belongs to the current context; nil when the context cannot tell
  /// (desktop-only card while the Space probe fails) or the card has no affinity.
  static func owns(_ card: Card, _ context: Sample?, _ rules: [ActivityRule]) -> Bool? {
    owns(desktop: card.desktop, orgs: card.orgs, projects: card.projects, context, rules)
  }

  /// Same answer from a card's scope fields; Reports use it for cards no longer on the board.
  public static func owns(desktop: String?, orgs: [String], projects: [String], _ context: Sample?, _ rules: [ActivityRule]) -> Bool? {
    let ruled = ActivityRule.applying(rules, desktop: desktop, orgs: orgs, projects: projects)
    guard desktop != nil || !ruled.isEmpty else { return nil }
    guard let context else { return false }
    if ruled.contains(where: { $0.matches(context) }) { return true }
    if let d = desktop {
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
      let away = context == nil
      if flips[card.id]?.owned != owned || (flips[card.id]?.away ?? false) != away {
        flips[card.id] = Flip(owned: owned, away: away, since: contextSince, acted: false)
      }
      guard var f = flips[card.id], !f.acted else { continue }
      let held = now.timeIntervalSince(f.since)
      if inLive, away, held >= stopAfter {
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
