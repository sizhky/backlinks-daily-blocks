import Foundation

/// `#RRGGBB` or `#RRGGBBAA` colour strings, as stored in settings.
public enum Hex {
  /// ```
  /// "#FF8000" -> (1, 0.502, 0, 1);  "#00000080" -> (0, 0, 0, 0.502);  "red" -> nil
  /// ```
  public static func rgba(_ s: String) -> (r: Double, g: Double, b: Double, a: Double)? {
    let t = s.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "#", with: "")
    guard t.count == 6 || t.count == 8, let v = UInt64(t, radix: 16) else { return nil }
    let full = t.count == 6 ? v << 8 | 0xFF : v
    return (Double(full >> 24 & 0xFF) / 255, Double(full >> 16 & 0xFF) / 255, Double(full >> 8 & 0xFF) / 255, Double(full & 0xFF) / 255)
  }

  /// Components 0...1 -> `#RRGGBB`, or `#RRGGBBAA` when alpha is below 1.
  public static func string(r: Double, g: Double, b: Double, a: Double = 1) -> String {
    let c = { (x: Double) in Int((min(1, max(0, x)) * 255).rounded()) }
    let rgb = String(format: "#%02X%02X%02X", c(r), c(g), c(b))
    return c(a) == 255 ? rgb : rgb + String(format: "%02X", c(a))
  }
}
