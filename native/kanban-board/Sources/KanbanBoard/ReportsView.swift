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

/// What the Reports chart stacks: org/project time, desktop time, or Working/Idle/Break.
enum ReportGroup: String, CaseIterable, Identifiable {
  case projects, desktop, state, cycles
  var id: String { rawValue }
  var label: String { rawValue.capitalized }
}

@MainActor
final class ReportsModel: ObservableObject {
  @Published var range: ReportRange = ReportRange(rawValue: UserDefaults.standard.string(forKey: "reports.range") ?? "") ?? .week {
    didSet { UserDefaults.standard.set(range.rawValue, forKey: "reports.range"); load() }
  }
  @Published private(set) var anchor = Calendar.current.startOfDay(for: Date())
  @Published var group: ReportGroup = ReportGroup(rawValue: UserDefaults.standard.string(forKey: "reports.group") ?? "") ?? .projects {
    didSet {
      UserDefaults.standard.set(group.rawValue, forKey: "reports.group")
      if group == .cycles { load() }
    }
  }
  /// Drilled org; nil = all orgs.
  @Published var org: String?
  @Published private(set) var allocations: [Allocation] = []
  @Published private(set) var cards: [ReportCard] = []
  /// 8 Cards for the Cycles chart: from the start of the range's first cycle, so a cycle that began before the range is whole.
  @Published private(set) var cycleCards: [ReportCard] = []
  /// Range stretches by desktop and by Working/Idle/Break (`Report.desktops`, `Report.states`).
  @Published private(set) var desktops: [Stretch] = []
  @Published private(set) var states: [Stretch] = []
  @Published private(set) var loading = false
  @Published private(set) var error: String?

  private let activity: ActivityMonitor
  private let client = ObsidianClient()
  private var generation = 0

  init(activity: ActivityMonitor) { self.activity = activity }

  var interval: DateInterval {
    Calendar.current.dateInterval(of: range.component, for: anchor) ?? DateInterval(start: anchor, duration: 86_400)
  }
  /// Day cycles (2am to 2am) that overlap the range.
  var cycles: [DateInterval] { Cycle.cycles(from: interval.start, to: interval.end.addingTimeInterval(-1)) }
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
    let gen = generation, span = interval, cycleFrom = Cycle.start(of: interval.start), wantCycles = group == .cycles, rules = activity.rules, open = activity.openSpan, idle = ActivityMonitor.idleAfter
    let labels = Dictionary(DesktopStore.shared.spaces.compactMap { d in d.label.map { (d.number, $0) } }, uniquingKeysWith: { a, _ in a })
    let names = Dictionary(DesktopStore.shared.spaces.compactMap { d in d.label.map { (d.uuid, $0) } }, uniquingKeysWith: { a, _ in a })
    let mull = UserDefaults.standard.object(forKey: ReportKey.mull) as? Int ?? 60
    let last = min(span.end.addingTimeInterval(-1), Date())
    loading = true
    Task {
      do {
        let text = try await client.reportCards(span.start, to: last, mull: mull)
        let cycleText = wantCycles ? try await client.reportCards(cycleFrom, to: last, mull: mull) : nil
        let result = await Task.detached(priority: .userInitiated) {
          let cards = ReportCard.parse(text)
          let (spans, states) = Self.spans(dir: dir, from: span.start, to: last, open: open, idle: idle)
          return (cards, Report.attribute(spans: spans, cards: cards, rules: rules, labels: labels, names: names),
                  Report.desktops(spans, labels: labels, names: names), states)
        }.value
        guard gen == generation else { return }
        cards = result.0
        cycleCards = cycleText.map(ReportCard.parse) ?? []
        allocations = result.1
        desktops = result.2
        states = result.3
        error = nil
      } catch {
        guard gen == generation else { return }
        self.error = error.localizedDescription
      }
      if gen == generation { loading = false }
    }
  }

  /// Active spans of every day log in the range, gaps under the idle threshold filled (as the Timeline does),
  /// and each day's Working/Idle/Break stretches up to its last span (today: up to now).
  nonisolated static func spans(dir: URL, from: Date, to: Date, open: Span?, idle: TimeInterval) -> ([Span], [Stretch]) {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyyMMdd"
    var out: [Span] = [], states: [Stretch] = []
    var day = Calendar.current.startOfDay(for: from)
    while day <= to {
      var spans = (try? Data(contentsOf: dir.appendingPathComponent(f.string(from: day) + ".jsonl"))).map(ActivityLog.parse) ?? []
      if Calendar.current.isDateInToday(day), let open { spans.append(open) }
      let filled = ActivityLog.impute(spans, maxGap: idle)
      let breaks = (try? Data(contentsOf: dir.appendingPathComponent(BreakSpan.fileName(day)))).map { ActivityLog.parseLines($0) as [BreakSpan] } ?? []
      let end = Calendar.current.isDateInToday(day) ? Date() : filled.map(\.end).max() ?? day
      out += filled
      states += Report.states(spans: filled, breaks: breaks, end: end, idleAfter: idle)
      day = Calendar.current.date(byAdding: .day, value: 1, to: day) ?? to.addingTimeInterval(1)
    }
    return (out, states)
  }
}

