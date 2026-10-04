import Foundation

/// Done cards grouped by the day they were finished, newest day and newest card first.
/// ```
/// [done Oct 2 17:25, done Oct 3 12:21, live] -> [(Oct 3, [12:21]), (Oct 2, [17:25])]
/// ```
public enum Logbook {
  public static func days(_ cards: [Card], calendar: Calendar = .current) -> [(day: Date, cards: [Card])] {
    let done = cards.filter { $0.doneAt != nil }.sorted { $0.doneAt! > $1.doneAt! }
    let groups = Dictionary(grouping: done) { calendar.startOfDay(for: $0.doneAt!) }
    return groups.keys.sorted(by: >).map { (day: $0, cards: groups[$0]!) }
  }

  /// Done-column order: latest finished first; cards without a finish time last, in input order.
  /// ```
  /// [done 10:00, no time, done 12:00] -> [done 12:00, done 10:00, no time]
  /// ```
  public static func newestFirst(_ cards: [Card]) -> [Card] {
    cards.filter { $0.doneAt != nil }.sorted { $0.doneAt! > $1.doneAt! } + cards.filter { $0.doneAt == nil }
  }
}
