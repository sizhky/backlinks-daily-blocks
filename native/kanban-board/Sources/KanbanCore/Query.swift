import Foundation

/// A boolean filter over terms (`Query.expression`).
public indirect enum QueryExpr: Equatable, Sendable {
  case term(QueryTerm), all([QueryExpr]), any([QueryExpr])

  /// `holds` answers one plain value; a keyed `a,b` holds when either does, and `-` negates the term.
  public func eval(_ holds: (QueryTerm) -> Bool) -> Bool {
    switch self {
    case .all(let parts): return parts.allSatisfy { $0.eval(holds) }
    case .any(let parts): return parts.contains { $0.eval(holds) }
    case .term(let t):
      let values = t.key != nil && t.value.contains(",") ? t.value.split(separator: ",").map(String.init) : [t.value]
      return t.negated != values.contains { holds(QueryTerm(key: t.key, value: $0, negated: false)) }
    }
  }
}

/// One filter term: `key:value`, `-key:value`, or bare text (key == nil).
public struct QueryTerm: Equatable, Sendable {
  public var key: String?
  public var value: String
  public var negated: Bool
}

public enum Query {
  /// Split on spaces; double quotes group; leading `-` negates.
  /// ```
  /// parse(#"col:Doing -tag:#win project:"Obsidian Workflow" call"#)
  ///   -> [col=Doing, !tag=#win, project=Obsidian Workflow, text=call]
  /// ```
  public static func parse(_ text: String) -> [QueryTerm] { tokens(text).map(term) }

  static func term(_ token: String) -> QueryTerm {
    let negated = token.hasPrefix("-") && token.count > 1
    let body = negated ? String(token.dropFirst()) : token
    guard let colon = body.firstIndex(of: ":"), colon != body.startIndex else {
      return QueryTerm(key: nil, value: body, negated: negated)
    }
    let value = body[body.index(after: colon)...]
    return QueryTerm(key: body[..<colon].lowercased(), value: String(value), negated: negated)
  }

  /// Splits on spaces outside quotes; with `parens`, `(` and `)` outside quotes are tokens of their own.
  static func tokens(_ text: String, parens: Bool = false) -> [String] {
    var out: [String] = [], current = "", quoted = false
    let flush = { if !current.isEmpty { out.append(current); current = "" } }
    for ch in text {
      if ch == "\"" { quoted.toggle() }
      else if ch == " " && !quoted { flush() }
      else if parens, !quoted, ch == "(" || ch == ")" { flush(); out.append(String(ch)) }
      else { current.append(ch) }
    }
    flush()
    return out
  }

  /// A filter with `and`, `or` and parentheses; terms side by side mean `and`, which binds tighter
  /// than `or`. nil for an empty filter. A stray `)` or a missing one is forgiven.
  /// ```
  /// expression("(org:Divami desktop:2) or project:Vyasa,Arka")
  ///   -> any[all[org=Divami, desktop=2], project=Vyasa,Arka]
  /// ```
  public static func expression(_ text: String) -> QueryExpr? {
    var tokens = tokens(text, parens: true)[...]
    func or() -> QueryExpr? {
      var parts: [QueryExpr] = []
      while true {
        if let a = and() { parts.append(a) }
        guard tokens.first?.lowercased() == "or" else { break }
        tokens.removeFirst()
      }
      return parts.count > 1 ? .any(parts) : parts.first
    }
    func and() -> QueryExpr? {
      var parts: [QueryExpr] = []
      while let t = tokens.first, t != ")", t.lowercased() != "or" {
        tokens.removeFirst()
        if t.lowercased() == "and" { continue }
        if t == "(" {
          if let inner = or() { parts.append(inner) }
          if tokens.first == ")" { tokens.removeFirst() }
        } else {
          parts.append(.term(term(t)))
        }
      }
      return parts.count > 1 ? .all(parts) : parts.first
    }
    var out: [QueryExpr] = []
    while !tokens.isEmpty {
      if let e = or() { out.append(e) }
      if tokens.first == ")" { tokens.removeFirst() }
    }
    return out.count > 1 ? .all(out) : out.first
  }

  /// Single-valued keys: a new value replaces the old one instead of narrowing to nothing.
  public static let singleValued: Set<String> = ["project", "org", "col"]

  public static func canonical(_ key: String) -> String {
    ["proj": "project", "p": "project", "o": "org", "status": "col", "in": "col", "t": "tag"][key] ?? key
  }

  public static func format(_ terms: [QueryTerm]) -> String {
    terms.map { t in
      let value = t.value.contains(" ") ? "\"\(t.value)\"" : t.value
      return (t.negated ? "-" : "") + (t.key.map { $0 + ":" } ?? "") + value
    }.joined(separator: " ")
  }

  /// Sets `term` (e.g. `project:Vyasa`) as the only positive term for its key;
  /// repeating the same term clears it.
  /// ```
  /// toggling("project:Vyasa tag:x", "project:Drishti") -> "tag:x project:Drishti"
  /// toggling("project:Vyasa", "project:Vyasa")         -> ""
  /// ```
  public static func toggling(_ query: String, term: String) -> String {
    guard let new = parse(term).first, let key = new.key.map(canonical) else { return query }
    let same: (QueryTerm) -> Bool = { !$0.negated && $0.key.map(canonical) == key }
    let old = parse(query).filter(same)
    let rest = parse(query).filter { !same($0) }
    let cleared = old.count == 1 && old[0].value.lowercased() == new.value.lowercased()
    return format(cleared ? rest : rest + [new])
  }
}
