import SwiftUI

/// Status dot only; the board itself stays achromatic (Linear-style restraint).
func accent(for column: String) -> Color {
  switch column.lowercased() {
  case "backlog": Color(white: 0.45)
  case "todo": Color(red: 0.62, green: 0.66, blue: 0.95)
  case "doing": Color(red: 0.96, green: 0.72, blue: 0.30)
  case "parked": Color(red: 0.62, green: 0.50, blue: 0.90)
  case "waiting": Color(red: 0.92, green: 0.45, blue: 0.42)
  case "done": Color(red: 0.40, green: 0.78, blue: 0.55)
  case "cancelled": Color(white: 0.32)
  default: Color(red: 0.37, green: 0.42, blue: 0.82)
  }
}

enum Palette {
  static let base = Color(red: 0.043, green: 0.047, blue: 0.055)
  static let column = Color.white.opacity(0.025)
  static let card = Color(red: 0.086, green: 0.094, blue: 0.106)
  static let cardHover = Color(red: 0.113, green: 0.122, blue: 0.137)
  static let hairline = Color.white.opacity(0.07)
  static let hairlineStrong = Color.white.opacity(0.18)
  static let text = Color(red: 0.97, green: 0.97, blue: 0.97)
  static let muted = Color(red: 0.54, green: 0.56, blue: 0.60)
  static let amber = Color(red: 0.96, green: 0.72, blue: 0.30)
  static let indigo = Color(red: 0.37, green: 0.42, blue: 0.82)
}

/// Near-black base with one faint indigo glow for the glass layer to refract.
struct Backdrop: View {
  var body: some View {
    ZStack {
      Palette.base
      RadialGradient(colors: [Palette.indigo.opacity(0.22), .clear],
                     center: .init(x: 0.5, y: -0.1), startRadius: 0, endRadius: 520)
    }
  }
}

/// Deterministic muted tile per project, so ownership reads without text.
struct Monogram: View {
  let name: String?
  var size: CGFloat = 16

  private var hue: Double {
    Double((name ?? "").unicodeScalars.reduce(7) { ($0 &* 31 &+ Int($1.value)) % 360 }) / 360
  }

  var body: some View {
    RoundedRectangle(cornerRadius: size * 0.3)
      .fill(name == nil ? Color.white.opacity(0.08) : Color(hue: hue, saturation: 0.45, brightness: 0.62))
      .frame(width: size, height: size)
      .overlay {
        Text(name.map { String($0.prefix(1)).uppercased() } ?? "–")
          .font(.system(size: size * 0.58, weight: .bold)).foregroundStyle(.white.opacity(0.92))
      }
  }
}
