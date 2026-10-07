import Foundation

/// 6 Reports input: one row of `kb.reportCards(from, to)` (blueprint: .yeshwanth/blueprints/activity-tracking.md).
public struct ReportCard: Equatable, Sendable, Identifiable {
  public let ref: String, title: String
  public let orgs: [String], projects: [String]
  public let desktop: String?
  /// 5.1 nil = never reached Doing.
  public let adhoc: Bool?
  /// Set when the card reached a terminal column inside the range.
  public let doneAt: Date?
  /// Doing time over the card's whole history, from the move stamps.
  public let lifetime: TimeInterval
  /// Doing stints clipped to the range.
  public let stints: [DateInterval]
  public var id: String { ref }
  /// 5.3 Done in the range with no Doing time ever.
  public var untracked: Bool { doneAt != nil && lifetime == 0 }

  public init(ref: String, title: String, orgs: [String] = [], projects: [String] = [], desktop: String? = nil,
              adhoc: Bool? = nil, doneAt: Date? = nil, lifetime: TimeInterval = 0, stints: [DateInterval] = []) {
    self.ref = ref; self.title = title; self.orgs = orgs; self.projects = projects; self.desktop = desktop
    self.adhoc = adhoc; self.doneAt = doneAt; self.lifetime = lifetime; self.stints = stints
  }

  /// ```
  /// a.md:3<TAB>Fix<TAB>Divami<TAB>P|Q<TAB>2<TAB>1<TAB>-<TAB>600<TAB>100-400,500-800
  ///   -> orgs [Divami], projects [P, Q], desktop "2", adhoc true, 2 stints
  /// ```
  public static func parse(_ text: String) -> [ReportCard] {
    let list = { (s: Substring) in s.split(separator: "|").map(String.init) }
    let date = { (s: Substring) in Double(s).map { Date(timeIntervalSince1970: $0) } }
    return text.split(separator: "\n").compactMap { line in
      let f = line.split(separator: "\t", omittingEmptySubsequences: false)
      guard f.count >= 9, f[0].contains(":") else { return nil }
      let stints = f[8].split(separator: ",").compactMap { pair -> DateInterval? in
        let p = pair.split(separator: "-")
        guard p.count == 2, let a = date(p[0]), let b = date(p[1]), b > a else { return nil }
        return DateInterval(start: a, end: b)
      }
      return ReportCard(ref: String(f[0]), title: String(f[1]), orgs: list(f[2]), projects: list(f[3]),
                        desktop: f[4].isEmpty ? nil : String(f[4]), adhoc: f[5] == "1" ? true : f[5] == "0" ? false : nil,
                        doneAt: date(f[6]), lifetime: Double(f[7]) ?? 0, stints: stints)
    }
  }
}

/// Attributed seconds of one hour, credited to a card, to a scope with no card, or to nobody.
public struct Allocation: Hashable, Sendable {
  public enum Target: Hashable, Sendable { case card(String), noCard, unattributed }
  /// Start of the hour the time falls in.
  public let hour: Date
  /// "" when the card or rule names no org or project.
  public let org: String, project: String
  public let target: Target
  public var seconds: Double
}

