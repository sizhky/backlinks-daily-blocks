import Foundation

/// Desktop (Space) switching: macOS binds Control-1 to Control-9 to "Switch to Desktop N".
public enum Spaces {
  public static let range = 1...9

  /// Virtual key code of the number-row key for desktop `n`; nil outside 1...9.
  /// ```
  /// 1 -> 18;  5 -> 23;  9 -> 25;  0 -> nil
  /// ```
  public static func keyCode(_ n: Int) -> UInt16? {
    let codes: [UInt16] = [18, 19, 20, 21, 23, 22, 26, 28, 25]
    return range.contains(n) ? codes[n - 1] : nil
  }
}
