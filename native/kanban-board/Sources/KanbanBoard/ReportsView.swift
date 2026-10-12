import Charts
import SwiftUI
import KanbanCore

/// 6 Reports tab of the Timeline window (blueprint: .yeshwanth/blueprints/activity-tracking.md).
/// Reads day logs and `kb.reportCards`; attribution is `Report.attribute`. Read-only.
enum ReportRange: String, CaseIterable, Identifiable {
  case day, week, month, year
  var id: String { rawValue }
  var label: String { rawValue.capitalized }
  var component: Calendar.Component { switch self { case .day: .day; case .week: .weekOfYear; case .month: .month; case .year: .year } }
  /// Chart bar unit: hours of a day, days of a week, month or year.
  var bar: Calendar.Component { switch self { case .day: .hour; case .week, .month, .year: .day } }
}

@MainActor
final class ReportsModel: ObservableObject {
  @Published var range: ReportRange = ReportRange(rawValue: UserDefaults.standard.string(forKey: "reports.range") ?? "") ?? .week {
    didSet { UserDefaults.standard.set(range.rawValue, forKey: "reports.range"); load() }
  }
  @Published private(set) var anchor = Calendar.current.startOfDay(for: Date())
  /// Drilled org; nil = all orgs.
  @Published var org: String?
  @Published private(set) var allocations: [Allocation] = []
  @Published private(set) var cards: [ReportCard] = []
  @Published private(set) var loading = false
  @Published private(set) var error: String?

  private let activity: ActivityMonitor
  private let client = ObsidianClient()
  private var generation = 0

  init(activity: ActivityMonitor) { self.activity = activity }

  var interval: DateInterval {
    Calendar.current.dateInterval(of: range.component, for: anchor) ?? DateInterval(start: anchor, duration: 86_400)
  }
  var isCurrent: Bool { interval.contains(Date()) }

  func shift(_ steps: Int) {
    anchor = Calendar.current.date(byAdding: range.component, value: steps, to: anchor) ?? anchor
    load()
  }

  func today() {
    anchor = Calendar.current.startOfDay(for: Date())
    load()
  }

  func open(ref: String) {
    Task { do { try await client.open(ref: ref) } catch { self.error = error.localizedDescription } }
  }

  func load() {
    guard let dir = activity.dir else { error = "Activity capture has not started"; return }
    generation += 1
    let gen = generation, span = interval, rules = activity.rules, open = activity.openSpan, idle = ActivityMonitor.idleAfter
    let labels = Dictionary(DesktopStore.shared.spaces.compactMap { d in d.label.map { (d.number, $0) } }, uniquingKeysWith: { a, _ in a })
    let names = Dictionary(DesktopStore.shared.spaces.compactMap { d in d.label.map { (d.uuid, $0) } }, uniquingKeysWith: { a, _ in a })
    let mull = UserDefaults.standard.object(forKey: ReportKey.mull) as? Int ?? 60
    let last = min(span.end.addingTimeInterval(-1), Date())
    loading = true
    Task {
      do {
        let text = try await client.reportCards(span.start, to: last, mull: mull)
        let result = await Task.detached(priority: .userInitiated) {
          let cards = ReportCard.parse(text)
          let spans = Self.spans(dir: dir, from: span.start, to: last, open: open, idle: idle)
          return (cards, Report.attribute(spans: spans, cards: cards, rules: rules, labels: labels, names: names))
        }.value
        guard gen == generation else { return }
        cards = result.0
        allocations = result.1
        error = nil
      } catch {
        guard gen == generation else { return }
        self.error = error.localizedDescription
      }
      if gen == generation { loading = false }
    }
  }

  /// Active spans of every day log in the range, gaps under the idle threshold filled (as the Timeline does).
  nonisolated static func spans(dir: URL, from: Date, to: Date, open: Span?, idle: TimeInterval) -> [Span] {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyyMMdd"
    var out: [Span] = []
    var day = Calendar.current.startOfDay(for: from)
    while day <= to {
      var spans = (try? Data(contentsOf: dir.appendingPathComponent(f.string(from: day) + ".jsonl"))).map(ActivityLog.parse) ?? []
      if Calendar.current.isDateInToday(day), let open { spans.append(open) }
      out += ActivityLog.impute(spans, maxGap: idle)
      day = Calendar.current.date(byAdding: .day, value: 1, to: day) ?? to.addingTimeInterval(1)
    }
    return out
  }
}

