import Foundation

/// Desktop (Space) switching through BetterTouchTool named triggers `desktop-1` to `desktop-9`.
public enum Spaces {
  public static let range = 1...9

  /// URL that runs the BetterTouchTool named trigger for desktop `n`; nil outside 1...9.
  /// ```
  /// 2 -> btt://trigger_named/?trigger_name=desktop-2;  0 -> nil
  /// ```
  public static func url(_ n: Int) -> URL? {
    range.contains(n) ? URL(string: "btt://trigger_named/?trigger_name=desktop-\(n)") : nil
  }
}
