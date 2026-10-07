import AppKit
import Combine
import SwiftUI
import KanbanCore

/// Day timeline window: what the Mac showed, second by second (activity log), beside what was
/// in Doing (`kb.chronicle`). Read-only; it never moves cards.
@MainActor
final class TimelineWindow {
  private var window: NSWindow?
  private let model: TimelineModel
  private var zoomMonitor: Any?

  init(activity: ActivityMonitor) { model = TimelineModel(activity: activity) }

  func show() {
    if window == nil {
      let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 880, height: 760),
                       styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView],
                       backing: .buffered, defer: false)
      w.title = "Timeline"
      w.titlebarAppearsTransparent = true
      w.isReleasedWhenClosed = false
      w.appearance = NSAppearance(named: .darkAqua)
      let host = NSHostingController(rootView: TimelineScreen().environmentObject(model))
      host.sizingOptions = [.minSize]  // otherwise the window shrinks to the content's fitting size
      w.contentViewController = host
      if !w.setFrameUsingName("Timeline") {
        w.setContentSize(NSSize(width: 880, height: 760))
        w.center()
      }
      w.setFrameAutosaveName("Timeline")
      window = w
      // Cmd + scroll zooms the calendar (hour height); plain scroll still scrolls.
      // The pointer (top-left window coordinates, as SwiftUI's .global) is the zoom pivot.
      zoomMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] e in
        guard e.modifierFlags.contains(.command), let self, let w = self.window, e.window === w,
              let content = w.contentView else { return e }
        let delta = e.hasPreciseScrollingDeltas ? e.scrollingDeltaY * 0.01 : e.scrollingDeltaY * 0.12
        let p = content.convert(e.locationInWindow, from: nil)
        self.model.zoom.send(ZoomRequest(factor: exp(delta), pivot: CGPoint(x: p.x, y: content.isFlipped ? p.y : content.bounds.height - p.y)))
        return nil
      }
    }
    model.start()
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate()
  }
}

struct ZoomRequest { let factor: Double; let pivot: CGPoint? }

@MainActor
final class TimelineModel: ObservableObject {
  @Published var day = Calendar.current.startOfDay(for: Date())
  @Published private(set) var spans: [Span] = []
  @Published private(set) var stints: [DoingStint] = []
  /// Calendar geometry inputs, rebuilt only when spans or stints change.
  @Published private(set) var layout = CalendarLayout()
  @Published var filter = ""
  /// Week view: the 7 days of the week containing `day`, one layout each.
  @Published private(set) var week = false
  @Published private(set) var weekDays: [Date] = []
  @Published private(set) var weekLayouts: [CalendarLayout] = []
  @Published private(set) var weekActive: TimeInterval = 0
  private var weekSpans: [[Span]] = []
  private var weekStints: [String: [DoingStint]] = [:]
  /// Zoom requests for the calendar; the pivot is in window (SwiftUI .global) coordinates, nil = view centre.
  let zoom = PassthroughSubject<ZoomRequest, Never>()
  @Published private(set) var error: String?

  private let activity: ActivityMonitor
  private let client = ObsidianClient()
  private var timer: Timer?
  private var ticks = 0

  init(activity: ActivityMonitor) { self.activity = activity }

  var isToday: Bool { Calendar.current.isDateInToday(day) }

  /// Days the calendar shows, and their layouts.
  var days: [Date] { week ? weekDays : [day] }
  var layouts: [CalendarLayout] { week ? weekLayouts : [layout] }
  var showsToday: Bool { days.contains { Calendar.current.isDateInToday($0) } }

  func setWeek(_ on: Bool) {
    guard on != week else { return }
    week = on
    load(chronicle: true)
  }

  static func weekDays(containing day: Date, calendar: Calendar = .current) -> [Date] {
    let start = calendar.dateInterval(of: .weekOfYear, for: day)?.start ?? day
    return (0..<7).compactMap { calendar.date(byAdding: .day, value: $0, to: start) }
  }

