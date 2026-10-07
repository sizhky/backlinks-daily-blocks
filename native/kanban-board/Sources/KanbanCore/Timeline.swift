import Foundation

/// A Doing stint from `kb.chronicle(date)`; `open` = still running.
public struct DoingStint: Equatable, Sendable, Identifiable {
  public let start: Date, end: Date, title: String, open: Bool
  public var id: String { "\(start.timeIntervalSince1970)|\(title)" }
}

/// One row of the timeline list: a captured span, or a gap with no activity (away, asleep, app closed).
public enum TimelineRow: Equatable, Sendable, Identifiable {
  case span(Span)
  case away(start: Date, end: Date)
  public var id: String {
    switch self {
    case .span(let s): "s\(s.start.timeIntervalSince1970)"
    case .away(let a, _): "a\(a.timeIntervalSince1970)"
    }
  }
  public var start: Date { switch self { case .span(let s): s.start; case .away(let a, _): a } }
  public var end: Date { switch self { case .span(let s): s.end; case .away(_, let b): b } }
}

public enum ActivityLog {
  /// Spans from one day log (JSON lines), sorted by start. Partial or bad lines are skipped.
  public static func parse(_ data: Data) -> [Span] {
    let d = JSONDecoder()
    d.dateDecodingStrategy = .iso8601
    return String(decoding: data, as: UTF8.self).split(separator: "\n")
      .compactMap { try? d.decode(Span.self, from: Data($0.utf8)) }
      .filter { $0.end > $0.start }
      .sorted { $0.start < $1.start }
  }

  /// Spans with gaps of at least `gap` seconds made explicit as away rows.
  /// ```
  /// [10:00-10:05, 10:07-10:08] gap 60 -> [span, away 10:05-10:07, span]
  /// ```
  public static func rows(_ spans: [Span], gap: TimeInterval = 60) -> [TimelineRow] {
    var out: [TimelineRow] = []
    var last: Date?
    for s in spans {
      if let last, s.start.timeIntervalSince(last) >= gap { out.append(.away(start: last, end: s.start)) }
      out.append(.span(s))
      last = max(last ?? s.end, s.end)
    }
    return out
  }

  /// Wall-clock seconds covered by possibly overlapping intervals (stints of parallel Doing cards).
  /// ```
  /// [0-10, 5-20, 30-40] -> 30
  /// ```
  public static func unionSeconds(_ ivals: [(Date, Date)]) -> TimeInterval {
    var total: TimeInterval = 0
    var cur: (Date, Date)?
    for (a, b) in ivals.sorted(by: { $0.0 < $1.0 }) {
      if let c = cur, a <= c.1 { cur = (c.0, max(c.1, b)) } else {
        if let c = cur { total += c.1.timeIntervalSince(c.0) }
        cur = (a, b)
      }
    }
    if let c = cur { total += c.1.timeIntervalSince(c.0) }
    return total
  }

  /// Seconds per app, longest first.
  public static func totals(_ spans: [Span]) -> [(app: String, bundle: String, seconds: TimeInterval)] {
    var acc: [String: (String, TimeInterval)] = [:]
    for s in spans { acc[s.app, default: (s.bundle, 0)].1 += s.end.timeIntervalSince(s.start) }
    return acc.map { ($0.key, $0.value.0, $0.value.1) }.sorted { $0.2 > $1.2 }
  }

  /// `kb.chronicle(date)` rows `HHMM:HHMM[~]<TAB>dur<TAB>title` on `day` (local midnight).
  public static func stints(_ text: String, day: Date, calendar: Calendar = .current) -> [DoingStint] {
    text.split(separator: "\n").compactMap { line in
      let f = line.split(separator: "\t", omittingEmptySubsequences: false)
      guard f.count >= 3, let m = f[0].wholeMatch(of: #/(\d{2})(\d{2}):(\d{2})(\d{2})(~?)/#),
            let a = calendar.date(bySettingHour: Int(m.1)!, minute: Int(m.2)!, second: 0, of: day),
            let b = calendar.date(bySettingHour: Int(m.3)!, minute: Int(m.4)!, second: 0, of: day) else { return nil }
      return DoingStint(start: a, end: b, title: String(f[2]), open: !m.5.isEmpty)
    }
  }
}
