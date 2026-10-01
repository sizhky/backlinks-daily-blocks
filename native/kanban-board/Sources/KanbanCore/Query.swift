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
}