  var rows: [TimelineRow] {
    let q = filter.trimmingCharacters(in: .whitespaces)
    guard !q.isEmpty else { return ActivityLog.rows(spans) }
    return spans.filter { s in [s.app, s.title, s.url ?? "", s.desktop ?? ""].contains { $0.localizedCaseInsensitiveContains(q) } }
      .map(TimelineRow.span)
  }

  func start() {
    load(chronicle: true)
    guard timer == nil else { return }
    timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, self.showsToday else { return }
        self.ticks += 1
        self.load(chronicle: self.ticks % 6 == 0)
      }
    }
  }

  func shift(_ steps: Int) {
    day = Calendar.current.date(byAdding: .day, value: steps * (week ? 7 : 1), to: day) ?? day
    load(chronicle: true)
  }

  func today() {
    day = Calendar.current.startOfDay(for: Date())
    load(chronicle: true)
  }

  private static let ymd: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyyMMdd"
    return f
  }()

  /// One day's spans from its log file, the live span for today, gaps under 60 s filled.
  private func spans(for day: Date, in dir: URL) -> [Span] {
    let url = dir.appendingPathComponent(Self.ymd.string(from: day) + ".jsonl")
    var fresh = (try? Data(contentsOf: url)).map(ActivityLog.parse) ?? []
    // The open span is not in the file yet; show it live for today.
    if Calendar.current.isDateInToday(day), let open = activity.openSpan { fresh.append(open) }
    return ActivityLog.impute(fresh)
  }

  private func load(chronicle: Bool) {
    guard let dir = activity.dir else { error = "Activity capture has not started"; return }
    if week { return loadWeek(dir: dir, chronicle: chronicle) }
    let fresh = spans(for: day, in: dir)
    if fresh != spans { spans = fresh; layout = CalendarLayout(spans: spans, stints: stints) }
    error = nil
    guard chronicle else { return }
    let day = self.day
    Task {
      let text = (try? await client.chronicle(day)) ?? ""
      let fresh = ActivityLog.stints(text, day: day)
      if day == self.day, fresh != stints { stints = fresh; layout = CalendarLayout(spans: spans, stints: stints) }
    }
  }

  private func loadWeek(dir: URL, chronicle: Bool) {
    let days = Self.weekDays(containing: day)
    let fresh = days.map { spans(for: $0, in: dir) }
    let changed = days != weekDays || fresh != weekSpans
    weekDays = days
    weekSpans = fresh
    if changed { rebuildWeek() }
    error = nil
    guard chronicle, let first = days.first, let last = days.last else { return }
    Task {
      let text = (try? await client.chronicle(first, to: last)) ?? ""
      let byDay = ActivityLog.stintsByDay(text)
      guard days == weekDays, byDay != weekStints else { return }
      weekStints = byDay
      rebuildWeek()
    }
  }

  private func rebuildWeek() {
    weekLayouts = zip(weekDays, weekSpans).map { CalendarLayout(spans: $1, stints: weekStints[Self.ymd.string(from: $0)] ?? []) }
    weekActive = weekSpans.joined().reduce(0) { $0 + $1.end.timeIntervalSince($1.start) }
  }
}

// MARK: - Views

struct TimelineScreen: View {
  @EnvironmentObject var model: TimelineModel
  @AppStorage("timeline.mode") private var mode = "calendar"

  var body: some View {
    VStack(spacing: 0) {
      header
      Divider().overlay(Palette.hairline)
      if mode == "list" {
        list
      } else {
        CalendarDay(days: model.days, layouts: model.layouts, zoom: model.zoom)
          .overlay(alignment: .bottomLeading) { zoom.padding(12) }
      }
    }
    .onAppear { model.setWeek(mode == "week") }
    .onChange(of: mode) { model.setWeek(mode == "week") }
    .background(Palette.base)
    .foregroundStyle(Palette.text)
    .frame(minWidth: 640, minHeight: 420)
  }