struct ReportsView: View {
  @EnvironmentObject var model: ReportsModel
  @Binding var mode: String
  /// Pointer over the chart's plot, for the instant `HoverCard`.
  @State private var pointer: CGPoint?
  /// Scroll viewport, tiles and breakdown heights: the chart takes the height the others leave.
  @State private var viewport: CGFloat = 0
  @State private var tilesHeight: CGFloat = 0
  @State private var breakdownHeight: CGFloat = 0

  var body: some View {
    VStack(spacing: 0) {
      header
      Divider().overlay(Palette.hairline)
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          if model.group == .cycles {
            cycleReport
          } else {
            tiles.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { tilesHeight = $0 }
            chart.frame(height: chartHeight)
            if model.group == .projects {
              breakdown.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { breakdownHeight = $0 }
            }
          }
        }
        .padding(20)
      }
      .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { viewport = $0 }
    }
    .onAppear { model.load() }
  }

  /// The viewport left after padding, tiles and (Projects) the breakdown; never under 300 pt, then the page scrolls.
  private var chartHeight: CGFloat {
    let below = model.group == .projects ? breakdownHeight + 20 : 0
    return max(300, viewport - 40 - tilesHeight - 20 - below)
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

  /// Idle stretches of the range (`Report.states`): neither work nor break, and never on laptop.
  private var idle: [(Date, Date)] { model.states.filter { $0.name == Report.idle }.map { ($0.start, $0.end) } }

  private var tree: [ReportNode] { Report.tree(model.allocations, cards: model.cards, idle: idle) }

  @ViewBuilder private var tiles: some View {
    switch model.group {
    case .projects: projectTiles
    case .cycles: EmptyView()
    case .desktop, .state:
      // Largest first; State keeps its fixed order.
      let totals = Report.series(model.group == .state ? model.states : model.desktops) { _ in .distantPast }
      let shown = model.group == .state ? Self.stateOrder.map { n in totals.first { $0.name == n } ?? (.distantPast, n, 0) }
        : Array(totals.sorted { $0.seconds > $1.seconds }.prefix(4))
      HStack(spacing: 12) {
        ForEach(shown, id: \.name) { tile($0.name, TimelineScreen.dur($0.seconds)) }
        if shown.isEmpty { tile("Logged", TimelineScreen.dur(0)) }
      }
    }
  }

  private var projectTiles: some View {
    let nodes = tree.filter { n in model.org.map { n.kind == .org && n.name.caseInsensitiveCompare($0) == .orderedSame } ?? true }
    let total = scoped.reduce(0) { $0 + $1.seconds }
    let unattributed = scoped.filter { $0.target == .unattributed }.reduce(0) { $0 + $1.seconds }
    let onCards = scoped.filter { if case .card = $0.target { true } else { false } }.reduce(0) { $0 + $1.seconds }
    let adhocSeconds = nodes.filter { $0.kind == .org }.reduce(0) { $0 + $1.adhocSeconds }
    let untracked = nodes.reduce(Set<String>()) { $0.union($1.untracked) }.count
    return HStack(spacing: 12) {
      tile("Tracked", TimelineScreen.dur(total - unattributed))
      tile("Unattributed", TimelineScreen.dur(unattributed))
      tile("Idle", TimelineScreen.dur(ActivityLog.unionSeconds(idle)))
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

  /// State legend and stack order, Working at the bottom.
  private static let stateOrder = [Report.working, Report.idle, Report.onBreak]

  /// Tableau 10: ten hues spread around the wheel at mixed lightness, so neighbouring desktops differ.
  private static let desktopPalette: [Color] = ["#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F",
                                                "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AC"].map { hex in
    let c = Hex.rgba(hex)!
    return Color(red: c.r, green: c.g, blue: c.b)
  }

  private func color(_ name: String, desktopSlots: [String: Int] = [:]) -> Color {
    if model.group == .desktop, let slot = desktopSlots[name] { return Self.desktopPalette[slot] }
    return switch (model.group, name) {
    case (.projects, "Unattributed"), (.desktop, "No desktop"), (.state, Report.idle): Palette.muted.opacity(0.5)
    case (.state, Report.working): Palette.link
    case (.state, Report.onBreak): Palette.amber
    default: Color(ProjectHues.pair(name).light)
    }
  }

  private var chart: some View {
    let unit = model.range.bar
    let bucket = { (d: Date) in Calendar.current.dateInterval(of: unit, for: d)?.start ?? d }
    let named: [(bucket: Date, name: String, hours: Double)] = switch model.group {
    case .projects: Report.series(model.allocations, org: model.org, bucket: bucket)
      .map { (bucket: $0.bucket, name: Self.seriesName($0.name, unattributed: $0.unattributed, drilled: model.org != nil), hours: $0.seconds / 3600) }
    case .desktop, .state: Report.series(model.group == .state ? model.states : model.desktops, bucket: bucket)
      .map { (bucket: $0.bucket, name: $0.name, hours: $0.seconds / 3600) }
    case .cycles: []
    }
    let present = Set(named.map(\.name))
    let names = model.group == .state ? Self.stateOrder.filter(present.contains) : present.sorted { a, b in
      a == "Unattributed" ? false : b == "Unattributed" ? true : a < b
    }
    // Swift Charts stacks in row order; sort by the legend's display names so bars match the legend.
    let rank = Dictionary(uniqueKeysWithValues: names.enumerated().map { ($1, $0) })
    let rows = named.sorted { ($0.bucket, rank[$0.name] ?? 0) < ($1.bucket, rank[$1.name] ?? 0) }
    let slots = Report.desktopSlots(names.filter { $0 != "No desktop" }, order: DesktopStore.shared.spaces.map(\.name))
    let colors = names.map { color($0, desktopSlots: slots) }
    // Laptop time per bar: active span time, the same in every grouping and drill.
    let laptop = Dictionary(Report.series(model.desktops, bucket: bucket).map { ($0.bucket, $0.seconds) }, uniquingKeysWith: +)
    return VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 6) {
        if model.group == .projects {
          Button("All organizations") { model.org = nil }
            .buttonStyle(.plain).foregroundStyle(model.org == nil ? Palette.text : Palette.link)
            .disabled(model.org == nil)
          if let org = model.org {
            Image(systemName: "chevron.right").font(.system(size: 10)).foregroundStyle(Palette.muted)
            Text(org)
          }
        } else {
          Text(model.group == .state ? "Working, idle and break" : "By desktop")
        }
        Spacer()
        groupPicker
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
              if let p = pointer, let text = Self.tip(at: p, proxy: proxy, geo: geo, rows: rows, laptop: laptop, unit: unit) {
                HoverCard(text: text, at: p, bounds: geo.size).allowsHitTesting(false)
              }
            }
        }
      }
      .frame(maxHeight: .infinity)
      .overlay { if rows.isEmpty, !model.loading { Text("No tracked time").foregroundStyle(Palette.muted) } }
    }
    .padding(16)
    .background(RoundedRectangle(cornerRadius: 12).fill(Palette.card))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Palette.hairline))
  }

  /// The segment under the pointer: series, hours and share of its bar; the bar's date and laptop time; nil off the bars.
  /// Rows are in stack order (bottom first), so the segment is where the running total passes the pointer's hours.
  /// ```
  /// bar 10:00 [Divami 0.5 h, Unattributed 0.25 h], laptop 2700 s, pointer at 0.3 h
  ///   -> "Divami  30m · 67%\n10 AM · 45m on laptop"
  /// ```
  private static func tip(at p: CGPoint, proxy: ChartProxy, geo: GeometryProxy,
                          rows: [(bucket: Date, name: String, hours: Double)], laptop: [Date: Double],
                          unit: Calendar.Component) -> String? {
    guard let plot = proxy.plotFrame.map({ geo[$0] }), plot.contains(p),
      let date: Date = proxy.value(atX: p.x - plot.minX),
      let hours: Double = proxy.value(atY: p.y - plot.minY), hours >= 0,
      let bucket = Calendar.current.dateInterval(of: unit, for: date)?.start else { return nil }
    let bar = rows.filter { $0.bucket == bucket }
    var top = 0.0
    guard let hit = bar.first(where: { top += $0.hours; return hours < top }) else { return nil }
    let share = Int((hit.hours / max(bar.reduce(0) { $0 + $1.hours }, 1e-9) * 100).rounded())
    let head = bucket.formatted(unit == .hour ? .dateTime.hour() : unit == .month ? .dateTime.month(.wide) : .dateTime.weekday().day().month())
    return "\(hit.name)  \(TimelineScreen.dur(hit.hours * 3600)) · \(share)%\n\(head) · \(TimelineScreen.dur(laptop[bucket] ?? 0)) on laptop"
  }

  private var groupPicker: some View {
    Picker("Group by", selection: $model.group) {
      ForEach(ReportGroup.allCases) { Text($0.label).tag($0) }
    }
    .labelsHidden().pickerStyle(.segmented).fixedSize().help("Group by")
  }

  // MARK: Cycles

  private static let kinds = ["Planned": Palette.link, "Ad hoc": Palette.amber]
  private static let scopeKinds = ["Added": Palette.link, "Carried in": Palette.muted.opacity(0.6), "Done": Palette.text]

  /// 8 Day cycles (2am to 2am): hours planned versus ad hoc, scope versus done, and the cards carried longest.
  private var cycleReport: some View {
    let stats = Cycle.stats(cards: model.cycleCards, cycles: model.cycles)
    let hours = stats.reduce(0) { $0 + $1.planned + $1.adhoc }
    let scope = stats.reduce(0) { $0 + $1.scope }, done = stats.reduce(0) { $0 + $1.done }
    let adhoc = stats.reduce(0) { $0 + $1.adhoc }
    let stuck = Cycle.carried(cards: model.cycleCards, cycles: model.cycles).filter { $0.count >= 2 }.prefix(5)
    return VStack(alignment: .leading, spacing: 20) {
      HStack(spacing: 12) {
        tile("Cycles", "\(stats.count)")
        tile("Doing time", TimelineScreen.dur(hours))
        tile("Done", scope > 0 ? "\(done) of \(scope)" : "–")
        tile("Ad hoc", hours > 0 ? "\(Int((adhoc / hours * 100).rounded()))%" : "–")
        tile("Carried out", "\(stats.last?.carriedOut ?? 0)")
      }
      cycleCard("Doing hours per cycle") {
        Chart(stats) { s in
          BarMark(x: .value("Cycle", s.start, unit: .day), y: .value("Hours", s.planned / 3600)).foregroundStyle(by: .value("Kind", "Planned"))
          BarMark(x: .value("Cycle", s.start, unit: .day), y: .value("Hours", s.adhoc / 3600)).foregroundStyle(by: .value("Kind", "Ad hoc"))
        }
        .chartForegroundStyleScale(domain: ["Planned", "Ad hoc"], range: ["Planned", "Ad hoc"].map { Self.kinds[$0]! })
        .chartYAxisLabel("Hours")
      }
      cycleCard("Scope and done per cycle") {
        Chart {
          ForEach(stats) { s in
            BarMark(x: .value("Cycle", s.start, unit: .day), y: .value("Cards", s.carriedIn)).foregroundStyle(by: .value("Kind", "Carried in"))
            BarMark(x: .value("Cycle", s.start, unit: .day), y: .value("Cards", s.added)).foregroundStyle(by: .value("Kind", "Added"))
          }
          ForEach(stats) { s in
            LineMark(x: .value("Cycle", s.start, unit: .day), y: .value("Cards", s.done), series: .value("Series", "Done"))
              .foregroundStyle(by: .value("Kind", "Done")).symbol(.circle)
          }
        }
        .chartForegroundStyleScale(domain: ["Carried in", "Added", "Done"], range: ["Carried in", "Added", "Done"].map { Self.scopeKinds[$0]! })
        .chartYAxisLabel("Cards")
      }
      if !stuck.isEmpty {
        VStack(alignment: .leading, spacing: 0) {
          Text("Carried over the most").font(.system(size: 13, weight: .medium)).padding(14)
          ForEach(Array(stuck), id: \.card.ref) { row in
            HStack {
              Text(row.card.title).lineLimit(1)
              Spacer()
              Text("\(row.count) cycles").foregroundStyle(Palette.amber).monospacedDigit()
            }
            .font(.system(size: 13)).padding(.horizontal, 14).padding(.vertical, 7)
            .contentShape(Rectangle())
            .onTapGesture(count: 2) { model.open(ref: row.card.ref) }
            .help("Double-click to open in Obsidian. Split it or drop it.")
          }
        }
        .padding(.bottom, 6)
        .background(RoundedRectangle(cornerRadius: 12).fill(Palette.card))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Palette.hairline))
      }
    }
  }

  private func cycleCard<Content: View>(_ title: String, @ViewBuilder _ chart: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Text(title)
        Spacer()
        groupPicker
      }
      .font(.system(size: 13, weight: .medium))
      chart().frame(height: 220)
        .overlay { if model.cycleCards.isEmpty, !model.loading { Text("No cycles in range").foregroundStyle(Palette.muted) } }
    }
    .padding(16)
    .background(RoundedRectangle(cornerRadius: 12).fill(Palette.card))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Palette.hairline))
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
          Text("\(TimelineScreen.dur(node.doing)) in Doing" + (node.idle >= 60 ? " · \(TimelineScreen.dur(node.idle)) idle" : ""))
            .font(.system(size: 11.5)).foregroundStyle(Palette.muted).monospacedDigit()
            .help("Time in Doing, and the part of it with no activity (idle); the active rest went to another card, a project with no card, or nobody")
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
