import Foundation

/// A Doing stint from `kb.chronicle(date)`; `open` = still running.
public struct DoingStint: Equatable, Sendable, Identifiable {
  public let start: Date, end: Date, title: String, open: Bool
  /// `file:line` of the card (`kb.chronicle(..., {refs:true})`); nil from older output.
  public var ref: String? = nil
  /// First project of the card's note (5th field with refs); nil when absent.
  public var project: String? = nil
  /// Bare `yyyyMMddHHmm` stamp of the move into Doing (6th field with refs): the stint's key for `kb.editStint`.
  public var enter: String? = nil
  public var id: String { "\(start.timeIntervalSince1970)|\(title)" }
}

/// Which end of a Doing stint a calendar drag moves.
public enum StintEdge: Sendable { case start, end }

extension DoingStint {
  /// Where a dragged edge lands: a whole minute (note stamps are minute precision), at least a
  /// minute from the other edge, never after `now`.
  /// ```
  /// 10:00-11:00: end to 10:00:20 -> 10:01;  start to 11:30 -> 10:59;  end to 13:00 at now 12:00 -> 12:00
  /// ```
  public func dragged(_ edge: StintEdge, to t: Date, now: Date) -> Date {
    let m = Date(timeIntervalSince1970: (t.timeIntervalSince1970 / 60).rounded() * 60)
    switch edge {
    case .start: return min(m, end.addingTimeInterval(-60), now)
    case .end: return min(max(m, start.addingTimeInterval(60)), now)
    }
  }

  /// This stint with one edge moved (drag preview).
  public func with(_ edge: StintEdge, at t: Date) -> DoingStint {
    DoingStint(start: edge == .start ? t : start, end: edge == .end ? t : end, title: title, open: open,
               ref: ref, project: project, enter: enter)
  }
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