  private var header: some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.system(size: 20, weight: .semibold)).tracking(-0.3)
        Text(summary).font(.system(size: 12)).foregroundStyle(Palette.muted).monospacedDigit()
      }
      Spacer()
      Picker("View", selection: $mode) {
        Image(systemName: "calendar.day.timeline.left").help("Day").tag("calendar")
        Image(systemName: "calendar").help("Week").tag("week")
        Image(systemName: "list.bullet").help("List").tag("list")
      }
      .labelsHidden().pickerStyle(.segmented).fixedSize()
      TextField("Filter", text: $model.filter)
        .textFieldStyle(.plain)
        .padding(.horizontal, 10).frame(width: 200, height: 28)
        .background(RoundedRectangle(cornerRadius: 6).fill(Palette.card))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.hairline))
      HStack(spacing: 2) {
        Button { model.shift(-1) } label: { Image(systemName: "chevron.left") }.help(model.week ? "Previous week" : "Previous day")
        Button("Today") { model.today() }.disabled(model.week ? model.showsToday : model.isToday)
        Button { model.shift(1) } label: { Image(systemName: "chevron.right") }.help(model.week ? "Next week" : "Next day")
          .disabled(model.week ? model.showsToday : model.isToday)
      }
      .buttonStyle(.bordered)
    }
    .padding(.horizontal, 20).padding(.top, 30).padding(.bottom, 14)
  }

  private var zoom: some View {
    VStack(spacing: 0) {
      Button { model.zoom.send(ZoomRequest(factor: 1.5, pivot: nil)) } label: { Image(systemName: "plus").frame(width: 28, height: 26) }
        .help("Zoom in")
      Divider().overlay(Palette.hairline).frame(width: 28)
      Button { model.zoom.send(ZoomRequest(factor: 1 / 1.5, pivot: nil)) } label: { Image(systemName: "minus").frame(width: 28, height: 26) }
        .help("Zoom out")
    }
    .buttonStyle(.pointing)
    .background(RoundedRectangle(cornerRadius: 6).fill(Palette.card))
    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.hairline))
  }

  private var title: String {
    guard model.week, let a = model.weekDays.first, let b = model.weekDays.last else {
      return model.day.formatted(.dateTime.weekday(.wide).day().month(.wide))
    }
    return "\(a.formatted(.dateTime.day().month(.abbreviated))) – \(b.formatted(.dateTime.day().month(.abbreviated).year()))"
  }

  private var summary: String {
    if model.week {
      let doing = model.weekLayouts.reduce(0.0) { $0 + ActivityLog.unionSeconds($1.stints.map { ($0.start, $0.end) }) }
      return "Active \(Self.dur(model.weekActive)) · Doing \(Self.dur(doing))"
    }
    let active = model.spans.reduce(0) { $0 + $1.end.timeIntervalSince($1.start) }
    let doing = ActivityLog.unionSeconds(model.stints.map { ($0.start, $0.end) })
    return "Active \(Self.dur(active)) · Doing \(Self.dur(doing)) · \(model.spans.count) spans"
  }

  private var list: some View {
    let rows = model.rows
    let hours = Dictionary(grouping: rows) { Calendar.current.component(.hour, from: $0.start) }
    return ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0, pinnedViews: .sectionHeaders) {
          ForEach(hours.keys.sorted(), id: \.self) { h in
            Section {
              ForEach(hours[h] ?? []) { row in TimelineRowView(row: row) }
            } header: {
              HourHeader(hour: h, rows: hours[h] ?? [])
            }
          }
          if rows.isEmpty {
            Text(model.filter.isEmpty ? "No activity recorded" : "No matches")
              .foregroundStyle(Palette.muted).frame(maxWidth: .infinity).padding(.top, 60)
          }
          Color.clear.frame(height: 1).id("end")
        }
      }
      .onAppear { if model.isToday { proxy.scrollTo("end", anchor: .bottom) } }
    }
  }

  static func dur(_ t: TimeInterval) -> String {
    let m = Int(t / 60)
    if m < 1 { return "\(Int(t))s" }
    return m < 60 ? "\(m)m" : "\(m / 60)h\(m % 60 > 0 ? "\(m % 60)m" : "")"
  }
}

