import Foundation

/// 7 Cycle totals for one day cycle: 2am to 2am, so a night build stays in one cycle.
public struct CycleStat: Equatable, Sendable, Identifiable {
  public let start: Date, end: Date
  /// Wall-clock Doing seconds in the cycle (parallel cards counted once), split by the card's planned/ad hoc flag.
  public var planned: TimeInterval = 0, adhoc: TimeInterval = 0
  /// Cards touched in the cycle (Doing time or done), of which created before it (`carriedIn`) or inside it (`added`).
  public var scope = 0, carriedIn = 0, added = 0
  /// Cards done in the cycle, and touched cards still open at its end.
  public var done = 0, carriedOut = 0
  public var id: Date { start }
  public var hours: Double { (planned + adhoc) / 3600 }
}

public enum Cycle {
  /// Local hour at which a cycle starts.
  public static let hour = 2

  /// Start of the cycle that contains `date`.
  /// ```
  /// Oct 20 01:30 -> Oct 19 02:00;  Oct 20 02:00 -> Oct 20 02:00
  /// ```
  public static func start(of date: Date, hour: Int = hour, calendar: Calendar = .current) -> Date {
    let at = calendar.date(bySettingHour: hour, minute: 0, second: 0, of: date) ?? date
    return at > date ? calendar.date(byAdding: .day, value: -1, to: at) ?? at : at
  }

  /// Cycles from the one containing `from` to the one containing `to`, oldest first.
  /// ```
  /// Oct 18 12:00 ... Oct 20 12:00 -> [Oct 18 02:00, Oct 19 02:00, Oct 20 02:00] (each 24 h)
  /// ```
  public static func cycles(from: Date, to: Date, hour: Int = hour, calendar: Calendar = .current) -> [DateInterval] {
    var out: [DateInterval] = []
    var s = start(of: from, hour: hour, calendar: calendar)
    while s <= to {
      let e = calendar.date(byAdding: .day, value: 1, to: s) ?? s.addingTimeInterval(86_400)
      out.append(DateInterval(start: s, end: e))
      s = e
    }
    return out
  }

  /// Per-cycle totals. A card is in scope when it has Doing time or a done move inside the cycle.
  /// Planned/ad hoc seconds are wall time: ad hoc time that overlaps planned time counts as planned.
  /// ```
  /// a (planned) 10:00-11:00, b (ad hoc) 10:30-11:30, one cycle -> planned 1 h, ad hoc 30 min
  /// a done in cycle, b open at its end                         -> done 1, carriedOut 1
  /// ```
  public static func stats(cards: [ReportCard], cycles: [DateInterval]) -> [CycleStat] {
    cycles.map { c in
      var s = CycleStat(start: c.start, end: c.end)
      var plannedIvals: [(Date, Date)] = [], adhocIvals: [(Date, Date)] = []
      for card in cards {
        let ivals = card.stints.compactMap { i -> (Date, Date)? in
          let a = max(i.start, c.start), b = min(i.end, c.end)
          return b > a ? (a, b) : nil
        }
        let doneHere = card.doneAt.map { $0 >= c.start && $0 < c.end } ?? false
        guard !ivals.isEmpty || doneHere else { continue }
        if card.adhoc == true { adhocIvals += ivals } else { plannedIvals += ivals }
        s.scope += 1
        if let made = Card.created(from: String(card.ref.split(separator: ":").first ?? "")), made >= c.start { s.added += 1 } else { s.carriedIn += 1 }
        if doneHere { s.done += 1 } else if card.doneAt.map({ $0 >= c.end }) ?? true { s.carriedOut += 1 }
      }
      s.planned = ActivityLog.unionSeconds(plannedIvals)
      s.adhoc = ActivityLog.unionSeconds(ActivityLog.subtract(adhocIvals, plannedIvals))
      return s
    }
  }

  /// Cycles each open card was carried through: touched in a cycle and not done by its end.
  /// Cards carried `limit` times or more are the ones to split or drop.
  /// ```
  /// a touched in 3 cycles, done in the third -> 2; b touched in 4 cycles, still open -> 4
  /// ```
  public static func carried(cards: [ReportCard], cycles: [DateInterval]) -> [(card: ReportCard, count: Int)] {
    cards.compactMap { card in
      let n = cycles.filter { c in
        let touched = card.stints.contains { $0.end > c.start && $0.start < c.end }
        return touched && (card.doneAt.map { $0 >= c.end } ?? true)
      }.count
      return n > 0 ? (card, n) : nil
    }.sorted { $0.count != $1.count ? $0.count > $1.count : $0.card.title < $1.card.title }
  }
}
