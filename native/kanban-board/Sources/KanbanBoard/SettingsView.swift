import SwiftUI

/// Card and row spacing. Compact is the original layout.
enum Density: String, CaseIterable, Identifiable {
  case compact, comfortable, large
  var id: String { rawValue }
  var label: String { rawValue.capitalized }

  static let key = "kanban.density"
  private func pick<T>(_ compact: T, _ comfortable: T, _ large: T) -> T {
    switch self { case .compact: compact; case .comfortable: comfortable; case .large: large }
  }
  var cardPadH: CGFloat { pick(11, 14, 16) }
  var cardPadV: CGFloat { pick(9, 13, 16) }
  var cardGap: CGFloat { pick(8, 12, 14) }
  var cardInner: CGFloat { pick(5, 8, 10) }
  var titleSize: CGFloat { pick(13, 14, 16) }
  var metaSize: CGFloat { pick(11.5, 12.5, 14) }
  var columnWidth: CGFloat { pick(316, 340, 380) }
  var rowHeight: CGFloat { pick(38, 46, 54) }
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
      Text("Larger options add space and enlarge text on cards and list rows.")
        .font(.callout).foregroundStyle(.secondary)
    }
    .padding(24)
  }
}
