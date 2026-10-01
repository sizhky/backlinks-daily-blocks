import Foundation

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
  public static func parse(_ text: String) -> [QueryTerm] {
    tokens(text).map { token in
      let negated = token.hasPrefix("-") && token.count > 1
      let body = negated ? String(token.dropFirst()) : token
      guard let colon = body.firstIndex(of: ":"), colon != body.startIndex else {
        return QueryTerm(key: nil, value: body, negated: negated)
      }
      let value = body[body.index(after: colon)...]
      return QueryTerm(key: body[..<colon].lowercased(), value: String(value), negated: negated)
    }
  }

  static func tokens(_ text: String) -> [String] {
    var out: [String] = [], current = "", quoted = false
    for ch in text {
      if ch == "\"" { quoted.toggle() }
      else if ch == " " && !quoted { if !current.isEmpty { out.append(current); current = "" } }
      else { current.append(ch) }
    }
    if !current.isEmpty { out.append(current) }
    return out
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
