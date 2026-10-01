import SwiftUI

/// Card and row spacing. Compact is the original layout.
enum Density: String, CaseIterable, Identifiable {
  case compact, comfortable
  var id: String { rawValue }
  var label: String { rawValue.capitalized }

  static let key = "kanban.density"
  private var roomy: Bool { self == .comfortable }
  var cardPadH: CGFloat { roomy ? 14 : 11 }
  var cardPadV: CGFloat { roomy ? 13 : 9 }
  var cardGap: CGFloat { roomy ? 12 : 8 }
  var cardInner: CGFloat { roomy ? 8 : 5 }
  var titleSize: CGFloat { roomy ? 14 : 13 }
  var metaSize: CGFloat { roomy ? 12.5 : 11.5 }
  var columnWidth: CGFloat { roomy ? 340 : 316 }
  var groupTop: CGFloat { roomy ? 12 : 8 }
  var rowHeight: CGFloat { roomy ? 46 : 38 }
}

/// The app's Settings window (Cmd-,).
struct SettingsView: View {
  var body: some View {
    TabView {
      AppearanceSettings().tabItem { Label("Appearance", systemImage: "paintbrush") }
    }
    .frame(width: 420, height: 160)
  }
}

struct AppearanceSettings: View {
  @AppStorage(Density.key) private var density: Density = .compact

  var body: some View {
    Form {
      Picker("Density", selection: $density) {
        ForEach(Density.allCases) { Text($0.label).tag($0) }
      }
      .pickerStyle(.segmented)
      Text("Comfortable adds space around cards and list rows.")
        .font(.callout).foregroundStyle(.secondary)
    }
    .padding(24)
  }
}
