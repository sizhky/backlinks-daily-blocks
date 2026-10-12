import Foundation

/// 6.1 One active task at a time (blueprint: .yeshwanth/blueprints/activity-tracking.md). The widget,
/// the stored `%% kbactive %%` total, and Reports all pick the active card with `Focus.pick`.
public enum Focus {
  /// Among Doing candidates: cards that own the context win, else cards with no affinity;
  /// ties go to the card that entered Doing last. nil = no card is active.
  /// ```
  /// [(0, 10:00, true), (1, 10:30, true)]  -> 1
  /// [(0, 10:00, true), (1, 10:30, nil)]   -> 0
  /// [(0, 10:00, false), (1, 10:30, nil)]  -> 1
  /// [(0, 10:00, false)]                   -> nil
  /// ```
  public static func pick(_ candidates: [(index: Int, since: Date, owns: Bool?)]) -> Int? {
    let owners = candidates.filter { $0.owns == true }
    let pool = owners.isEmpty ? candidates.filter { $0.owns == nil } : owners
    return pool.max { $0.since < $1.since }?.index
  }

  /// The active card among live cards in `doing`; nil while away (`context` nil). A `pin` that
  /// holds for `context` beats the rules while its card is in `doing`.
  public static func active(_ cards: [Card], context: Sample?, rules: [ActivityRule], pin: FocusPin? = nil,
                            doing: String = "Doing") -> Card? {
    guard let context else { return nil }
    let live = cards.filter { $0.col.caseInsensitiveCompare(doing) == .orderedSame }
    if let pin, pin.holds(context), let card = live.first(where: { $0.id == pin.id }) { return card }
    let i = pick(live.indices.map { i in
      (i, live[i].since ?? .distantPast, SwitchEngine.owns(live[i], context, rules))
    })
    return i.map { live[$0] }
  }
}

/// A card made active by hand (Fn-click in the widget). It holds on the desktop it was made on;
/// changing desktop or going away hands the choice back to the rules. A pin made with a switch to
/// another desktop holds on that desktop, and on the one it leaves until the context arrives.
/// ```
/// pin(a, on desktop U1): context on U1 -> holds; on U2 -> no; away (nil) -> no
/// pin(a, on U1, to U2): U1 -> holds; U2 -> holds, arrive; then U1 -> no
/// ```
public struct FocusPin: Equatable, Sendable {
  public let id: String
  public let desktop: String?
  /// The desktop a pending switch leaves.
  public private(set) var leaving: String?

  public init(id: String, context: Sample?, to target: String? = nil) {
    self.id = id
    let here = context.flatMap(Self.desktop)
    desktop = target ?? here
    leaving = target == nil || target == here ? nil : here
  }

  public func holds(_ context: Sample?) -> Bool {
    guard let context else { return false }
    let here = Self.desktop(context)
    return here == desktop || (leaving != nil && here == leaving)
  }

  /// Ends the pending switch once the context is on `desktop`.
  public mutating func arrive(_ context: Sample?) {
    if let context, Self.desktop(context) == desktop { leaving = nil }
  }

  static func desktop(_ s: Sample) -> String? { Desktops.key(uuid: s.uuid, space: s.space) }
}

/// Active seconds per card id (`Card.id`), counted between ticks and not yet written to the note.
/// A tick credits the time since the last tick to the card that was active, capped at `maxStep` so a
/// stalled app or a relaunch never credits a gap. Going away retracts the time credited after `awaySince`
/// (idle is noticed 5 minutes late), so totals match the day log, whose span ends at the idle start.
public struct ActiveClock: Codable, Equatable, Sendable {
  public static let maxStep: TimeInterval = 15
  public private(set) var pending: [String: Double] = [:]
  public private(set) var last: Date?
  public private(set) var current: String?
  /// Seconds credited to `current` since it became active; a retraction never takes more.
  private var run: Double = 0

  public init() {}

  /// ```
  /// tick(0, a) tick(6, a) tick(12, b)               -> pending [a: 12]
  /// tick(0, a) ... tick(300, a) tick(306, nil, away 0) -> pending [a: 0]
  /// ```
  public mutating func tick(now: Date, active: String?, awaySince: Date? = nil) {
    if let last, let current {
      let step = min(Self.maxStep, max(0, now.timeIntervalSince(last)))
      pending[current, default: 0] += step
      run += step
      if active == nil, let awaySince {
        pending[current, default: 0] -= min(run, max(0, now.timeIntervalSince(awaySince)))
      }
    }
    if active != current { run = 0 }
    last = now
    current = active
  }

  /// Whole seconds ready to write (at least 1), removed from `pending`; fractions and negatives stay.
  public mutating func take() -> [String: Int] {
    var out: [String: Int] = [:]
    for (id, sec) in pending where sec >= 1 {
      out[id] = Int(sec)
      pending[id] = sec - Double(Int(sec))
    }
    return out
  }

  /// Puts back seconds whose write failed.
  public mutating func restore(_ taken: [String: Int]) {
    for (id, n) in taken { pending[id, default: 0] += Double(n) }
  }

  /// Drops cards no longer on the board.
  public mutating func keep(_ ids: Set<String>) { pending = pending.filter { ids.contains($0.key) } }

  /// Unwritten seconds for `id`, plus the running time since the last tick when it is the active card.
  public func unwritten(_ id: String, now: Date) -> Double {
    guard let last, id == current else { return max(0, pending[id] ?? 0) }
    return max(0, (pending[id] ?? 0) + min(Self.maxStep, max(0, now.timeIntervalSince(last))))
  }
}
