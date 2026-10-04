import Foundation

public enum Age {
  /// "30m" -> 0.5, "2d" -> 48; nil when unparseable.
  public static func hours(_ s: String) -> Double? {
    guard let unit = s.last, let n = Double(s.dropLast()) else { return nil }
    switch unit {
    case "m": return n / 60
    case "h": return n
    case "d": return n * 24
    case "w": return n * 168
    default: return nil
    }
  }
}

public enum Filter {
  /// Every term must hold; a negated term must fail. A keyed value `a,b` holds when `a` or `b` holds.
  /// ```
  /// "project:Vyasa,Drishti created:<5d" -> (Vyasa or Drishti) and created within 5 days
  /// ```
  public static func matches(_ card: Card, _ terms: [QueryTerm], now: Date = Date()) -> Bool {
    terms.allSatisfy { $0.negated != test(card, $0, now) }
  }

  public static func apply(_ columns: [Column], _ terms: [QueryTerm], now: Date = Date()) -> [Column] {
    guard !terms.isEmpty else { return columns }
    return columns.map { var c = $0; c.cards = c.cards.filter { matches($0, terms, now: now) }; return c }
  }

  /// Scope value that selects cards with no org.
  public static let noOrg = ""

  /// Keeps cards that belong to any of `orgs` (case-insensitive); empty keeps all;
  /// `noOrg` in the list also keeps cards with no org.
  /// ```
  /// scope(cards, orgs: ["Divami", noOrg]) -> Divami cards + cards without an org
  /// ```
  public static func scope(_ columns: [Column], orgs: [String]) -> [Column] {
    guard !orgs.isEmpty else { return columns }
    let wanted = Set(orgs.map { $0.lowercased() })
    let keep: (Card) -> Bool = { card in
      card.orgs.isEmpty ? wanted.contains(noOrg) : card.orgs.contains { wanted.contains($0.lowercased()) }
    }
    return columns.map { var c = $0; c.cards = c.cards.filter(keep); return c }
  }

  static func test(_ c: Card, _ t: QueryTerm, _ now: Date) -> Bool {
    guard t.key != nil, t.value.contains(",") else { return testOne(c, t, now) }
    return t.value.split(separator: ",").contains { testOne(c, QueryTerm(key: t.key, value: String($0), negated: false), now) }
  }

  static func testOne(_ c: Card, _ t: QueryTerm, _ now: Date) -> Bool {
    let v = t.value.lowercased()
    let any: ([String]) -> Bool = { $0.contains { $0.lowercased().contains(v) } }
    switch t.key {
    case nil: return c.title.lowercased().contains(v) || any(c.tags)
    case "col", "status", "in": return c.col.lowercased() == v
    case "tag", "t": return c.tags.contains { bare($0).hasPrefix(bare(v)) }
    case "project", "proj", "p": return any(c.projects)
    case "org", "o": return any(c.orgs)
    case "age": return compareAge(c, v)
    case "stale": return compareAge(c, ">=" + v)
    case "created", "c": return created(c, v, now)
    case "has": return present(c, v)
    case "no": return !present(c, v)
    default: return c.title.lowercased().contains("\(t.key ?? ""):\(v)")
    }
  }

  static func bare(_ s: String) -> String { s.lowercased().hasPrefix("#") ? String(s.dropFirst()).lowercased() : s.lowercased() }

  static func present(_ c: Card, _ field: String) -> Bool {
    switch field {
    case "project": return !c.projects.isEmpty
    case "org": return !c.orgs.isEmpty
    case "tag": return !c.tags.isEmpty
    default: return false
    }
  }

