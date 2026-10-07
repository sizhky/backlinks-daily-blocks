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
      WidgetSettings().tabItem { Label("Widget", systemImage: "rectangle.topthird.inset.filled") }
    }
    .frame(width: 420, height: 330)
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

/// Tracker widget: visibility, which lines it shows, text size and width.
struct WidgetSettings: View {
  @AppStorage(WidgetKey.visible) private var visible = true
  @AppStorage(WidgetKey.task) private var task = true
  @AppStorage(WidgetKey.timer) private var timer = true
  @AppStorage(WidgetKey.app) private var app = true
  @AppStorage(WidgetKey.title) private var title = true
  @AppStorage(WidgetKey.desktop) private var desktop = true
  @AppStorage(WidgetKey.url) private var url = false
  @AppStorage(WidgetKey.size) private var size = 13.0
  @AppStorage(WidgetKey.width) private var width = 360.0

  var body: some View {
    Form {
      Toggle("Show widget", isOn: $visible)
      Section("Lines") {
        Toggle("Doing tasks", isOn: $task)
        Toggle("Time in Doing", isOn: $timer).disabled(!task)
        Toggle("Desktop", isOn: $desktop)
        Toggle("App", isOn: $app)
        Toggle("Window title", isOn: $title)
        Toggle("Browser address", isOn: $url)
      }
      Slider(value: $size, in: 10...20, step: 1) { Text("Text size") }
      Slider(value: $width, in: 240...640, step: 20) { Text("Width") }
    }
    .padding(20)
  }
}
