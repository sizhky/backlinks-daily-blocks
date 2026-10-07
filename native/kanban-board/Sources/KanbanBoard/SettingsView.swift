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
/// A card's own desktop beats its project's (`ActivityRule.applying`). Org desktops are not offered.
struct TrackingSettings: View {
  @EnvironmentObject var store: BoardStore
  @EnvironmentObject var activity: ActivityMonitor
  @EnvironmentObject var desktops: DesktopStore
  @AppStorage(ReportKey.mull) private var mull = 60
  /// Expanded orgs, tab-separated; all collapsed by default.
  @AppStorage("tracking.expanded") private var open = ""

  var body: some View {
    Form {
      Section("Project desktops") {
        ForEach(groups, id: \.org) { g in
          DisclosureGroup(isExpanded: expanded(g.org)) {
            ForEach(g.projects, id: \.self) { row(.project, $0) }
          } label: {
            HStack(spacing: 8) {
              if !g.org.isEmpty { OrgIcon(name: g.org, size: 18).clipShape(.rect(cornerRadius: 4)) }
              Text(g.org.isEmpty ? "No organization" : g.org)
              Spacer()
              let n = g.projects.filter { p in pins.contains { $0.kind == .project && $0.name.caseInsensitiveCompare(p) == .orderedSame } }.count
              if n > 0 { Text("\(n) pinned").foregroundStyle(.secondary).monospacedDigit() }
            }
          }
        }
      }
      Section {
        LabeledContent("Minimum mulling time") {
          Stepper(value: $mull, in: 0...480, step: 15) { Text("\(mull) min").monospacedDigit() }
        }
      } header: {
        Text("Reports")
      } footer: {
        Text("Cards that reach Doing sooner after creation count as ad hoc.").foregroundStyle(.secondary)
      }
    }
    .formStyle(.grouped)
  }

  private var pins: [DesktopPin] { DesktopPin.pins(activity.rules) }

  /// Projects on the board grouped by their org, orgs and projects sorted; a project with two orgs
  /// is listed under both. Pinned projects no longer on the board go under "No organization".
  private var groups: [(org: String, projects: [String])] {
    let sort = { (a: String, b: String) in a.localizedCaseInsensitiveCompare(b) == .orderedAscending }
    var byOrg: [String: [String]] = [:], seen = Set<String>()
    for card in store.columns.flatMap(\.cards) {
      for org in card.orgs.isEmpty ? [""] : card.orgs {
        for p in card.projects where seen.insert(org.lowercased() + "\t" + p.lowercased()).inserted { byOrg[org, default: []].append(p) }
      }
    }
    let listed = Set(byOrg.values.joined().map { $0.lowercased() })
    for pin in pins where pin.kind == .project && !listed.contains(pin.name.lowercased()) { byOrg["", default: []].append(pin.name) }
    return byOrg.map { (org: $0.key, projects: $0.value.sorted(by: sort)) }
      .sorted { a, b in a.org.isEmpty != b.org.isEmpty ? !a.org.isEmpty : sort(a.org, b.org) }
  }

  private func expanded(_ org: String) -> Binding<Bool> {
    Binding(
      get: { open.split(separator: "\t").contains { $0 == org } },
      set: { on in
        var set = open.split(separator: "\t").map(String.init).filter { $0 != org }
        if on { set.append(org) }
        open = set.joined(separator: "\t")
      })
  }

  private func binding(_ kind: DesktopPin.Kind, _ name: String) -> Binding<String?> {
    Binding(
      get: { pins.first { $0.kind == kind && $0.name.caseInsensitiveCompare(name) == .orderedSame }?.desktop },
      set: { activity.saveRules(DesktopPin.setting(activity.rules, kind: kind, name: name, desktop: $0)) })
  }

  private func row(_ kind: DesktopPin.Kind, _ name: String) -> some View {
    let pick: Binding<String?> = binding(kind, name)
    let stale = pick.wrappedValue.flatMap { desktops.resolve($0) == nil ? $0 : nil }
    return Picker(selection: pick) {
      Text("None").tag(String?.none)
      ForEach(desktops.spaces) { (d: DesktopSpace) in Text(d.name).tag(String?.some(d.ref)) }
      if let stale { Text(stale).tag(String?.some(stale)) }
    } label: {
      HStack(spacing: 8) {
        Monogram(name: name, size: 16)
        Text(name)
      }
    }
  }
}
