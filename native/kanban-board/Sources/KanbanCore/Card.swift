import Foundation

public struct Card: Identifiable, Equatable, Sendable {
  public let ref: String, file: String, line: Int, col: String
  public let title: String, age: String
  public let tags: [String], orgs: [String], projects: [String]
  /// Manual order in its column (`%% kbrank %%`); nil = unranked.
  public var rank: Double?
  /// macOS desktop 1 to 9 the card's work lives on (`%% kbdesktop N %%`); nil = none.
  public var desktop: Int?
  /// 1-based position among the note's checkbox tasks; nil when the row has none.
  public var ordinal: Int?
  /// Number of checkbox tasks in the note; nil when the row has none.
  public var siblings: Int?
  /// When the card entered a done (`=x`) column; nil for live and cancelled cards.
  public var doneAt: Date?
  /// View identity that survives line shifts (`file|title`, set by `Board.parse`); `ref` changes
  /// whenever a line is inserted above the task, which would make SwiftUI re-insert the card.
  public var id: String
  public var ageHours: Double? { Age.hours(age) }

  /// Creation time from the daily-note file name `YYYYMMDD-HHmm[...].md`.
  public var created: Date? {
    let parts = file.split(separator: "-")
    guard parts.count >= 2, parts[0].count == 8, parts[1].count >= 4 else { return nil }
    return Self.stamp.date(from: String(parts[0]) + String(parts[1].prefix(4)))
  }

  static let stamp: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyyMMddHHmm"
    return f
  }()

  /// Linear-style short id: project key + the note's `yyMMdd-HHmm` (unique, unlike HHmm alone), `.ordinal` (two digits) when the note has more than one task.
  /// The ordinal, not the line, so move stamps inserted above a task do not change its id.
  /// ```
  /// Obsidian Workflow, 20260613-1844.md task 1 of 1 -> "OW-260613-1844"
  /// Vyasa, 20260613-0946.md task 1 of 3 -> "VYA-260613-0946.01"
  /// non-daily note "20260704 - Plan of Action.md" -> "TAS-" + 4-character base-36 hash of the name, e.g. "TAS-K3F9"
  /// ```
  public var identifier: String {
    let source = projects.first ?? orgs.first ?? "Task"
    let initials = Self.initials(source)
    let key = initials.count >= 2 ? initials : String(source.filter { $0.isLetter || $0.isNumber }.prefix(3))
    let name = (file as NSString).lastPathComponent
    let daily = name.wholeMatch(of: #/(\d{8})-(\d{4})(\..*)?\.md/#)
    let stamp = daily.map { $0.1.dropFirst(2) + "-" + $0.2 } ?? Substring(Self.hash4(name))
    return key.uppercased() + "-" + stamp + (ordinal.map { (siblings ?? $0) > 1 ? "." + String(format: "%02d", $0) : "" } ?? "")
  }

  /// FNV-1a of the name, as 4 upper-case base-36 characters.
  static func hash4(_ name: String) -> String {
    var h: UInt32 = 2166136261
    for b in name.utf8 { h = (h ^ UInt32(b)) &* 16777619 }
    let s = String(h % 1_679_616, radix: 36).uppercased()
    return String(repeating: "0", count: 4 - s.count) + s
  }

  /// First letter of each word, at most three, upper-cased.
  /// ```
  /// "Horizontal Training Pipeline" -> "HTP";  "Obsidian Workflow" -> "OW";  "Vyasa" -> "V";  "??" -> ""
  /// ```
  public static func initials(_ name: String) -> String {
    name.split { !$0.isLetter && !$0.isNumber }.prefix(3).compactMap(\.first).map(String.init).joined().uppercased()
  }

  /// Fields: col, file:line, body, age, orgs(a|b), projects(a|b), rank, desktop, ordinal, siblings, doneAt (ISO).
  init?(fields f: [String]) {
    guard f.count >= 4, let colon = f[1].lastIndex(of: ":"),
      let line = Int(f[1][f[1].index(after: colon)...]) else { return nil }
    let body = f[2]
    self.init(ref: f[1], file: String(f[1][..<colon]), line: line, col: f[0],
      title: Self.strip(body), age: f[3], tags: Self.tags(in: body),
      orgs: f.count > 4 ? Self.list(f[4]) : [], projects: f.count > 5 ? Self.list(f[5]) : [])
    rank = f.count > 6 ? Double(f[6]) : nil
    desktop = f.count > 7 ? Int(f[7]).flatMap { Spaces.range.contains($0) ? $0 : nil } : nil
    ordinal = f.count > 8 ? Int(f[8]) : nil
    siblings = f.count > 9 ? Int(f[9]) : nil
    doneAt = f.count > 10 ? Self.iso.date(from: f[10]) : nil
  }

  init(ref: String, file: String, line: Int, col: String, title: String, age: String,
       tags: [String], orgs: [String], projects: [String]) {
    (self.ref, self.file, self.line, self.col, self.title, self.age) = (ref, file, line, col, title, age)
    id = ref
    (self.tags, self.orgs, self.projects) = (tags, orgs, projects)
  }

  public func moved(to col: String) -> Card {
    var c = Card(ref: ref, file: file, line: line, col: col, title: title, age: "0m",
         tags: tags, orgs: orgs, projects: projects)
    c.rank = rank
    c.desktop = desktop
    c.ordinal = ordinal
    c.siblings = siblings
    c.id = id
    return c
  }

  nonisolated(unsafe) static let iso: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }()

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
  /// Target column names of the plugin's sweep routes from this column.
  public var sweeps: [String] = []
  public var id: String { name }
}

public enum Board {
  /// Parses the `@column<TAB>Name<TAB>live|done` + card-row output of the board script.
  /// `@sweep<TAB>From<TAB>To` rows add To to the From column's `sweeps`.
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
      if f.first == "@sweep", f.count >= 3 {
        columns.firstIndex { $0.name.caseInsensitiveCompare(f[1]) == .orderedSame }
          .map { columns[$0].sweeps.append(f[2]) }
      } else if f.first == "@column", f.count >= 2 {
        columns.append(Column(name: f[1], done: f.count > 2 && f[2] == "done", cards: []))
      } else if !columns.isEmpty, let card = Card(fields: f) {
        columns[columns.count - 1].cards.append(card)
      }
    }
    var seen: [String: Int] = [:]
    for i in columns.indices {
      for j in columns[i].cards.indices {
        let base = columns[i].cards[j].file + "|" + columns[i].cards[j].title
        let n = seen[base, default: 0]
        seen[base] = n + 1
        columns[i].cards[j].id = n == 0 ? base : "\(base)#\(n)"
      }
    }
    return columns
  }
}
