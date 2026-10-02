import Foundation

/// Desktop (Space) switching by pressing the user's macOS "Switch to Desktop N" shortcut.
public enum Spaces {
  public static let range = 1...9

  /// Key code and modifier bits of "Switch to Desktop N" from `AppleSymbolicHotKeys` (ids 118 to 126);
  /// nil when `n` is outside 1...9, or the shortcut is missing or disabled.
  /// ```
  /// ["119": enabled, parameters [50, 19, 1835008]] , 2 -> (code: 19, flags: 1835008)   // ^⌥⌘2
  /// ```
  public static func shortcut(_ n: Int, in hotkeys: [String: Any]) -> (code: UInt16, flags: UInt64)? {
    guard range.contains(n), let entry = hotkeys["\(117 + n)"] as? [String: Any],
      (entry["enabled"] as? NSNumber)?.boolValue == true,
      let value = entry["value"] as? [String: Any], let p = value["parameters"] as? [NSNumber], p.count >= 3
    else { return nil }
    return (p[1].uint16Value, p[2].uint64Value)
  }
}
