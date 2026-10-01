import KanbanCore
import SwiftUI

/// Linear-style status colours.
func accent(for column: String) -> Color {
  switch column.lowercased() {
  case "backlog": Color(red: 0.54, green: 0.56, blue: 0.60)
  case "todo": Color(red: 0.88, green: 0.89, blue: 0.90)
  case "doing": Color(red: 0.95, green: 0.78, blue: 0.30)
  case "parked": Color(red: 0.62, green: 0.50, blue: 0.90)
  case "waiting": Color(red: 0.95, green: 0.55, blue: 0.30)
  case "done": Color(red: 0.37, green: 0.42, blue: 0.82)
  case "cancelled": Color(white: 0.40)
  default: Color(red: 0.37, green: 0.42, blue: 0.82)
  }
}

enum Palette {
  static let window = Color(red: 0.031, green: 0.035, blue: 0.039)
  static let base = Color(red: 0.059, green: 0.063, blue: 0.067)
  static let card = Color(red: 0.082, green: 0.086, blue: 0.094)
  static let cardHover = Color(red: 0.104, green: 0.108, blue: 0.120)
  static let hairline = Color.white.opacity(0.08)
  static let hairlineStrong = Color.white.opacity(0.17)
  static let hover = Color.white.opacity(0.05)
  static let active = Color.white.opacity(0.09)
  static let text = Color(red: 0.97, green: 0.97, blue: 0.97)
  static let secondary = Color(red: 0.82, green: 0.84, blue: 0.88)
  static let muted = Color(red: 0.54, green: 0.56, blue: 0.60)
  static let amber = Color(red: 0.96, green: 0.72, blue: 0.30)
  static let link = Color(red: 0.56, green: 0.63, blue: 0.98)
  static let selected = Color(red: 0.37, green: 0.42, blue: 0.82).opacity(0.2)
  static let indigo = Color(red: 0.37, green: 0.42, blue: 0.82)
}

/// Flat window colour; the main panel sits on it as an inset rounded sheet.
struct Backdrop: View {
  var body: some View { Palette.window }
}

func nameHue(_ name: String?) -> Double {
  Double((name ?? "").unicodeScalars.reduce(7) { ($0 &* 31 &+ Int($1.value)) % 360 }) / 360
}

/// Deterministic tile per project: a two-hue gradient from the name hash and the name's initials,
/// in a rounded tile as wide as `maxLetters` letters so rows stay aligned; shorter initials sit centred.
struct Monogram: View {
  let name: String?
  var size: CGFloat = 16
  var maxLetters = 3

  private var letters: String {
    guard let name else { return "·" }
    let initials = Card.initials(name)
    return String((initials.isEmpty ? String(name.prefix(1)) : initials).prefix(maxLetters))
  }

  private var fill: AnyShapeStyle {
    guard let name else { return AnyShapeStyle(Color.white.opacity(0.08)) }
    let hue = nameHue(name), shift = nameHue(String(name.reversed())) * 0.16 + 0.04
    return AnyShapeStyle(LinearGradient(
      colors: [Color(hue: hue, saturation: 0.55, brightness: 0.72),
               Color(hue: (hue + shift).truncatingRemainder(dividingBy: 1), saturation: 0.6, brightness: 0.5)],
      startPoint: .topLeading, endPoint: .bottomTrailing))
  }

  var body: some View {
    ZStack {
      Text(String(repeating: "H", count: maxLetters)).hidden()
      Text(letters).lineLimit(1).minimumScaleFactor(0.7).foregroundStyle(.white.opacity(0.95))
    }
    .font(.system(size: size * 0.55, weight: .bold)).tracking(0.2)
    .padding(.horizontal, maxLetters > 1 ? size * 0.2 : 0)
    .padding(.vertical, maxLetters > 1 ? size * 0.38 : 0)
    .frame(minWidth: size, minHeight: size)
    .background(fill, in: .rect(cornerRadius: size * 0.3))
    .overlay(RoundedRectangle(cornerRadius: size * 0.3).strokeBorder(.white.opacity(0.12)))
  }
}

/// Org logos live at `<Vault>/40-49 Areas/43 Orgs/<Org>/Logo.<ext>`.
enum OrgLogos {
  static let root = URL(fileURLWithPath: NSHomeDirectory() + "/Vault/40-49 Areas/43 Orgs")
  private static var cache: [String: (image: NSImage?, checked: Date)] = [:]