struct HourHeader: View {
  let hour: Int
  let rows: [TimelineRow]
  var body: some View {
    let active = rows.reduce(0.0) { if case .span(let s) = $1 { $0 + s.end.timeIntervalSince(s.start) } else { $0 } }
    HStack {
      Text(String(format: "%02d:00", hour)).font(.system(size: 11, weight: .semibold)).monospacedDigit()
      Spacer()
      Text(TimelineScreen.dur(active)).font(.system(size: 11)).foregroundStyle(Palette.muted).monospacedDigit()
    }
    .padding(.horizontal, 20).padding(.vertical, 6)
    .background(Palette.window.opacity(0.95))
    .overlay(alignment: .bottom) { Rectangle().fill(Palette.hairline).frame(height: 1) }
  }
}

struct TimelineRowView: View {
  let row: TimelineRow
  @State private var hover = false

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Text("\(Self.clock(row.start))–\(Self.clock(row.end))")
        .font(.system(size: 12, design: .monospaced)).foregroundStyle(Palette.muted)
        .frame(width: 136, alignment: .leading)
      Text(TimelineScreen.dur(row.end.timeIntervalSince(row.start)))
        .font(.system(size: 12)).monospacedDigit().foregroundStyle(Palette.muted)
        .frame(width: 48, alignment: .trailing)
      switch row {
      case .away:
        Label("Away", systemImage: "moon.fill").font(.system(size: 12.5)).foregroundStyle(Palette.muted)
        Spacer()
      case .span(let s):
        AppIcon(bundle: s.bundle).frame(width: 16, height: 16).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 }
        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: 6) {
            Text(s.app).font(.system(size: 13, weight: .medium))
            if !s.title.isEmpty, s.title != s.app {
              Text(s.title).font(.system(size: 13)).foregroundStyle(Palette.secondary).lineLimit(1).truncationMode(.middle)
            }
          }
          if let url = s.url { Text(url).font(.system(size: 11)).foregroundStyle(Palette.link).lineLimit(1).truncationMode(.middle) }
        }
        Spacer(minLength: 8)
        if let d = s.desktop ?? s.space.map({ "Desktop \($0)" }) { Pill(text: d) { Image(systemName: "rectangle.3.group").imageScale(.small) } }
      }
    }
    .padding(.horizontal, 20).padding(.vertical, 7)
    .background(hover ? Palette.hover : .clear)
    .onHover { hover = $0 }
    .help(help)
  }

  private var help: String {
    guard case .span(let s) = row else { return "" }
    return [s.app, s.title, s.url].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n")
  }

  static func clock(_ d: Date) -> String { d.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).second(.twoDigits)) }
}

/// Precomputed calendar content for one day, rebuilt only when the data changes (never per frame).
struct CalendarLayout {
  var blocks: [ActivityBlock] = []
  var tints: [Color] = []
  var sessions: [ActivitySession] = []
  var stints: [DoingStint] = []
  var lane: [Int] = [], lanes: [Int] = []

  init() {}
  init(spans: [Span], stints: [DoingStint]) {
    blocks = ActivityLog.blocks(spans)
    tints = blocks.map { Color(ProjectColor.pair($0.app).light) }
    sessions = ActivityLog.sessions(blocks).filter { s in !blocks.contains { $0.start == s.start && $0.end == s.end } }
    self.stints = stints
    (lane, lanes) = ActivityLog.lanes(stints.map { ($0.start, $0.end) })
  }
}

/// Calendar of one or more days: hours down the left; per day, the Mac's activity and the Doing
/// stints as vertical blocks, and a red line at now. Overlapping Doing stints sit side by side,
/// never overlapping in x. Drawn by one viewport-sized Canvas, culled to the visible hours; the
/// ScrollView only holds an empty spacer of the day's height for scrolling and hover. Per-block
/// views made zoom chug.
struct CalendarDay: View {
  let days: [Date]
  let layouts: [CalendarLayout]
  let zoom: PassthroughSubject<ZoomRequest, Never>
  static let gutter = 64.0
  /// 24 pt per hour (whole day on screen) to 3600 pt per hour (1 pt per second).
  static let zoomRange = 24.0...3600.0
  static let hourKey = "timeline.hour"