  /// `today`, `yesterday`, `week`, `month`, `2026-06-13`, `<3d` (within), `>3d` (older); bare `3d` = within.
  static func created(_ c: Card, _ v: String, _ now: Date) -> Bool {
    guard let made = c.created else { return false }
    let cal = Calendar.current
    switch v {
    case "today": return cal.isDate(made, inSameDayAs: now)
    case "yesterday": return cal.date(byAdding: .day, value: -1, to: now).map { cal.isDate(made, inSameDayAs: $0) } ?? false
    case "week": return cal.dateInterval(of: .weekOfYear, for: now)?.contains(made) ?? false
    case "month": return cal.dateInterval(of: .month, for: now)?.contains(made) ?? false
    default: break
    }
    var rest = Substring(v), op = "<"
    for p in [">", "<"] where rest.hasPrefix(p) { op = p; rest = rest.dropFirst(); break }
    if let limit = Age.hours(String(rest)) {
      let hours = now.timeIntervalSince(made) / 3600
      return op == ">" ? hours > limit : hours <= limit
    }
    let digits = rest.filter(\.isNumber)
    guard digits.count == 8, let day = Card.stamp.date(from: digits + "0000") else { return false }
    return cal.isDate(made, inSameDayAs: day)
  }

  /// `>3d`, `<2h`, `>=1w`, `<=5m`; a bare duration means `>=`.
  static func compareAge(_ c: Card, _ v: String) -> Bool {
    var rest = Substring(v), op = ">="
    for p in [">=", "<=", ">", "<"] where rest.hasPrefix(p) { op = p; rest = rest.dropFirst(p.count); break }
    guard let limit = Age.hours(String(rest)), let a = c.ageHours else { return false }
    switch op {
    case ">": return a > limit
    case "<": return a < limit
    case "<=": return a <= limit
    default: return a >= limit
    }
  }
}

public enum Ordering {
  /// `names` in the `saved` order; names not saved keep their own order after the saved ones.
  /// ```
  /// arranged(["a","b","c"], saved: ["c","x","a"]) -> ["c","a","b"]
  /// ```
  public static func arranged(_ names: [String], saved: [String]) -> [String] {
    saved.filter(names.contains) + names.filter { !saved.contains($0) }
  }

  /// Moves `name` to the slot of `target`: after it when moving down, before it when moving up.
  /// ```
  /// moving(["a","b","c"], "a", onto: "c") -> ["b","c","a"]
  /// ```
  public static func moving(_ names: [String], _ name: String, onto target: String) -> [String] {
    guard name != target, let from = names.firstIndex(of: name), let to = names.firstIndex(of: target) else { return names }
    var out = names
    out.insert(out.remove(at: from), at: to)
    return out
  }
}

/// A saved view: a query plus the workspaces it covers (empty = all workspaces, "" = no org).
public struct SavedFilter: Codable, Identifiable, Equatable, Sendable {
  public var id = UUID()
  public var name: String
  public var query: String
  public var orgs: [String]
  public init(id: UUID = UUID(), name: String, query: String, orgs: [String] = []) {
    self.id = id; self.name = name; self.query = query; self.orgs = orgs
  }

  enum CodingKeys: String, CodingKey { case id, name, query, orgs, org }

  /// Reads the older single-workspace `org` field as a one-item list.
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(UUID.self, forKey: .id)
    name = try c.decode(String.self, forKey: .name)
    query = try c.decode(String.self, forKey: .query)
    if let list = try c.decodeIfPresent([String].self, forKey: .orgs) { orgs = list }
    else { orgs = try c.decodeIfPresent(String.self, forKey: .org).map { [$0] } ?? [] }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id); try c.encode(name, forKey: .name)
    try c.encode(query, forKey: .query); try c.encode(orgs, forKey: .orgs)
  }

  public static let defaults = [
    SavedFilter(name: "Created today", query: "created:today"),
    SavedFilter(name: "Created this week", query: "created:week"),
    SavedFilter(name: "Doing", query: "col:Doing"),
    SavedFilter(name: "Active", query: "-col:done,cancelled,backlog"),
    SavedFilter(name: "Stale 7d+", query: "stale:7d -col:done,cancelled"),
    SavedFilter(name: "No project", query: "no:project"),
  ]
}
