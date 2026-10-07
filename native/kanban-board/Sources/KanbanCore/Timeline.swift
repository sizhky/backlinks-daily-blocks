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

  /// Fills gaps shorter than `maxGap` by carrying the previous span forward to the next start
  /// (dropped sub-5 s visits and capture restarts). Longer gaps are real absence and stay empty.
  /// The log on disk is not changed; this is for display and totals.
  /// ```
  /// [A 10:00-10:05, B 10:05:20-10:06] maxGap 60 -> [A 10:00-10:05:20, B ...]
  /// ```
  public static func impute(_ spans: [Span], maxGap: TimeInterval = 60) -> [Span] {
    var out = spans
    for i in out.indices.dropLast() {
      let gap = out[i + 1].start.timeIntervalSince(out[i].end)
      if gap > 0, gap < maxGap { out[i].end = out[i + 1].start }
    }
    return out
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

/// Consecutive spans of one app, merged for the calendar view.
public struct ActivityBlock: Equatable, Sendable, Identifiable {
  public let start: Date, end: Date, app: String, bundle: String
  /// The window title seen longest inside the block.
  public let title: String
  public let spans: Int
  public var id: String { "\(start.timeIntervalSince1970)|\(app)" }
}

extension ActivityLog {
  /// Merges consecutive spans of the same app separated by less than `gap` seconds.
  /// ```
  /// [Arc 10:00-10:05, Arc 10:05-10:09, Mail 10:09-10:10] -> [Arc 10:00-10:09 (2), Mail 10:09-10:10]
  /// ```
  public static func blocks(_ spans: [Span], gap: TimeInterval = 60) -> [ActivityBlock] {
    var out: [ActivityBlock] = []
    var group: [Span] = []
    func flush() {
      guard let first = group.first, let last = group.last else { return }
      var seen: [String: TimeInterval] = [:]
      for s in group where !s.title.isEmpty { seen[s.title, default: 0] += s.end.timeIntervalSince(s.start) }
      let title = seen.max { $0.value < $1.value }?.key ?? ""
      out.append(ActivityBlock(start: first.start, end: last.end, app: first.app, bundle: first.bundle, title: title, spans: group.count))
      group = []
    }
    for s in spans {
      if let last = group.last, last.app != s.app || s.start.timeIntervalSince(last.end) >= gap { flush() }
      group.append(s)
    }
    flush()
    return out
  }
}

/// A run of continuous activity (blocks less than `gap` apart), labelled by its most-used app.
public struct ActivitySession: Equatable, Sendable, Identifiable {
  public let start: Date, end: Date
  public let app: String, bundle: String, title: String
  /// Distinct apps in the session.
  public let apps: Int
  public var id: String { "\(start.timeIntervalSince1970)" }
}

extension ActivityLog {
  /// ```
  /// [Arc 10:00-10:10, Mail 10:10-10:12, Arc 10:30-10:31] gap 60 -> [Arc 10:00-10:12 (2 apps), Arc 10:30-10:31]
  /// ```
  public static func sessions(_ blocks: [ActivityBlock], gap: TimeInterval = 60) -> [ActivitySession] {
    var out: [ActivitySession] = []
    var run: [ActivityBlock] = []
    func flush() {
      guard let first = run.first, let last = run.last else { return }
      var time: [String: TimeInterval] = [:]
      for b in run { time[b.app, default: 0] += b.end.timeIntervalSince(b.start) }
      let top = time.max { $0.value < $1.value }!.key
      let lead = run.filter { $0.app == top }.max { $0.end.timeIntervalSince($0.start) < $1.end.timeIntervalSince($1.start) }!
      out.append(ActivitySession(start: first.start, end: last.end, app: top, bundle: lead.bundle, title: lead.title, apps: time.count))
      run = []
    }
    for b in blocks {
      if let last = run.last, b.start.timeIntervalSince(last.end) >= gap { flush() }
      run.append(b)
    }
    flush()
    return out
  }
}

extension ActivityLog {
  /// Side-by-side column for each interval, as a calendar lays out overlapping events, plus the
  /// column count of each one's overlap cluster. Input order is kept.
  /// ```
  /// [0-10, 5-15, 20-30] -> lanes [0, 1, 0], widths [2, 2, 1]
  /// ```
  public static func lanes(_ ivals: [(Date, Date)]) -> (lane: [Int], of: [Int]) {
    let order = ivals.indices.sorted { ivals[$0].0 < ivals[$1].0 }
    var lane = Array(repeating: 0, count: ivals.count), of = Array(repeating: 1, count: ivals.count)
    var ends: [Date] = []          // per lane, end of its last interval in the current cluster
    var cluster: [Int] = []
    var clusterEnd = Date.distantPast
    func close() { for i in cluster { of[i] = ends.count }; cluster = []; ends = [] }
    for i in order {
      let (a, b) = ivals[i]
      if a >= clusterEnd { close() }
      if let free = ends.firstIndex(where: { $0 <= a }) { lane[i] = free; ends[free] = b } else { lane[i] = ends.count; ends.append(b) }
      cluster.append(i)
      clusterEnd = max(clusterEnd, b)
    }
    close()
    return (lane, of)
  }
}