  @State private var hourHeight = UserDefaults.standard.object(forKey: CalendarDay.hourKey) as? Double ?? 72
  @State private var position = ScrollPosition(edge: .top)
  @State private var offsetY = 0.0
  @State private var viewport = CGRect.zero
  /// Pointer in content coordinates (y from midnight).
  @State private var pointer: CGPoint?
  @State private var save: Task<Void, Never>?

  private var single: Bool { days.count == 1 }
  /// y of a time within its own day.
  private func y(_ d: Date, _ day: Date) -> Double { max(0, min(24, d.timeIntervalSince(day) / 3600)) * hourHeight }

  /// Horizontal slots of each day: activity strip, then Doing strip.
  private func slots(width: Double) -> [(ax: Double, aw: Double, dx: Double, dw: Double)] {
    let usable = width - Self.gutter - 12
    let dayW = usable / Double(max(1, days.count))
    return days.indices.map { i in
      let x0 = Self.gutter + 12 + Double(i) * dayW
      let aw = single ? dayW / 2 - 8 : dayW * 0.55 - 2
      let dw = single ? dayW / 2 - 8 : dayW * 0.45 - 6
      return (x0, aw, x0 + aw + (single ? 8 : 2), dw)
    }
  }

  var body: some View {
    VStack(spacing: 0) {
      header
      Divider().overlay(Palette.hairline)
      ScrollView {
        Color.clear
          .frame(height: 24 * hourHeight + 16)
          .contentShape(Rectangle())
          .onContinuousHover { phase in
            switch phase {
            case .active(let p): pointer = p
            case .ended: pointer = nil
            }
          }
      }
      .scrollPosition($position)
      .onScrollGeometryChange(for: Double.self) { $0.contentOffset.y } action: { _, v in offsetY = v }
      .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { viewport = $0 }
      .background(alignment: .topLeading) {
        TimelineView(.periodic(from: .now, by: 30)) { ctx in
          Canvas { gc, size in draw(gc, size: size, now: ctx.date) }
        }
      }
      .overlay(alignment: .topLeading) {
        if let p = pointer, let text = hit(p) {
          HoverCard(text: text, at: CGPoint(x: p.x, y: p.y - offsetY), bounds: viewport.size).allowsHitTesting(false)
        }
      }
      .onAppear { position.scrollTo(y: max(0, focusY - 120)) }
      .onChange(of: days) { position.scrollTo(y: max(0, focusY - 120)) }
      .onReceive(zoom) { apply($0) }
    }
  }

  /// One day: ACTIVITY / DOING. A week: day name and active time per column.
  private var header: some View {
    GeometryReader { geo in
      let sl = slots(width: geo.size.width)
      ZStack(alignment: .topLeading) {
        if single {
          Text("ACTIVITY").offset(x: sl[0].ax)
          Text("DOING").offset(x: sl[0].dx)
        } else {
          ForEach(days.indices, id: \.self) { i in
            let today = Calendar.current.isDateInToday(days[i])
            let active = layouts[i].blocks.reduce(0.0) { $0 + $1.end.timeIntervalSince($1.start) }
            VStack(alignment: .leading, spacing: 1) {
              Text(days[i].formatted(.dateTime.weekday(.abbreviated).day())).foregroundStyle(today ? Palette.danger : Palette.secondary)
              Text(active > 0 ? TimelineScreen.dur(active) : "–").font(.system(size: 10)).foregroundStyle(Palette.muted).monospacedDigit()
            }
            .lineLimit(1)
            .frame(width: sl[i].dx + sl[i].dw - sl[i].ax, alignment: .leading)
            .offset(x: sl[i].ax)
          }
        }
      }
      .font(.system(size: 10.5, weight: .semibold)).tracking(0.4).foregroundStyle(Palette.muted)
      .frame(maxHeight: .infinity, alignment: .center)
    }
    .frame(height: single ? 30 : 38)
  }

