import Foundation

/// A card entering or leaving the live column between two board snapshots: what the tracker
/// widget's toast reports. One diff covers every writer (drag, switch rules, sleep auto-park).
public struct DoingChange: Equatable, Sendable {
  public let title: String
  /// "Started" on entry; on exit, the column the card went to ("Parked", "Done"), or "Removed".
  public let verb: String

  public init(title: String, verb: String) { (self.title, self.verb) = (title, verb) }

  /// ```
  /// before [A Doing, B Doing], after [A Parked, C Doing] -> [C Started, A Parked]
  /// ```
  public static func diff(before: [Card], after: [Card], live: String = "Doing") -> [DoingChange] {
    let isLive = { (c: Card) in c.col.caseInsensitiveCompare(live) == .orderedSame }
    let was = Set(before.filter(isLive).map(\.id))
    let now = after.filter(isLive)
    let nowIDs = Set(now.map(\.id))
    let byID = Dictionary(after.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    let started = now.filter { !was.contains($0.id) }.map { DoingChange(title: $0.title, verb: "Started") }
    let left = before.filter { isLive($0) && !nowIDs.contains($0.id) }
      .map { DoingChange(title: $0.title, verb: byID[$0.id]?.col ?? "Removed") }
    return started + left
  }
}
