import Foundation

public struct CardGroup: Identifiable, Equatable, Sendable {
  public let name: String?
  public let cards: [Card]
  public var id: String { name ?? "" }
}

public enum Grouping {
  /// Groups by first project; larger groups first, cards without a project last.
  /// ```
  /// [A:Arka, B:Arka, C:Zed, D:none] -> Arka[A,B], Zed[C], nil[D]
  /// ```
  public static func byProject(_ cards: [Card]) -> [CardGroup] {
    var order: [String] = [], buckets: [String: [Card]] = [:], loose: [Card] = []
    for card in cards {
      guard let p = card.projects.first else { loose.append(card); continue }
      if buckets[p] == nil { order.append(p) }
      buckets[p, default: []].append(card)
    }
    let named = order.sorted { (buckets[$1]!.count, $0) < (buckets[$0]!.count, $1) }
      .map { CardGroup(name: $0, cards: buckets[$0]!) }
    return loose.isEmpty ? named : named + [CardGroup(name: nil, cards: loose)]
  }
}