  /// Keeps the time under the pivot (pointer, or the view centre) fixed while the hour height changes.
  /// The height is saved 0.5 s after the last change: a defaults write per scroll tick woke every observer.
  private func apply(_ z: ZoomRequest) {
    let pointerY = z.pivot.map { $0.y - viewport.minY } ?? viewport.height / 2
    let pivotY = min(max(0, pointerY), viewport.height)
    let hours = (offsetY + pivotY) / hourHeight
    let next = min(Self.zoomRange.upperBound, max(Self.zoomRange.lowerBound, hourHeight * z.factor))
    guard next != hourHeight else { return }
    hourHeight = next
    let target = max(0, hours * next - pivotY)
    offsetY = target
    position.scrollTo(y: target)
    save?.cancel()
    save = Task { @MainActor in
      try? await Task.sleep(for: .milliseconds(500))
      if !Task.isCancelled { UserDefaults.standard.set(next, forKey: Self.hourKey) }
    }
  }

  /// Now if a shown day is today, else the earliest activity, else 9 AM.
  private var focusY: Double {
    if let i = days.firstIndex(where: { Calendar.current.isDateInToday($0) }) { return y(Date(), days[i]) }
    let firsts = days.indices.compactMap { i in (layouts[i].blocks.first?.start ?? layouts[i].stints.first?.start).map { y($0, days[i]) } }
    return firsts.min() ?? 9 * hourHeight
  }

  /// Minutes between sub-hour gridlines at this zoom; nil = hours only.
  private var tick: Int? {
    switch hourHeight {
    case 2400...: 1
    case 800...: 5
    case 200...: 15
    default: nil
    }
  }

  // MARK: Drawing (canvas y = content y - offsetY)

  private func draw(_ gc: GraphicsContext, size: CGSize, now: Date) {
    let top = offsetY, bottom = offsetY + size.height
    let visible = { (a: Double, b: Double) in b >= top - 2 && a <= bottom + 2 }
    let sl = slots(width: size.width)
    // Grid
    let step = Double(tick ?? 60)
    var minute = max(0, floor(top / hourHeight * 60 / step) * step)
    while minute <= min(24 * 60, bottom / hourHeight * 60 + step) {
      let cy = minute / 60 * hourHeight - top
      let isHour = minute.truncatingRemainder(dividingBy: 60) == 0
      gc.fill(Path(CGRect(x: Self.gutter, y: cy, width: size.width - Self.gutter, height: 1)),
              with: .color(isHour ? Palette.hairline : Palette.hairline.opacity(0.5)))
      let label = isHour ? Self.hourLabel(Int(minute / 60)) : String(format: ":%02d", Int(minute) % 60)
      gc.draw(Text(label).font(.system(size: isHour ? 10.5 : 9.5)).monospacedDigit()
                .foregroundStyle(isHour ? Palette.muted : Palette.muted.opacity(0.7)),
              at: CGPoint(x: Self.gutter - 8, y: cy), anchor: .trailing)
      minute += step
    }
    for (i, day) in days.enumerated() {
      let layout = layouts[i], s = sl[i]
      // Day separators in the week view
      if !single, i > 0 {
        gc.fill(Path(CGRect(x: s.ax - 4, y: 0, width: 1, height: size.height)), with: .color(Palette.hairline))
      }
      // Activity
      for (k, b) in layout.blocks.enumerated() {
        let y0 = y(b.start, day), y1 = y(b.end, day)
        guard visible(y0, y1) else { continue }
        let r = CGRect(x: s.ax, y: y0 - top, width: s.aw, height: max(1, y1 - y0))
        block(gc, r, tint: layout.tints[k], title: s.aw >= 80 ? (b.title.isEmpty ? b.app : b.title) : nil, icon: b.bundle,
              dur: TimelineScreen.dur(b.end.timeIntervalSince(b.start)))
      }
      if s.aw >= 120 {
        for ss in layout.sessions {
          let y0 = y(ss.start, day), y1 = y(ss.end, day)
          guard y1 - y0 >= 18, visible(y0, y1) else { continue }
          // Sticky: the label stays on screen while any of its session is.
          let ly = min(max(y0, top) + 3, y1 - 20) - top
          sessionLabel(gc, ss, at: CGPoint(x: s.ax + 8, y: ly), maxWidth: s.aw - 16)
        }
      }
      // Doing
      for (k, st) in layout.stints.enumerated() {
        let y0 = y(st.start, day), y1 = y(st.end, day)
        guard visible(y0, y1) else { continue }
        let w = (s.dw + 2) / Double(layout.lanes[k])
        let r = CGRect(x: s.dx + Double(layout.lane[k]) * w, y: y0 - top, width: max(1, w - 2), height: max(2, y1 - y0 - 1))
        block(gc, r, tint: Palette.indigo, title: r.width >= 60 ? st.title : nil, icon: nil,
              dur: TimelineScreen.dur(st.end.timeIntervalSince(st.start)) + (st.open ? "+" : ""), fill: 0.28)
      }
      // Now
      if Calendar.current.isDateInToday(day) {
        let ny = y(now, day) - top
        if ny >= -4 && ny <= size.height + 4 {
          let x0 = single ? Self.gutter : s.ax - 4
          let x1 = single ? size.width : s.dx + s.dw
          gc.fill(Path(ellipseIn: CGRect(x: x0 - 4, y: ny - 3.5, width: 7, height: 7)), with: .color(Palette.danger))
          gc.fill(Path(CGRect(x: x0, y: ny - 0.75, width: x1 - x0, height: 1.5)), with: .color(Palette.danger))
        }
      }
    }
  }