public enum Report {
  /// 6.1 Attributed time. Only active spans count. For each moment of a span, among the cards in Doing:
  /// cards that own the span's context split it; else cards with no affinity split it; else a rule that
  /// matches the span credits its project or org with no card; else it is unattributed.
  /// A card's share splits equally across its org x project pairs.
  /// ```
  /// span 10:00-11:00, cards A and B in Doing, no rules        -> A 30 min, B 30 min
  /// same, A pinned to desktop 2, span on desktop 2             -> A 60 min
  /// same, both pinned to desktop 3, span on desktop 2          -> unattributed 60 min
  /// ```
  public static func attribute(spans: [Span], cards: [ReportCard], rules: [ActivityRule],
                               calendar: Calendar = .current) -> [Allocation] {
    let stints = cards.indices.flatMap { i in cards[i].stints.map { (s: $0.start, e: $0.end, card: i) } }.sorted { $0.s < $1.s }
    let orgOf = projectOrgs(cards)
    var acc: [Allocation: Double] = [:]
    func credit(_ hour: Date, _ org: String, _ project: String, _ target: Allocation.Target, _ sec: Double) {
      acc[Allocation(hour: hour, org: org, project: project, target: target, seconds: 0), default: 0] += sec
    }
    var next = 0
    var active: [(s: Date, e: Date, card: Int)] = []
    for span in spans.sorted(by: { $0.start < $1.start }) {
      let ctx = Sample(app: span.app, bundle: span.bundle, title: span.title, url: span.url, space: span.space, desktop: span.desktop)
      for piece in hourPieces(span.start, span.end, calendar) {
        while next < stints.count, stints[next].s < piece.end { active.append(stints[next]); next += 1 }
        active.removeAll { $0.e <= piece.start }
        let cuts = Set(active.flatMap { [$0.s, $0.e] }.filter { $0 > piece.start && $0 < piece.end })
        let marks = [piece.start] + cuts.sorted() + [piece.end]
        for (a, b) in zip(marks, marks.dropFirst()) {
          let sec = b.timeIntervalSince(a)
          let doing = Set(active.filter { $0.s < b && $0.e > a }.map(\.card)).sorted()
          let owned = doing.map { i in (i, SwitchEngine.owns(desktop: cards[i].desktop, orgs: cards[i].orgs, projects: cards[i].projects, ctx, rules)) }
          var owners = owned.filter { $0.1 == true }.map(\.0)
          if owners.isEmpty { owners = owned.filter { $0.1 == nil }.map(\.0) }
          if !owners.isEmpty {
            for i in owners {
              let pairs = pairs(cards[i])
              for (o, p) in pairs { credit(piece.hour, o, p, .card(cards[i].ref), sec / Double(owners.count * pairs.count)) }
            }
          } else if let r = rules.first(where: { ($0.org != nil || $0.project != nil) && $0.matches(ctx) }) {
            let org = r.org ?? r.project.flatMap { orgOf[$0.lowercased()] } ?? ""
            credit(piece.hour, org, r.project ?? "", .noCard, sec)
          } else {
            credit(piece.hour, "", "", .unattributed, sec)
          }
        }
      }
    }
    return acc.map { var a = $0.key; a.seconds = $0.value; return a }.sorted { $0.hour < $1.hour }
  }

  /// A card's org x project pairs; a missing side is "".
  public static func pairs(_ c: ReportCard) -> [(String, String)] {
    let orgs = c.orgs.isEmpty ? [""] : c.orgs, projects = c.projects.isEmpty ? [""] : c.projects
    return orgs.flatMap { o in projects.map { (o, $0) } }
  }

  /// The first org seen with each project (lower-cased key), for rule credit that names only a project.
  static func projectOrgs(_ cards: [ReportCard]) -> [String: String] {
    var out: [String: String] = [:]
    for c in cards { for p in c.projects where out[p.lowercased()] == nil { if let o = c.orgs.first { out[p.lowercased()] = o } } }
    return out
  }

  /// `start..<end` cut at hour boundaries.
  static func hourPieces(_ start: Date, _ end: Date, _ calendar: Calendar) -> [(start: Date, end: Date, hour: Date)] {
    var out: [(start: Date, end: Date, hour: Date)] = []
    var t = start
    while t < end {
      let hour = calendar.dateInterval(of: .hour, for: t)?.start ?? t
      let next = min(end, calendar.date(byAdding: .hour, value: 1, to: hour) ?? end)
      out.append((t, next, hour))
      t = next
    }
    return out
  }
}

/// 6.3 One row of the Reports breakdown: org > project > card. Counts are distinct cards.
public struct ReportNode: Identifiable, Equatable, Sendable {
  public enum Kind: Sendable { case org, project, card, noCard, unattributed }
  public let id: String, kind: Kind
  /// "" = no org or no project.
  public let name: String
  public var ref: String?
  public var seconds: Double = 0, adhocSeconds: Double = 0
  public var adhoc: Set<String> = [], untracked: Set<String> = []
  public var children: [ReportNode] = []
}

