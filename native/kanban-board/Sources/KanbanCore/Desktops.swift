import Foundation

/// One user desktop (macOS Space) with its optional name from the label store.
/// macOS has no desktop names; like yabai's `space --label`, names live in our own store,
/// keyed by the Space UUID so they survive reordering: `<vault>/.activity/desktops.json`.
public struct DesktopSpace: Equatable, Sendable, Identifiable {
  /// CGS space id (`id64`), stable while the Space exists.
  public let id: Int
  public let uuid: String
  /// 1-based across displays, as "Switch to Desktop N" counts.
  public let number: Int
  /// 0-based display index and 1-based number within that display, as Mission Control shows it.
  public let display: Int, local: Int
  public var label: String?
  public var name: String { label ?? "Desktop \(number)" }
  /// What a card stores in `%% kbdesktop %%`: the name when set, else the number.
  public var ref: String { label ?? String(number) }
}

public enum Desktops {
  /// User desktops from `CGSCopyManagedDisplaySpaces` output; full-screen apps (type 4) are skipped.
  /// ```
  /// [{Spaces: [{id64 5, uuid "A", type 0}, {id64 9, type 4}, {id64 7, uuid "B", type 0}]}], labels ["B": "PenguinAI"]
  ///   -> [Desktop 1 (A), PenguinAI = desktop 2 (B)]
  /// ```
  public static func parse(displays: [[String: Any]], labels: [String: String]) -> [DesktopSpace] {
    var out: [DesktopSpace] = []
    for (d, display) in displays.enumerated() {
      var local = 0
      for space in display["Spaces"] as? [[String: Any]] ?? [] {
        guard (space["type"] as? NSNumber)?.intValue == 0 else { continue }
        local += 1
        let id = (space["id64"] as? NSNumber)?.intValue ?? (space["ManagedSpaceID"] as? NSNumber)?.intValue ?? 0
        // The first desktop reports an empty uuid; its id64 stands in so keys never collide.
        let raw = space["uuid"] as? String ?? ""
        let uuid = raw.isEmpty ? "space-\(id)" : raw
        out.append(DesktopSpace(id: id, uuid: uuid, number: out.count + 1, display: d, local: local, label: labels[uuid]))
      }
    }
    return out
  }

  /// The desktop a card reference points at: a number 1-9, else a name (case-insensitive).
  public static func resolve(_ ref: String?, in spaces: [DesktopSpace]) -> DesktopSpace? {
    guard let ref = ref?.trimmingCharacters(in: .whitespaces), !ref.isEmpty else { return nil }
    if let n = Int(ref) { return spaces.first { $0.number == n } }
    return spaces.first { $0.label?.caseInsensitiveCompare(ref) == .orderedSame }
  }

  /// Whether a card reference names the desktop observed as `number` / `label`.
  public static func matches(_ ref: String, number: Int?, label: String?) -> Bool? {
    if let n = Int(ref) { return number.map { $0 == n } }
    guard number != nil || label != nil else { return nil }
    return label?.caseInsensitiveCompare(ref) == .orderedSame
  }

  /// A safe name: trimmed, 1 to 40 characters, no `%` or newlines, not only digits
  /// (a digit-only name would read as a desktop number). nil clears the name.
  public static func cleanLabel(_ s: String) -> String? {
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !t.isEmpty, t.count <= 40, !t.contains("%"), !t.contains("\n"), Int(t) == nil else { return nil }
    return t
  }

  public static func labels(from data: Data?) -> [String: String] {
    data.flatMap { try? JSONDecoder().decode([String: String].self, from: $0) } ?? [:]
  }

  public static func encode(_ labels: [String: String]) -> Data {
    let e = JSONEncoder()
    e.outputFormatting = [.prettyPrinted, .sortedKeys]
    return (try? e.encode(labels)) ?? Data("{}".utf8)
  }
}