  /// Multi-day `kb.chronicle(from, to)`: rows grouped under `== yyyyMMdd ==` headers, keyed by that header.
  public static func stintsByDay(_ text: String, calendar: Calendar = .current) -> [String: [DoingStint]] {
    var out: [String: [DoingStint]] = [:]
    var key: String?, rows: [Substring] = []
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyyMMdd"
    func flush() {
      guard let key, let day = f.date(from: key) else { return }
      out[key] = stints(rows.joined(separator: "\n"), day: calendar.startOfDay(for: day), calendar: calendar)
    }
    for line in text.split(separator: "\n") {
      if let m = line.wholeMatch(of: #/== (\d{8}) ==/#) { flush(); key = String(m.1); rows = [] } else { rows.append(line) }
    }
    flush()
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

  /// `kb.chronicle(date)` rows `HHMM:HHMM[~]<TAB>dur<TAB>title[<TAB>ref<TAB>project]` on `day` (local midnight).
  public static func stints(_ text: String, day: Date, calendar: Calendar = .current) -> [DoingStint] {
    text.split(separator: "\n").compactMap { line in
      let f = line.split(separator: "\t", omittingEmptySubsequences: false)
      guard f.count >= 3, let m = f[0].wholeMatch(of: #/(\d{2})(\d{2}):(\d{2})(\d{2})(~?)/#),
            let a = calendar.date(bySettingHour: Int(m.1)!, minute: Int(m.2)!, second: 0, of: day),
            let b = calendar.date(bySettingHour: Int(m.3)!, minute: Int(m.4)!, second: 0, of: day) else { return nil }
      return DoingStint(start: a, end: b, title: String(f[2]), open: !m.5.isEmpty, ref: f.count > 3 && !f[3].isEmpty ? String(f[3]) : nil,
                        project: f.count > 4 && !f[4].isEmpty ? String(f[4]) : nil, enter: f.count > 5 && !f[5].isEmpty ? String(f[5]) : nil)
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

/// A timed line in a per-day log under `<vault>/.activity/`, `YYYYMMDD<suffix>.jsonl`, filed by the
/// local day it starts. Written once it ends; one shared codec and midnight split.
public protocol DayLine: Codable, Equatable, Sendable {
  var start: Date { get set }
  var end: Date { get set }
  static var suffix: String { get }
}

extension DayLine {
  public var jsonLine: String {
    let e = JSONEncoder()
    e.dateEncodingStrategy = .iso8601
    e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return (try? String(decoding: e.encode(self), as: UTF8.self)) ?? ""
  }

  public var fileName: String { Self.fileName(start) }

  public static func fileName(_ day: Date) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyyMMdd"
    return f.string(from: day) + suffix + ".jsonl"
  }
}

/// A stretch when one card was the active task (`Focus.active`), in `YYYYMMDD-active.jsonl`.
/// The Timeline shades these inside Doing blocks.
/// ```
/// {"end":"2026-10-11T07:00:00Z","ref":"20261011-1121.md:7","start":"2026-10-11T06:40:00Z","title":"Fix scroll"}
/// ```
public struct ActiveStretch: DayLine {
  public static let suffix = "-active"
  public var ref: String, title: String
  public var start: Date, end: Date

  public init(ref: String, title: String, start: Date, end: Date) {
    (self.ref, self.title, self.start, self.end) = (ref, title, start, end)
  }
}

/// A break (the break key or the cup button), in `YYYYMMDD-breaks.jsonl`.
/// ```
/// {"end":"2026-10-11T07:15:00Z","start":"2026-10-11T07:00:00Z"}
/// ```
public struct BreakSpan: DayLine {
  public static let suffix = "-breaks"
  public var start: Date, end: Date

  public init(start: Date, end: Date) { (self.start, self.end) = (start, end) }
}

extension ActivityLog {
  /// Lines from one day log, sorted by start; bad lines skipped.
  public static func parseLines<T: DayLine>(_ data: Data) -> [T] {
    let d = JSONDecoder()
    d.dateDecodingStrategy = .iso8601
    return String(decoding: data, as: UTF8.self).split(separator: "\n")
      .compactMap { try? d.decode(T.self, from: Data($0.utf8)) }
      .filter { $0.end > $0.start }
      .sorted { $0.start < $1.start }
  }

  /// Splits at local midnights so each piece lands in its own day file.
  /// ```
  /// 23:50-00:10 -> [23:50-00:00, 00:00-00:10]
  /// ```
  public static func splitByDay<T: DayLine>(_ s: T, calendar: Calendar = .current) -> [T] {
    var out: [T] = [], piece = s
    while let next = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: piece.start)), next < piece.end {
      var head = piece
      head.end = next
      out.append(head)
      piece.start = next
    }
    return out + [piece]
  }

  /// Logged seconds per desktop (`Desktops.key`); spans without a desktop are left out.
  /// ```
  /// [U1 10 min, U2 5 min, U1 5 min] -> [U1: 15 min, U2: 5 min]
  /// ```
  public static func desktopSeconds(_ spans: [Span]) -> [String: TimeInterval] {
    spans.reduce(into: [:]) { out, s in
      if let k = Desktops.key(uuid: s.uuid, space: s.space) { out[k, default: 0] += s.end.timeIntervalSince(s.start) }
    }
  }

  /// Idle stretches of `from...now`: gaps of at least `minGap` with no activity span (the caller adds the open span).
  /// ```
  /// from 9:00, now 11:00, minGap 5 min, spans 9:00-9:30 9:32-10:00 -> [10:00-11:00]
  /// ```
  public static func idle(_ spans: [Span], from: Date, now: Date, minGap: TimeInterval) -> [(Date, Date)] {
    var out: [(Date, Date)] = [], cursor = from
    for s in spans.sorted(by: { $0.start < $1.start }) {
      if s.start.timeIntervalSince(cursor) >= minGap { out.append((cursor, min(s.start, now))) }
      cursor = max(cursor, s.end)
    }
    if now.timeIntervalSince(cursor) >= minGap { out.append((cursor, now)) }
    return out
  }

  /// Seconds of `from...now` off work (breaks and idle, overlaps counted once) and the rest (work);
  /// a running break (`distantFuture`) counts until now.
  /// ```
  /// from 9:00, now 11:00, breaks 8:50-9:10 and 10:00-running, idle 9:40-10:10 -> work 30 min, pause 90 min
  /// ```
  public static func dayTotals(_ breaks: [BreakSpan], idle: [(Date, Date)] = [], from: Date, now: Date) -> (work: TimeInterval, pause: TimeInterval) {
    let total = max(0, now.timeIntervalSince(from))
    let clipped = (breaks.map { ($0.start, $0.end) } + idle).compactMap { a, b -> (Date, Date)? in
      let s = max(a, from), e = min(b, now)
      return e > s ? (s, e) : nil
    }
    let off = min(total, unionSeconds(clipped))
    return (total - off, off)
  }

  /// Parts of `stretches` inside `stint`: the same card (ref, else title, since refs shift when
  /// lines move), clipped to the stint. A stretch whose end is `distantFuture` runs until `now`.
  /// ```
  /// stint 10:00-11:00, stretches 09:50-10:20 and 10:40-12:00 of its card -> [10:00-10:20, 10:40-11:00]
  /// ```
  public static func activeParts(of stint: DoingStint, in stretches: [ActiveStretch], now: Date) -> [(start: Date, end: Date)] {
    stretches.compactMap { s in
      guard s.ref == stint.ref || s.title == stint.title else { return nil }
      let a = max(s.start, stint.start), b = min(s.end, stint.end, now)
      return b > a ? (a, b) : nil
    }
  }
}