  private func block(_ gc: GraphicsContext, _ r: CGRect, tint: Color, title: String?, icon: String?, dur: String, fill: Double = 0.22) {
    let shape = Path(roundedRect: r, cornerRadius: min(4, r.height / 2), style: .continuous)
    gc.fill(shape, with: .color(tint.opacity(fill)))
    gc.fill(Path(CGRect(x: r.minX, y: r.minY, width: min(3, r.width), height: r.height)), with: .color(tint))
    guard let title, r.height >= 18 else { return }
    var inner = gc
    inner.clip(to: shape)
    let d = inner.resolve(Text(dur).font(.system(size: 11)).monospacedDigit().foregroundStyle(Palette.secondary))
    let dSize = d.measure(in: r.size)
    inner.draw(d, at: CGPoint(x: r.maxX - 6, y: r.minY + 4), anchor: .topTrailing)
    var x = r.minX + 8
    if let icon {
      inner.draw(Image(nsImage: AppIcon.icon(icon)), in: CGRect(x: x, y: r.minY + 4, width: 14, height: 14))
      x += 20
    }
    let room = max(0, r.maxX - 6 - dSize.width - 8 - x)
    var label = inner
    label.clip(to: Path(CGRect(x: x, y: r.minY, width: room, height: r.height)))
    label.draw(Text(title).font(.system(size: 11.5, weight: .medium)).foregroundStyle(Palette.text),
               at: CGPoint(x: x, y: r.minY + 3), anchor: .topLeading)
  }

  private func sessionLabel(_ gc: GraphicsContext, _ ss: ActivitySession, at p: CGPoint, maxWidth: Double) {
    var parts = Text(ss.app).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(Palette.text)
    if !ss.title.isEmpty, ss.title != ss.app {
      parts = parts + Text("  " + ss.title).font(.system(size: 11.5)).foregroundStyle(Palette.secondary)
    }
    parts = parts + Text("  " + TimelineScreen.dur(ss.end.timeIntervalSince(ss.start))).font(.system(size: 11)).foregroundStyle(Palette.secondary)
    if ss.apps > 1 { parts = parts + Text("  +\(ss.apps - 1) apps").font(.system(size: 10.5)).foregroundStyle(Palette.muted) }
    let t = gc.resolve(parts)
    let w = min(maxWidth, t.measure(in: CGSize(width: 2000, height: 20)).width + 7 + 20 + 8)
    let pill = Path(roundedRect: CGRect(x: p.x, y: p.y, width: w, height: 20), cornerRadius: 10)
    gc.fill(pill, with: .color(Palette.window.opacity(0.88)))
    gc.stroke(pill, with: .color(Palette.hairline))
    gc.draw(Image(nsImage: AppIcon.icon(ss.bundle)), in: CGRect(x: p.x + 7, y: p.y + 3, width: 14, height: 14))
    var inner = gc
    inner.clip(to: Path(CGRect(x: p.x + 27, y: p.y, width: max(0, w - 34), height: 20)))
    inner.draw(t, at: CGPoint(x: p.x + 27, y: p.y + 10), anchor: .leading)
  }