  static func image(for org: String) -> NSImage? {
    if let hit = cache[org], hit.image != nil || Date().timeIntervalSince(hit.checked) < 30 { return hit.image }
    let dir = root.appendingPathComponent(org)
    let file = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil))?
      .first { $0.deletingPathExtension().lastPathComponent.lowercased() == "logo" }
    let image = file.flatMap { NSImage(contentsOf: $0) }
    cache[org] = (image, Date())
    return image
  }
}

/// Org logo when the vault has one, otherwise the monogram tile.
struct OrgIcon: View {
  let name: String
  var size: CGFloat = 38

  var body: some View {
    if let logo = OrgLogos.image(for: name) {
      Image(nsImage: logo).resizable().scaledToFill().frame(width: size, height: size).clipped()
        .background(Color.white)
    } else {
      Monogram(name: name, size: size, maxLetters: 1)
    }
  }
}

enum Vault { static let name = "Vault" }

/// Card title with `[[wikilinks]]` as clickable links that open in Obsidian.
func renderTitle(_ title: String) -> AttributedString {
  var out = AttributedString()
  for segment in Title.segments(title, vault: Vault.name) {
    switch segment {
    case .text(let t): out += AttributedString(t)
    case .link(let label, let url):
      var run = AttributedString(label)
      run.link = URL(string: url)
      run.foregroundColor = Palette.link
      out += run
    }
  }
  return out
}

/// Leading state icon; one glyph per column, so status reads without text.
struct StatusGlyph: View {
  let column: String
  var size: CGFloat = 13

  private var symbol: String {
    switch column.lowercased() {
    case "backlog": "circle.dashed"
    case "todo": "circle"
    case "doing": "circle.lefthalf.filled"
    case "parked": "pause.circle"
    case "waiting": "hourglass.circle"
    case "done": "checkmark.circle.fill"
    case "cancelled": "xmark.circle"
    default: "circle"
    }
  }

  var body: some View {
    Image(systemName: symbol).font(.system(size: size, weight: .medium))
      .foregroundStyle(accent(for: column)).frame(width: size + 3)
  }
}

/// Bordered capsule used for labels, project and age on cards and rows.
struct Pill<Lead: View>: View {
  let text: String
  var color: Color = Palette.secondary
  @ViewBuilder var lead: Lead

  var body: some View {
    HStack(spacing: 5) { lead; Text(text).lineLimit(1) }
      .font(.system(size: 11.5, weight: .medium)).foregroundStyle(color)
      .padding(.horizontal, 8).padding(.vertical, 3)
      .overlay(Capsule().strokeBorder(Palette.hairline))
  }
}

func labelDot(_ tag: String) -> some View {
  Circle().fill(Color(hue: nameHue(tag), saturation: 0.55, brightness: 0.8)).frame(width: 7, height: 7)
}

/// Wraps children onto new lines, like Linear's property chips.
struct FlowLayout: Layout {
  var spacing: CGFloat = 6

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    layout(proposal.width ?? .infinity, subviews).size
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    for (view, origin) in zip(subviews, layout(bounds.width, subviews).origins) {
      view.place(at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y), proposal: .unspecified)
    }
  }

  private func layout(_ width: CGFloat, _ subviews: Subviews) -> (size: CGSize, origins: [CGPoint]) {
    var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, maxX: CGFloat = 0
    var origins: [CGPoint] = []
    for view in subviews {
      let size = view.sizeThatFits(.unspecified)
      if x > 0 && x + size.width > width { x = 0; y += rowHeight + spacing; rowHeight = 0 }
      origins.append(CGPoint(x: x, y: y))
      x += size.width + spacing
      rowHeight = max(rowHeight, size.height)
      maxX = max(maxX, x - spacing)
    }
    return (CGSize(width: maxX, height: y + rowHeight), origins)
  }
}

struct IconButton: View {
  let icon: String
  var help = ""
  var active = false
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      Image(systemName: icon).font(.system(size: 12.5, weight: .medium))
        .foregroundStyle(active ? Palette.text : Palette.muted)
        .frame(width: 28, height: 26)
        .background(active ? Palette.active : (hovering ? Palette.hover : .clear), in: .rect(cornerRadius: 6))
    }
    .buttonStyle(.plain).help(help).onHover { hovering = $0 }
  }
}
