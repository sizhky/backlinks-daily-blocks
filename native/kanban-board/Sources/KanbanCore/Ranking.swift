/// Manual card order inside a column (fractional ranks, as in Linear/Jira LexoRank).
/// Ranked cards show first by rank; unranked cards follow in their default order.
public enum Ranking {
  /// Display order: ranked ascending, then the unranked in their given order.
  public static func ordered(_ cards: [Card]) -> [Card] {
    cards.filter { $0.rank != nil }.sorted { $0.rank! < $1.rank! } + cards.filter { $0.rank == nil }
  }

  /// Ranks to write when `moving` refs land before `before` (nil = end) in `shown`
  /// (the column's display order). Unranked cards above the drop point get ranks too,
  /// so the result is the order the user saw.
  /// ```
  /// shown A(1) B(2) C(nil); move C before B -> [(C, 1.5)]
  /// shown A(nil) B(nil);    move B before A -> [(B, 1)]; A stays unranked, below B
  /// ```
  public static func place(_ moving: [String], before: String?, in shown: [Card]) -> [(ref: String, rank: Double)] {
    let rest = shown.filter { !moving.contains($0.ref) }
    let at = before.flatMap { b in rest.firstIndex { $0.ref == b } } ?? rest.count
    var out: [(ref: String, rank: Double)] = []
    var lower = rest[..<at].last?.rank
    // Rank the unranked cards between the ranked prefix and the drop point.
    let firstUnranked = rest.firstIndex { $0.rank == nil } ?? rest.count
    if firstUnranked < at {
      var r = firstUnranked > 0 ? rest[firstUnranked - 1].rank! : 0
      for card in rest[firstUnranked..<at] { r += 1; out.append((card.ref, r)) }
      lower = r
    }
    let upper = at < rest.count ? rest[at].rank : nil
    let k = Double(moving.count)
    for (j, ref) in moving.enumerated() {
      let i = Double(j + 1)
      let rank: Double
      switch (lower, upper) {
      case let (l?, u?): rank = l + (u - l) * i / (k + 1)
      case let (l?, nil): rank = l + i
      case let (nil, u?): rank = u - (k + 1 - i)
      default: rank = i
      }
      out.append((ref, rank))
    }
    return out
  }

  /// Where a drag at height `y` lands: before the first non-dragged card whose middle is below
  /// `y`, or nil for the end. A spot equal to where the grabbed card already sits returns the
  /// grabbed card's own ref, so hovering near home changes nothing on screen.
  /// ```
  /// order a b c, midY a=10 b=30 c=50, dragging b: y=5 -> "a", y=40 -> "b" (home), y=60 -> nil
  /// ```
  public static func slot(order: [String], dragging: Set<String>, grabbed: String?,
                          midY: [String: Double], y: Double) -> String? {
    let others = order.filter { !dragging.contains($0) }
    let hit = others.first { (midY[$0] ?? .infinity) > y }
    guard let g = grabbed, let i = order.firstIndex(of: g) else { return hit }
    let home = order[(i + 1)...].first { !dragging.contains($0) }
    return hit == home ? g : hit
  }
}