struct ReportsView: View {
  @EnvironmentObject var model: ReportsModel
  @Binding var mode: String
  /// Pointer over the chart's plot, for the instant `HoverCard`.
  @State private var pointer: CGPoint?

  var body: some View {
    VStack(spacing: 0) {
      header
      Divider().overlay(Palette.hairline)
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          tiles
          chart
          breakdown
        }
        .padding(20)
      }
    }
    .onAppear { model.load() }
  }

  // MARK: Header

  private var header: some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.system(size: 20, weight: .semibold)).tracking(-0.3)
        Text(model.loading ? "Loading" : (model.error ?? "\(model.cards.count) cards")).font(.system(size: 12))
          .foregroundStyle(model.error == nil ? Palette.muted : Palette.danger).lineLimit(1)
      }
      Spacer()
      TimelineModePicker(mode: $mode)
      Picker("Range", selection: $model.range) {
        ForEach(ReportRange.allCases) { Text($0.label).tag($0) }
      }
      .labelsHidden().pickerStyle(.segmented).fixedSize()
      HStack(spacing: 2) {
        Button { model.shift(-1) } label: { Image(systemName: "chevron.left") }.help("Previous \(model.range.rawValue)")
        Button("Today") { model.today() }.disabled(model.isCurrent)
        Button { model.shift(1) } label: { Image(systemName: "chevron.right") }.help("Next \(model.range.rawValue)")
          .disabled(model.isCurrent)
      }
      .buttonStyle(.bordered)
    }
    .padding(.horizontal, 20).padding(.top, 30).padding(.bottom, 14)
  }

  private var title: String {
    let i = model.interval, end = i.end.addingTimeInterval(-1)
    switch model.range {
    case .day: return i.start.formatted(.dateTime.weekday(.wide).day().month(.wide))
    case .week: return "\(i.start.formatted(.dateTime.day().month(.abbreviated))) – \(end.formatted(.dateTime.day().month(.abbreviated).year()))"
    case .month: return i.start.formatted(.dateTime.month(.wide).year())
    case .year: return i.start.formatted(.dateTime.year())
    }
  }

  // MARK: Tiles

  /// Allocations inside the drilled org (all when not drilled).
  private var scoped: [Allocation] {
    guard let org = model.org else { return model.allocations }
    return model.allocations.filter { $0.target != .unattributed && $0.org.caseInsensitiveCompare(org) == .orderedSame }
  }

  private var tree: [ReportNode] { Report.tree(model.allocations, cards: model.cards) }

  private var tiles: some View {
    let nodes = tree.filter { n in model.org.map { n.kind == .org && n.name.caseInsensitiveCompare($0) == .orderedSame } ?? true }
    let total = scoped.reduce(0) { $0 + $1.seconds }
    let unattributed = scoped.filter { $0.target == .unattributed }.reduce(0) { $0 + $1.seconds }
    let onCards = scoped.filter { if case .card = $0.target { true } else { false } }.reduce(0) { $0 + $1.seconds }
    let adhocSeconds = nodes.filter { $0.kind == .org }.reduce(0) { $0 + $1.adhocSeconds }
    let untracked = nodes.reduce(Set<String>()) { $0.union($1.untracked) }.count
    return HStack(spacing: 12) {
      tile("Tracked", TimelineScreen.dur(total - unattributed))
      tile("Unattributed", TimelineScreen.dur(unattributed))
      tile("Ad hoc", onCards > 0 ? "\(Int((adhocSeconds / onCards * 100).rounded()))%" : "–")
      tile("Untracked cards", "\(untracked)")
    }
  }

  private func tile(_ label: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(label).font(.system(size: 11.5)).foregroundStyle(Palette.muted)
      Text(value).font(.system(size: 20, weight: .semibold)).monospacedDigit()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(12)
    .background(RoundedRectangle(cornerRadius: 9).fill(Palette.card))
    .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Palette.hairline))
  }

  // MARK: Chart

  private static func seriesName(_ name: String, unattributed: Bool, drilled: Bool) -> String {
    unattributed ? "Unattributed" : name.isEmpty ? (drilled ? "No project" : "No organization") : name
  }

  private var chart: some View {
    let unit = model.range.bar
    let named = Report.series(model.allocations, org: model.org) { Calendar.current.dateInterval(of: unit, for: $0)?.start ?? $0 }
      .map { (bucket: $0.bucket, name: Self.seriesName($0.name, unattributed: $0.unattributed, drilled: model.org != nil), hours: $0.seconds / 3600) }
    let names = Array(Set(named.map(\.name))).sorted { a, b in
      a == "Unattributed" ? false : b == "Unattributed" ? true : a < b
    }
    // Swift Charts stacks in row order; sort by the legend's display names so bars match the legend.
    let rank = Dictionary(uniqueKeysWithValues: names.enumerated().map { ($1, $0) })
    let rows = named.sorted { ($0.bucket, rank[$0.name] ?? 0) < ($1.bucket, rank[$1.name] ?? 0) }
    let colors = names.map { $0 == "Unattributed" ? Palette.muted.opacity(0.5) : Color(ProjectHues.pair($0).light) }
    return VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 6) {
        Button("All organizations") { model.org = nil }
          .buttonStyle(.plain).foregroundStyle(model.org == nil ? Palette.text : Palette.link)
          .disabled(model.org == nil)
        if let org = model.org {
          Image(systemName: "chevron.right").font(.system(size: 10)).foregroundStyle(Palette.muted)
          Text(org)
        }
      }
      .font(.system(size: 13, weight: .medium))
      Chart(rows.indices, id: \.self) { i in
        BarMark(x: .value("Time", rows[i].bucket, unit: unit), y: .value("Hours", rows[i].hours))
          .foregroundStyle(by: .value("Series", rows[i].name))
      }
      .chartForegroundStyleScale(domain: names, range: colors)
      .chartXScale(domain: model.interval.start...model.interval.end)
      .chartYAxisLabel("Hours")
      .chartOverlay { proxy in
        GeometryReader { geo in
          Rectangle().fill(.clear).contentShape(Rectangle())
            .onContinuousHover { phase in
              if case .active(let p) = phase { pointer = p } else { pointer = nil }
            }
            .overlay(alignment: .topLeading) {
              if let p = pointer, let text = Self.tip(at: p, proxy: proxy, geo: geo, rows: rows, unit: unit) {
                HoverCard(text: text, at: p, bounds: geo.size).allowsHitTesting(false)
              }
            }
        }
      }
      .frame(height: 240)
      .overlay { if rows.isEmpty, !model.loading { Text("No tracked time").foregroundStyle(Palette.muted) } }
    }
    .padding(16)
    .background(RoundedRectangle(cornerRadius: 12).fill(Palette.card))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Palette.hairline))
  }

  /// Hours per series in the bar under the pointer, largest first; nil off the bars.
  private static func tip(at p: CGPoint, proxy: ChartProxy, geo: GeometryProxy,
                          rows: [(bucket: Date, name: String, hours: Double)], unit: Calendar.Component) -> String? {
    guard let plot = proxy.plotFrame.map({ geo[$0] }), plot.contains(p),
      let date: Date = proxy.value(atX: p.x - plot.minX),
      let bucket = Calendar.current.dateInterval(of: unit, for: date)?.start else { return nil }
    let hit = rows.filter { $0.bucket == bucket }.sorted { $0.hours > $1.hours }
    guard !hit.isEmpty else { return nil }
    let head = bucket.formatted(unit == .hour ? .dateTime.hour() : unit == .month ? .dateTime.month(.wide) : .dateTime.weekday().day().month())
    let total = TimelineScreen.dur(hit.reduce(0) { $0 + $1.hours } * 3600)
    return (["\(head)  \(total)"] + hit.map { "\($0.name)  \(TimelineScreen.dur($0.hours * 3600))" }).joined(separator: "\n")
  }

  // MARK: Breakdown

  private var breakdown: some View {
    let nodes = tree.filter { n in model.org.map { n.kind == .org && n.name.caseInsensitiveCompare($0) == .orderedSame } ?? true }
    let total = max(1, nodes.reduce(0) { $0 + $1.seconds })
    return VStack(alignment: .leading, spacing: 0) {
      ForEach(nodes) { org in
        ReportRow(node: org, total: total, depth: 0, drill: { model.org = $0 }, open: model.open(ref:))
      }
    }
    .background(RoundedRectangle(cornerRadius: 12).fill(Palette.card))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Palette.hairline))
  }
}

