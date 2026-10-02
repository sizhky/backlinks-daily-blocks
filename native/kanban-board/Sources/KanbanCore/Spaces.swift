import Foundation

/// Desktop (Space) switching through BetterTouchTool's "Switch to Desktop N" action (IDs 207 to 215).
public enum Spaces {
  public static let range = 1...9

  /// URL that runs BetterTouchTool's switch-to-desktop action for `n`; nil outside 1...9.
  /// ```
  /// 2 -> btt://trigger_action/?json={"BTTPredefinedActionType":208};  0 -> nil
  /// ```
  public static func url(_ n: Int) -> URL? {
    guard range.contains(n) else { return nil }
    return URL(string: "btt://trigger_action/?json=%7B%22BTTPredefinedActionType%22%3A\(206 + n)%7D")
  }
}