  // MARK: Hover hit test (content coordinates)

  private func hit(_ p: CGPoint) -> String? {
    let sl = slots(width: viewport.width)
    guard let i = sl.indices.first(where: { p.x >= sl[$0].ax && p.x <= sl[$0].dx + sl[$0].dw }) else { return nil }
    let s = sl[i], layout = layouts[i]
    let t = days[i].addingTimeInterval(p.y / hourHeight * 3600)
    // At low zoom a 5 s block is under a pixel; accept the nearest block within 2 pt.
    let slack = 2 / hourHeight * 3600
    let when = single ? "" : days[i].formatted(.dateTime.weekday(.abbreviated).day()) + " "
    if p.x <= s.ax + s.aw,
       let b = layout.blocks.first(where: { $0.start.addingTimeInterval(-slack) <= t && $0.end.addingTimeInterval(slack) >= t }) {
      return "\(b.app)\(b.title.isEmpty || b.title == b.app ? "" : "\n" + b.title)\n\(when)\(TimelineRowView.clock(b.start))–\(TimelineRowView.clock(b.end)) · \(TimelineScreen.dur(b.end.timeIntervalSince(b.start)))"
    }
    if p.x >= s.dx {
      for (k, st) in layout.stints.enumerated() where st.start <= t && st.end >= t {
        let w = (s.dw + 2) / Double(layout.lanes[k])
        let x0 = s.dx + Double(layout.lane[k]) * w
        guard p.x >= x0, p.x <= x0 + w else { continue }
        let others = layout.lanes[k] - 1
        return "\(st.title)\n\(when)\(TimelineRowView.clock(st.start))–\(TimelineRowView.clock(st.end)) · \(TimelineScreen.dur(st.end.timeIntervalSince(st.start)))\(st.open ? " (running)" : "")"
          + (others > 0 ? "\n\(others) other card\(others == 1 ? "" : "s") in Doing alongside" : "")
      }
    }
    return nil
  }

  static func hourLabel(_ h: Int) -> String {
    Calendar.current.date(bySettingHour: h % 24, minute: 0, second: 0, of: Date())!
      .formatted(.dateTime.hour(.defaultDigits(amPM: .abbreviated)))
  }
}

struct HoverCard: View {
  let text: String
  let at: CGPoint
  let bounds: CGSize
  static let width = 280.0
  var body: some View {
    Text(text)
      .font(.system(size: 11.5)).foregroundStyle(Palette.text)
      .lineSpacing(2)
      .padding(.horizontal, 9).padding(.vertical, 7)
      .frame(maxWidth: Self.width, alignment: .leading)
      .fixedSize(horizontal: false, vertical: true)
      .background(RoundedRectangle(cornerRadius: 7).fill(Palette.window))
      .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Palette.hairlineStrong))
      .shadow(color: .black.opacity(0.4), radius: 8, y: 3)
      // Right of and below the pointer; flips left near the right edge.
      .offset(x: at.x + 14 + Self.width > bounds.width ? at.x - Self.width - 10 : at.x + 14, y: at.y + 14)
  }
}

/// The app's Dock icon, cached by bundle id.
struct AppIcon: View {
  let bundle: String
  @MainActor private static var cache: [String: NSImage] = [:]
  var body: some View {
    Image(nsImage: Self.icon(bundle)).resizable().interpolation(.high)
  }
  @MainActor static func icon(_ bundle: String) -> NSImage {
    if let i = cache[bundle] { return i }
    let i = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle).map { NSWorkspace.shared.icon(forFile: $0.path) }
      ?? NSImage(systemSymbolName: "app", accessibilityDescription: nil) ?? NSImage()
    cache[bundle] = i
    return i
  }
}
