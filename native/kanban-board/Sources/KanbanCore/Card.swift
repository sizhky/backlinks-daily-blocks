import Foundation

public struct Card: Identifiable, Equatable, Sendable {
  public let ref: String, file: String, line: Int, col: String
  public let title: String, age: String
  public let tags: [String], orgs: [String], projects: [String]
  public var id: String { ref }
  public var ageHours: Double? { Age.hours(age) }

  /// Fields: col, file:line, body, age, orgs(a|b), projects(a|b).
  init?(fields f: [String]) {
    guard f.count >= 4, let colon = f[1].lastIndex(of: ":"),
      let line = Int(f[1][f[1].index(after: colon)...]) else { return nil }
    let body = f[2]
    self.init(ref: f[1], file: String(f[1][..<colon]), line: line, col: f[0],
      title: Self.strip(body), age: f[3], tags: Self.tags(in: body),
      orgs: f.count > 4 ? Self.list(f[4]) : [], projects: f.count > 5 ? Self.list(f[5]) : [])
  }

  init(ref: String, file: String, line: Int, col: String, title: String, age: String,
       tags: [String], orgs: [String], projects: [String]) {
    (self.ref, self.file, self.line, self.col, self.title, self.age) = (ref, file, line, col, title, age)
    (self.tags, self.orgs, self.projects) = (tags, orgs, projects)
  }

  public func moved(to col: String) -> Card {
    Card(ref: ref, file: file, line: line, col: col, title: title, age: "0m",
         tags: tags, orgs: orgs, projects: projects)
  }

  static let tagPattern = #"(?<![\w])#[\p{L}\p{N}_/-]+"#

  static func list(_ s: String) -> [String] { s.split(separator: "|").map(String.init).filter { !$0.isEmpty } }

  /// Tags shown on the card; `#kb/<column>` bookkeeping tags are dropped.
  static func tags(in body: String) -> [String] {
    let re = try! NSRegularExpression(pattern: tagPattern)
    let found = re.matches(in: body, range: NSRange(body.startIndex..., in: body))
      .compactMap { Range($0.range, in: body).map { String(body[$0]) } }
    return found.filter { !$0.lowercased().hasPrefix("#kb/") }
  }

  static func strip(_ body: String) -> String {
    body.replacingOccurrences(of: tagPattern, with: "", options: .regularExpression)
      .split(whereSeparator: \.isWhitespace).joined(separator: " ")
  }
}

public struct Column: Identifiable, Equatable, Sendable {
  public let name: String
  public let done: Bool
  public var cards: [Card]
  public var id: String { name }
}

public enum Board {
  /// Parses the `@column<TAB>Name<TAB>live|done` + card-row output of the board script.
  /// ```
  /// "=> \n@column\tDoing\tlive\nDoing\ta.md:3\tWrite #x\t2h\tOrg\tProj"
  ///   -> [Column(Doing, [Card(title: "Write", tags: ["#x"], projects: ["Proj"])])]
  /// ```
  public static func parse(_ output: String) -> [Column] {
    let trimmed = output.drop(while: \.isWhitespace)
    let payload = trimmed.hasPrefix("=>") ? String(trimmed.dropFirst(2).drop(while: \.isWhitespace)) : output
    var columns: [Column] = []
    for row in payload.split(whereSeparator: \.isNewline) {
      let f = row.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
      if f.first == "@column", f.count >= 2 {
        columns.append(Column(name: f[1], done: f.count > 2 && f[2] == "done", cards: []))
      } else if !columns.isEmpty, let card = Card(fields: f) {
        columns[columns.count - 1].cards.append(card)
      }
    }
    return columns
  }
}
