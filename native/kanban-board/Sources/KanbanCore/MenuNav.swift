/// Keyboard stepping through a menu whose rows may be disabled or separators.
public enum MenuNav {
  /// Next enabled row from `index` in `direction` (+1 or -1), wrapping; nil when no row is enabled.
  /// With no current row, +1 starts at the first enabled row and -1 at the last.
  /// ```
  /// step([true, false, true], from: 0, by: 1) -> 2
  /// step([true, false, true], from: 2, by: 1) -> 0
  /// step([true, false, true], from: nil, by: -1) -> 2
  /// ```
  public static func step(_ enabled: [Bool], from index: Int?, by direction: Int) -> Int? {
    guard enabled.contains(true) else { return nil }
    let n = enabled.count
    var i = index ?? (direction > 0 ? -1 : n)
    for _ in 0..<n {
      i = ((i + direction) % n + n) % n
      if enabled[i] { return i }
    }
    return nil
  }
}
