import Foundation

/// A filter key and the values it accepts.
public struct CatalogKey: Equatable, Sendable {
  public var name: String
  public var aliases: [String] = []
  public var values: [String] = []
}

/// One completion for the term being typed. `term` replaces that term as a whole.
public struct Suggestion: Equatable, Sendable {
  public var label: String
  public var term: String
  public var isKey: Bool
}

/// The keys and values the filter field and command palette complete.
public struct Catalog: Sendable {
  public var keys: [CatalogKey]

  /// Static values live here; the rest come from the board.
  public static func make(columns: [String] = [], projects: [String] = [], orgs: [String] = [],
                          tags: [String] = [], views: [String] = []) -> Catalog {
    Catalog(keys: [
      CatalogKey(name: "col", aliases: ["status", "in"], values: columns),
      CatalogKey(name: "project", aliases: ["proj", "p"], values: projects),
      CatalogKey(name: "org", aliases: ["o"], values: orgs),
      CatalogKey(name: "tag", aliases: ["t"], values: tags),
      CatalogKey(name: "created", aliases: ["c"], values: ["today", "yesterday", "week", "month", "<1d", "<3d", ">3d", ">1w"]),
      CatalogKey(name: "age", values: [">1d", ">3d", ">1w", "<1d"]),
      CatalogKey(name: "stale", values: ["1d", "3d", "7d", "14d"]),
      CatalogKey(name: "has", values: ["project", "org", "tag"]),
      CatalogKey(name: "no", values: ["project", "org", "tag"]),
      CatalogKey(name: "view", values: views),
    ])
  }

  /// Splits at the last space outside quotes: everything before, and the term being typed.
  public static func split(_ text: String) -> (head: String, token: String) {
    var quoted = false, cut = text.startIndex
    for i in text.indices {
      if text[i] == "\"" { quoted.toggle() }
      else if text[i] == " " && !quoted { cut = text.index(after: i) }
    }
    return (String(text[..<cut]), String(text[cut...]))
  }

  /// Completions for the last term: key names while no colon yet, values after one.
  /// ```
  /// suggest("vi")         -> view:
  /// suggest("crea")       -> created:
  /// suggest("created:to") -> created:today
  /// suggest("-col:do")    -> -col:Doing, -col:Done
  /// ```
  public func suggest(_ text: String) -> [Suggestion] {
    let token = Self.split(text).token
    let negated = token.hasPrefix("-"), sign = negated ? "-" : ""
    let body = negated ? String(token.dropFirst()) : token
    guard !body.isEmpty else { return [] }
    guard let colon = body.firstIndex(of: ":"), colon != body.startIndex else {
      let typed = body.lowercased()
      let byName = keys.filter { $0.name.hasPrefix(typed) }
      let byAlias = keys.filter { k in !byName.contains(k) && k.aliases.contains { $0.hasPrefix(typed) } }
      return (byName + byAlias).map { Suggestion(label: $0.name + ":", term: sign + $0.name + ":", isKey: true) }
    }
    let typedKey = String(body[..<colon]).lowercased()
    guard let key = keys.first(where: { $0.name == typedKey || $0.aliases.contains(typedKey) }) else { return [] }
    let typed = body[body.index(after: colon)...].replacingOccurrences(of: "\"", with: "").lowercased()
    let starts = key.values.filter { $0.lowercased().hasPrefix(typed) }
    let inside = key.values.filter { !starts.contains($0) && $0.lowercased().contains(typed) }
    return (starts + inside).filter { $0.lowercased() != typed }.map {
      let value = $0.contains(" ") ? "\"\($0)\"" : $0
      return Suggestion(label: $0, term: "\(sign)\(typedKey):\(value)", isKey: false)
    }
  }

  /// `text` with its last term replaced; a finished value gets a trailing space.
  public static func replacing(_ text: String, with s: Suggestion) -> String {
    split(text).head + s.term + (s.isKey ? "" : " ")
  }
}
