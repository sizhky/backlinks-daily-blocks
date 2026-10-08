import Foundation

/// A colour in OKLCH: perceptual lightness `l` (0...1), chroma `c`, hue `h` in degrees.
public struct OKLCH: Equatable {
  public var l, c, h: Double
  public init(l: Double, c: Double, h: Double) { (self.l, self.c, self.h) = (l, c, h) }

  /// sRGB channels in 0...1, clipped to the gamut (Ottosson's OKLab matrices).
  public var rgb: (r: Double, g: Double, b: Double) {
    let a = c * cos(h * .pi / 180), b = c * sin(h * .pi / 180)
    let l_ = pow(l + 0.3963377774 * a + 0.2158037573 * b, 3)
    let m_ = pow(l - 0.1055613458 * a - 0.0638541728 * b, 3)
    let s_ = pow(l - 0.0894841775 * a - 1.2914855480 * b, 3)
    let lin = (4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
               -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
               -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_)
    func encode(_ v: Double) -> Double {
      let x = min(max(v, 0), 1)
      return x <= 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1 / 2.4) - 0.055
    }
    return (encode(lin.0), encode(lin.1), encode(lin.2))
  }
}

/// Deterministic project colours: the hue comes from an FNV-1a hash of the name, so similar names
/// land far apart; equal lightness and chroma keep every hue equally bright on the dark UI.
public enum ProjectColor {
  public static func hue(_ name: String) -> Double {
    var h: UInt32 = 2_166_136_261
    for byte in name.utf8 { h = (h ^ UInt32(byte)) &* 16_777_619 }
    return Double(h % 360)
  }

  /// Gradient ends for a project tile: light top-left, darker bottom-right, hue shifted 25 to 45 degrees.
  /// `hue` overrides the hashed hue (a colour the user picked).
  public static func pair(_ name: String, hue picked: Double? = nil) -> (light: OKLCH, dark: OKLCH) {
    let hue = picked ?? hue(name), shift = 25 + Double(Self.hue(String(name.reversed()))).truncatingRemainder(dividingBy: 20)
    return (OKLCH(l: 0.68, c: 0.13, h: hue), OKLCH(l: 0.5, c: 0.11, h: (hue + shift).truncatingRemainder(dividingBy: 360)))
  }
}
