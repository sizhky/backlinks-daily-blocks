import Foundation

public enum TitleSegment: Equatable, Sendable {
  case text(String)
  case link(label: String, url: String)
}

public enum Title {
  static let pattern = try! NSRegularExpression(
    pattern: #"\[\[([^\]|]+)(?:\|([^\]]*))?\]\]|\[([^\]]+)\]\((https?://[^)\s]+)\)"#)

  /// Splits a card title into plain text, `[[wikilinks]]`, and `[label](https://…)` links.
  /// Wikilinks become `obsidian://open` URLs for `vault`.
  /// ```
  /// segments("See [[Plan#Goals|goals]] now", vault: "V")
  ///   -> [text("See "), link("goals", "obsidian://open?vault=V&file=Plan%23Goals"), text(" now")]
  /// ```
  public static func segments(_ title: String, vault: String) -> [TitleSegment] {
    let ns = title as NSString
    var out: [TitleSegment] = [], cursor = 0
    for m in pattern.matches(in: title, range: NSRange(location: 0, length: ns.length)) {
      if m.range.location > cursor { out.append(.text(ns.substring(with: NSRange(location: cursor, length: m.range.location - cursor)))) }
      cursor = m.range.location + m.range.length
      if m.range(at: 1).location != NSNotFound {
        let target = ns.substring(with: m.range(at: 1)).trimmingCharacters(in: .whitespaces)
        let alias = m.range(at: 2).location == NSNotFound ? "" : ns.substring(with: m.range(at: 2))
        out.append(.link(label: alias.isEmpty ? label(for: target) : alias,
                         url: "obsidian://open?vault=\(encode(vault))&file=\(encode(target))"))
      } else {
        out.append(.link(label: ns.substring(with: m.range(at: 3)), url: ns.substring(with: m.range(at: 4))))
      }
    }
    if cursor < ns.length { out.append(.text(ns.substring(from: cursor))) }
    return out
  }

  /// `Folder/Note#Heading` -> `Note › Heading`
  static func label(for target: String) -> String {
    let parts = target.split(separator: "#", maxSplits: 1).map(String.init)
    let note = parts[0].split(separator: "/").last.map(String.init) ?? parts[0]
    return parts.count > 1 ? note + " › " + parts[1] : note
  }

  static func encode(_ s: String) -> String {
    s.addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(.init(charactersIn: "-._~"))) ?? s
  }
}