/// One breakdown row with its children behind a disclosure chevron. Org rows drill the chart;
/// card rows open the card in Obsidian on double-click.
struct ReportRow: View {
  let node: ReportNode
  let total: Double
  let depth: Int
  let drill: (String) -> Void
  let open: (String) -> Void
  @State private var expanded = false
  @State private var hover = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 8) {
        Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold))
          .rotationEffect(.degrees(expanded ? 90 : 0))
          .foregroundStyle(Palette.muted)
          .opacity(node.children.isEmpty ? 0 : 1)
          .frame(width: 12)
        icon
        Text(label).lineLimit(1).foregroundStyle(node.kind == .noCard || node.kind == .unattributed ? Palette.muted : Palette.text)
        tags
        Spacer(minLength: 12)
        if node.kind == .card, node.doing - node.seconds >= 60 {
          Text("\(TimelineScreen.dur(node.doing)) in Doing").font(.system(size: 11.5)).foregroundStyle(Palette.muted).monospacedDigit()
            .help("Time in Doing; the rest went to another card, a project with no card, or nobody")
        }
        Text(TimelineScreen.dur(node.seconds)).monospacedDigit()
        Text("\(Int((node.seconds / total * 100).rounded()))%").monospacedDigit().foregroundStyle(Palette.muted)
          .frame(width: 40, alignment: .trailing)
      }
      .font(.system(size: 13))
      .padding(.leading, 12 + CGFloat(depth) * 20).padding(.trailing, 14).padding(.vertical, 7)
      .contentShape(Rectangle())
      .background(hover ? Palette.hover : .clear)
      .onHover { hover = $0 }
      .onTapGesture { if !node.children.isEmpty { withAnimation(.spring(duration: 0.25)) { expanded.toggle() } } }
      .simultaneousGesture(TapGesture(count: 2).onEnded {
        if node.kind == .org { drill(node.name) }
        if let ref = node.ref { open(ref) }
      })
      .help(node.kind == .org ? "Double-click to chart this organization" : node.ref == nil ? "" : "Double-click to open in Obsidian")
      if expanded {
        ForEach(node.children) { ReportRow(node: $0, total: total, depth: depth + 1, drill: drill, open: open) }
      }
    }
  }

  private var label: String {
    switch node.kind {
    case .unattributed: "Unattributed"
    case .noCard: "No card"
    case .org: node.name.isEmpty ? "No organization" : node.name
    case .project: node.name.isEmpty ? "No project" : node.name
    case .card: node.name
    }
  }

  @ViewBuilder private var icon: some View {
    switch node.kind {
    case .org where !node.name.isEmpty: OrgIcon(name: node.name, size: 18).clipShape(.rect(cornerRadius: 4))
    case .project where !node.name.isEmpty: Monogram(name: node.name, size: 16)
    case .unattributed: Image(systemName: "questionmark.circle").foregroundStyle(Palette.muted).frame(width: 18)
    default: EmptyView()
    }
  }

  @ViewBuilder private var tags: some View {
    if node.kind == .card {
      if node.adhoc.contains(node.ref ?? "") { Pill(text: "Ad hoc", color: Palette.amber) { EmptyView() } }
      if node.untracked.contains(node.ref ?? "") { Pill(text: "Untracked", color: Palette.danger) { EmptyView() } }
    } else if node.kind == .org || node.kind == .project {
      let parts = [node.adhoc.isEmpty ? nil : "\(node.adhoc.count) ad hoc", node.untracked.isEmpty ? nil : "\(node.untracked.count) untracked"].compactMap { $0 }
      if !parts.isEmpty { Text(parts.joined(separator: " · ")).font(.system(size: 11.5)).foregroundStyle(Palette.muted) }
    }
  }
}