extension Report {
  /// Seconds per bucket and series. Series = org, or project inside `org` when drilled;
  /// unattributed time is its own series ("" org and project, `unattributed` true) and is left out when drilled.
  public static func series(_ allocs: [Allocation], org: String?, bucket: (Date) -> Date)
    -> [(bucket: Date, name: String, unattributed: Bool, seconds: Double)] {
    var acc: [String: (Date, String, Bool, Double)] = [:]
    for a in allocs {
      let un = a.target == .unattributed
      if let org, un || a.org.caseInsensitiveCompare(org) != .orderedSame { continue }
      let name = org == nil ? a.org : a.project, b = bucket(a.hour)
      let key = "\(b.timeIntervalSince1970)|\(un)|\(name)"
      acc[key, default: (b, name, un, 0)].3 += a.seconds
    }
    return acc.values.map { (bucket: $0.0, name: $0.1, unattributed: $0.2, seconds: $0.3) }.sorted { $0.bucket < $1.bucket }
  }

  /// Breakdown tree, largest first; unattributed time is the last top-level row. Untracked cards
  /// (done in range, no Doing time) appear with zero seconds under each of their projects.
  /// ```
  /// allocs [Divami/P card a 30 min, unattributed 10 min], card a ad hoc
  ///   -> [Divami 30m (P 30m (a 30m)), Unattributed 10m]; Divami.adhoc = [a]
  /// ```
  public static func tree(_ allocs: [Allocation], cards: [ReportCard]) -> [ReportNode] {
    let byRef = Dictionary(cards.map { ($0.ref, $0) }, uniquingKeysWith: { a, _ in a })
    var orgs: [String: ReportNode] = [:]
    var projects: [String: [String: ReportNode]] = [:]
    var leaves: [String: [String: [String: ReportNode]]] = [:]
    var unattributed = ReportNode(id: "u", kind: .unattributed, name: "")
    func add(org: String, project: String, ref: String?, seconds: Double) {
      let ok = org.lowercased(), pk = project.lowercased()
      let card = ref.flatMap { byRef[$0] }
      let adhoc = card?.adhoc == true, untracked = card?.untracked == true
      func bump(_ n: inout ReportNode) {
        n.seconds += seconds
        if adhoc { n.adhocSeconds += seconds; n.adhoc.insert(ref!) }
        if untracked { n.untracked.insert(ref!) }
      }
      bump(&orgs[ok, default: ReportNode(id: "o|" + ok, kind: .org, name: org)])
      bump(&projects[ok, default: [:]][pk, default: ReportNode(id: "p|\(ok)|\(pk)", kind: .project, name: project)])
      let leafKey = ref ?? ""
      bump(&leaves[ok, default: [:]][pk, default: [:]][leafKey, default: ReportNode(
        id: "c|\(ok)|\(pk)|\(leafKey)", kind: ref == nil ? .noCard : .card, name: card?.title ?? "", ref: ref)])
    }
    for a in allocs {
      switch a.target {
      case .unattributed: unattributed.seconds += a.seconds
      case .noCard: add(org: a.org, project: a.project, ref: nil, seconds: a.seconds)
      case .card(let ref): add(org: a.org, project: a.project, ref: ref, seconds: a.seconds)
      }
    }
    for c in cards where c.untracked { for (o, p) in pairs(c) { add(org: o, project: p, ref: c.ref, seconds: 0) } }
    let order: (ReportNode, ReportNode) -> Bool = { $0.seconds != $1.seconds ? $0.seconds > $1.seconds : $0.name < $1.name }
    var out = orgs.map { ok, org -> ReportNode in
      var org = org
      org.children = (projects[ok] ?? [:]).map { pk, p -> ReportNode in
        var p = p
        p.children = (leaves[ok]?[pk] ?? [:]).values.sorted(by: order)
        return p
      }.sorted(by: order)
      return org
    }.sorted(by: order)
    if unattributed.seconds > 0 { out.append(unattributed) }
    return out
  }
}
