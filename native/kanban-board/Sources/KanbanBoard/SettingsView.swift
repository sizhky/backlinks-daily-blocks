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
    .frame(width: 560, height: 760)
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

/// Tracker widget: global style, a live preview, and per-element visibility, justification, and size.
struct WidgetSettings: View {
  @EnvironmentObject var store: BoardStore
  @ObservedObject private var prefs = WidgetPrefs.shared
  @AppStorage(WidgetKey.visible) private var visible = true
  @AppStorage(WidgetKey.width) private var width = 240.0
  @AppStorage(WidgetKey.color) private var color = "#FFFFFF"
  @AppStorage(WidgetKey.font) private var family = ""
  @StateObject private var previewGrip = WidgetGrip()
  private let families = NSFontManager.shared.availableFontFamilies
  private let previewSide = 260.0

  var body: some View {
    Form {
      Section {
        preview
          .frame(maxWidth: .infinity)
          .listRowInsets(EdgeInsets())
      }
      Section("Widget") {
        Toggle("Show widget", isOn: $visible)
        LabeledContent("Size") {
          HStack {
            Slider(value: $width, in: 160...480, step: 20)
            Text("\(Int(width)) pt").monospacedDigit().foregroundStyle(.secondary).frame(width: 52, alignment: .trailing)
          }
        }
        ColorPicker("Text color", selection: Binding(get: { WidgetStyle.color(color) }, set: { color = WidgetStyle.hex($0) }))
        Picker("Font", selection: $family) {
          Text("System").tag("")
          Divider()
          ForEach(families, id: \.self) { Text($0).font(.custom($0, size: 13)).tag($0) }
        }
      }
      Section("Elements") {
        ForEach(WidgetPart.allCases) { p in elementRow(p) }
      }
    }
    .formStyle(.grouped)
  }

  /// The real widget on a sample wallpaper, scaled to fit; it uses live data.
  private var preview: some View {
    ZStack {
      LinearGradient(colors: [Color(red: 0.36, green: 0.16, blue: 0.62), Color(red: 0.12, green: 0.24, blue: 0.62), Color(red: 0.78, green: 0.25, blue: 0.48)],
                     startPoint: .topLeading, endPoint: .bottomTrailing)
      WidgetView(grip: previewGrip)
        .environmentObject(store).environmentObject(store.activity).environmentObject(store.desktops)
        .frame(width: width, height: width)
        .overlay(RoundedRectangle(cornerRadius: width * 0.12, style: .continuous)
          .strokeBorder(Color.white.opacity(0.25), style: StrokeStyle(lineWidth: 1, dash: [4, 4])))
        .scaleEffect(min(1, (previewSide - 24) / width))
    }
    .frame(height: previewSide)
    .clipped()
  }

  private func elementRow(_ p: WidgetPart) -> some View {
    LabeledContent {
      HStack(spacing: 12) {
        Picker(p.label, selection: prefs.alignBinding(p)) {
          ForEach(WidgetAlign.allCases) { Image(systemName: $0.symbol).help($0.label).tag($0) }
        }
        .labelsHidden()
        .pickerStyle(.segmented)
        .fixedSize()
        Text(String(format: prefs.size(p).truncatingRemainder(dividingBy: 1) == 0 ? "%.0f pt" : "%.1f pt", prefs.size(p)))
          .monospacedDigit().foregroundStyle(.secondary).frame(width: 46, alignment: .trailing)
        Stepper(p.label, value: prefs.sizeBinding(p), in: p.sizeRange, step: p == .timer ? 2 : 0.5)
          .labelsHidden()
      }
      .disabled(!prefs.shown(p))
    } label: {
      Toggle(p.label, isOn: prefs.showBinding(p)).toggleStyle(.checkbox)
    }
  }
}
