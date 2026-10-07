import SwiftUI
import KanbanCore

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
      TrackingSettings().tabItem { Label("Tracking", systemImage: "menubar.dock.rectangle") }
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
        .frame(width: width)
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

enum ReportKey {
  /// 5.1 Minutes a card must wait in Backlog and Todo before Doing to count as planned.
  static let mull = "reports.mull"
}

/// 2.4 Project desktops, stored as `DesktopPin` rules in `rules.json`, and the Reports mulling time.
/// One square per desktop holds the projects pinned to it; drag a project pill to another square, or to
/// No desktop to unpin it. A card's own desktop beats its project's (`ActivityRule.applying`).
struct TrackingSettings: View {
  @EnvironmentObject var store: BoardStore
  @EnvironmentObject var activity: ActivityMonitor
  @EnvironmentObject var desktops: DesktopStore
  @AppStorage(ReportKey.mull) private var mull = 60
  @State private var target: String?
  @State private var tip: (text: String, at: CGPoint)?

  /// A drop region: a desktop (`ref` = what pins store), a pin whose desktop no longer exists, or none.
  struct Region: Identifiable {
    let id: String, title: String, ref: String?, current: Bool, projects: [String]
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        Text("Desktops").font(.headline)
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 3), spacing: 10) {
          ForEach(regions.dropLast()) { region($0).aspectRatio(1, contentMode: .fit) }
        }
        if let none = regions.last { region(none).frame(minHeight: 120) }
        Divider().padding(.vertical, 4)
        HStack {
          VStack(alignment: .leading, spacing: 2) {
            Text("Minimum mulling time")
            Text("Cards that reach Doing sooner after creation count as ad hoc.").font(.callout).foregroundStyle(.secondary)
          }
          Spacer()
          Text("\(mull) min").monospacedDigit()
          Stepper("Minimum mulling time", value: $mull, in: 0...480, step: 15).labelsHidden()
        }
      }
      .padding(20)
      .coordinateSpace(.named("desks"))
      .overlay(alignment: .topLeading) {
        GeometryReader { g in
          if let tip { HoverCard(text: tip.text, at: tip.at, bounds: g.size).allowsHitTesting(false) }
        }
      }
    }
  }

  /// Every project on the board plus every pinned project, by name (case-insensitive).
  private var projects: [String] {
    var seen = Set<String>(), out: [String] = []
    let pinned = DesktopPin.pins(activity.rules).filter { $0.kind == .project }.map(\.name)
    for p in store.columns.flatMap(\.cards).flatMap(\.projects) + pinned where seen.insert(p.lowercased()).inserted { out.append(p) }
    return out.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
  }

  /// Desktops in order, then pins to desktops that no longer exist, then No desktop (always last).
  private var regions: [Region] {
    var byDesk: [String: [String]] = [:], stale: [String: [String]] = [:], none: [String] = []
    for p in projects {
      guard let ref = store.projectDesktop(p) else { none.append(p); continue }
      if let d = desktops.resolve(ref) { byDesk[d.uuid, default: []].append(p) } else { stale[ref, default: []].append(p) }
    }
    let current = desktops.current?.uuid
    return desktops.spaces.map { Region(id: $0.uuid, title: $0.name, ref: $0.ref, current: $0.uuid == current, projects: byDesk[$0.uuid] ?? []) }
      + stale.keys.sorted().map { Region(id: "stale|" + $0, title: $0, ref: $0, current: false, projects: stale[$0] ?? []) }
      + [Region(id: "none", title: "No desktop", ref: nil, current: false, projects: none)]
  }

  private func region(_ r: Region) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        Text(r.title).font(.system(size: 12.5, weight: .semibold)).lineLimit(1)
        if r.current { Circle().fill(Color.accentColor).frame(width: 6, height: 6).help("Current desktop") }
        Spacer(minLength: 0)
        if !r.projects.isEmpty { Text("\(r.projects.count)").font(.system(size: 11)).foregroundStyle(.secondary).monospacedDigit() }
      }
      ScrollView {
        FlowLayout(spacing: 5) {
          ForEach(r.projects, id: \.self) { pill($0) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .scrollIndicators(.never)
    }
    .padding(10)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(target == r.id ? 0.08 : 0.03)))
    .overlay(RoundedRectangle(cornerRadius: 12)
      .strokeBorder(target == r.id ? Color.accentColor : Color.white.opacity(0.1), lineWidth: target == r.id ? 1.5 : 1))
    .dropDestination(for: String.self) { names, _ in
      for name in names { store.setDesktop(r.ref, project: name) }
      return !names.isEmpty
    } isTargeted: { on in
      if on { target = r.id } else if target == r.id { target = nil }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("\(r.title), \(r.projects.count) projects")
  }

  private func pill(_ name: String) -> some View {
    Pill(text: name) { Monogram(name: name, size: 13) }
      .frame(maxWidth: 150, alignment: .leading)
      .fixedSize(horizontal: false, vertical: true)
      .contentShape(Rectangle())
      .draggable(name) { Pill(text: name) { Monogram(name: name, size: 13) } }
      .onContinuousHover(coordinateSpace: .named("desks")) { phase in
        switch phase {
        case .active(let p): tip = (name, p)
        case .ended: if tip?.text == name { tip = nil }
        }
      }
      .accessibilityLabel(name)
  }
}
