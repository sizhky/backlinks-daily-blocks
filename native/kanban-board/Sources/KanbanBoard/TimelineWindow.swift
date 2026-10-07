import AppKit
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
      zoomMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] e in
        guard e.modifierFlags.contains(.command), let w = self?.window, e.window === w else { return e }
        let delta = e.hasPreciseScrollingDeltas ? e.scrollingDeltaY * 0.01 : e.scrollingDeltaY * 0.12
        let d = UserDefaults.standard
        let hour = d.object(forKey: "timeline.hour") as? Double ?? 72
        d.set(min(480, max(24, hour * exp(delta))), forKey: "timeline.hour")
        return nil
      }
    }
    model.start()
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate()
  }
}

@MainActor
final class TimelineModel: ObservableObject {
  @Published var day = Calendar.current.startOfDay(for: Date())
  @Published private(set) var spans: [Span] = []
  @Published private(set) var stints: [DoingStint] = []
  @Published var filter = ""
  @Published private(set) var error: String?

  private let activity: ActivityMonitor
  private let client = ObsidianClient()
  private var timer: Timer?
  private var ticks = 0

  init(activity: ActivityMonitor) { self.activity = activity }

  var isToday: Bool { Calendar.current.isDateInToday(day) }

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
        guard let self, self.isToday else { return }
        self.ticks += 1
        self.load(chronicle: self.ticks % 6 == 0)
      }
    }
  }

  func shift(_ days: Int) {
    day = Calendar.current.date(byAdding: .day, value: days, to: day) ?? day
    load(chronicle: true)
  }

  func today() {
    day = Calendar.current.startOfDay(for: Date())
    load(chronicle: true)
  }

  private func load(chronicle: Bool) {
    guard let dir = activity.dir else { error = "Activity capture has not started"; return }
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyyMMdd"
    let url = dir.appendingPathComponent(f.string(from: day) + ".jsonl")
    var fresh = (try? Data(contentsOf: url)).map(ActivityLog.parse) ?? []
    // The open span is not in the file yet; show it live for today.
    if isToday, let open = activity.openSpan { fresh.append(open) }
    if fresh != spans { spans = fresh }
    error = nil
    guard chronicle else { return }
    let day = self.day
    Task {
      let text = (try? await client.chronicle(day)) ?? ""
      let fresh = ActivityLog.stints(text, day: day)
      if day == self.day, fresh != stints { stints = fresh }
    }
  }
}

// MARK: - Views

struct TimelineScreen: View {
  @EnvironmentObject var model: TimelineModel
  @AppStorage("timeline.mode") private var mode = "calendar"
  @AppStorage("timeline.hour") private var hourHeight = 72.0

  var body: some View {
    VStack(spacing: 0) {
      header
      Divider().overlay(Palette.hairline)
      if mode == "calendar" {
        CalendarDay(spans: model.spans, stints: model.stints, day: model.day, isToday: model.isToday, hourHeight: hourHeight)
          .overlay(alignment: .bottomLeading) { zoom.padding(12) }
      } else {
        list
      }
    }
    .background(Palette.base)
    .foregroundStyle(Palette.text)
    .frame(minWidth: 640, minHeight: 420)
  }

  private var header: some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text(model.day.formatted(.dateTime.weekday(.wide).day().month(.wide)))
          .font(.system(size: 20, weight: .semibold)).tracking(-0.3)
        Text(summary).font(.system(size: 12)).foregroundStyle(Palette.muted).monospacedDigit()
      }
      Spacer()
      Picker("View", selection: $mode) {
        Image(systemName: "calendar.day.timeline.left").help("Calendar").tag("calendar")
        Image(systemName: "list.bullet").help("List").tag("list")
      }
      .labelsHidden().pickerStyle(.segmented).fixedSize()
      TextField("Filter", text: $model.filter)
        .textFieldStyle(.plain)
        .padding(.horizontal, 10).frame(width: 200, height: 28)
        .background(RoundedRectangle(cornerRadius: 6).fill(Palette.card))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.hairline))
      HStack(spacing: 2) {
        Button { model.shift(-1) } label: { Image(systemName: "chevron.left") }.help("Previous day")
        Button("Today") { model.today() }.disabled(model.isToday)
        Button { model.shift(1) } label: { Image(systemName: "chevron.right") }.help("Next day").disabled(model.isToday)
      }
      .buttonStyle(.bordered)
    }
    .padding(.horizontal, 20).padding(.top, 30).padding(.bottom, 14)
  }

  private var zoom: some View {
    VStack(spacing: 0) {
      Button { hourHeight = min(480, hourHeight * 1.5) } label: { Image(systemName: "plus").frame(width: 28, height: 26) }
        .help("Zoom in")
      Divider().overlay(Palette.hairline).frame(width: 28)
      Button { hourHeight = max(24, hourHeight / 1.5) } label: { Image(systemName: "minus").frame(width: 28, height: 26) }
        .help("Zoom out")
    }
    .buttonStyle(.pointing)
    .background(RoundedRectangle(cornerRadius: 6).fill(Palette.card))
    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.hairline))
  }

  private var summary: String {
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

/// Calendar day: hours down the left, the Mac's activity and the Doing stints as vertical blocks,
/// a red line at now. Overlapping Doing stints sit side by side.
struct CalendarDay: View {
  let spans: [Span]
  let stints: [DoingStint]
  let day: Date
  let isToday: Bool
  let hourHeight: Double
  static let gutter = 64.0
  /// Hover card: text and pointer position in the calendar's coordinate space.
  @State private var tip: (text: String, at: CGPoint)?

  private func y(_ d: Date) -> Double { max(0, min(24, d.timeIntervalSince(day) / 3600)) * hourHeight }

  var body: some View {
    let blocks = ActivityLog.blocks(spans)
    let sessions = ActivityLog.sessions(blocks)
    let layout = ActivityLog.lanes(stints.map { ($0.start, $0.end) })
    VStack(spacing: 0) {
      HStack(spacing: 0) {
        Spacer().frame(width: Self.gutter, height: 0)  // a bare Color.clear grew tall and pushed the calendar down
        Text("ACTIVITY").frame(maxWidth: .infinity, alignment: .leading)
        Text("DOING").frame(maxWidth: .infinity, alignment: .leading)
      }
      .font(.system(size: 10.5, weight: .semibold)).tracking(0.4).foregroundStyle(Palette.muted)
      .padding(.vertical, 8).padding(.horizontal, 12)
      Divider().overlay(Palette.hairline)
      ScrollViewReader { proxy in
        ScrollView {
          ZStack(alignment: .topLeading) {
            grid
            GeometryReader { geo in
              let col = (geo.size.width - Self.gutter - 24) / 2
              ZStack(alignment: .topLeading) {
                ForEach(blocks) { b in
                  ActivityBlockView(block: b, height: max(1, y(b.end) - y(b.start)))
                    .frame(width: col - 8, height: max(1, y(b.end) - y(b.start)))
                    .hoverTip(ActivityBlockView.tip(b), $tip)
                    .offset(x: Self.gutter + 12, y: y(b.start))
                }
                // A session of short blocks reads as stripes; one label names its main app.
                ForEach(sessions) { ss in
                  let h = y(ss.end) - y(ss.start)
                  if h >= 18, !blocks.contains(where: { $0.start == ss.start && $0.end == ss.end }) {
                    SessionLabel(session: ss)
                      .frame(maxWidth: col - 24, alignment: .leading)
                      .allowsHitTesting(false)
                      .offset(x: Self.gutter + 20, y: y(ss.start) + 3)
                  }
                }
                // Parallel cards sit side by side: each gets an equal column with a gap, never overlapping in x.
                ForEach(Array(stints.enumerated()), id: \.element.id) { i, st in
                  let gap = 2.0
                  let w = (col - 8 + gap) / Double(layout.of[i])
                  DoingBlockView(stint: st, height: max(2, y(st.end) - y(st.start)), narrow: w < 60)
                    .frame(width: max(1, w - gap), height: max(2, y(st.end) - y(st.start) - 1))
                    .hoverTip(DoingBlockView.tip(st, others: layout.of[i] - 1), $tip)
                    .offset(x: Self.gutter + 12 + col + Double(layout.lane[i]) * w, y: y(st.start))
                }
                if isToday { nowLine(width: geo.size.width).allowsHitTesting(false) }
                if let tip { HoverCard(text: tip.text, at: tip.at, bounds: geo.size).allowsHitTesting(false) }
              }
            }
            .frame(height: 24 * hourHeight)
            .coordinateSpace(.named(HoverTip.space))
            // Laid out (not offset) at the focus time, so scrollTo lands there.
            VStack(spacing: 0) {
              Color.clear.frame(width: 1, height: max(0, y(focusTime) - 120))
              Color.clear.frame(width: 1, height: 1).id("focus")
            }
          }
          .frame(height: 24 * hourHeight + 16)
        }
        .onAppear { proxy.scrollTo("focus", anchor: .top) }
        .onChange(of: day) { proxy.scrollTo("focus", anchor: .top) }
      }
    }
  }

  /// Now for today, else the first activity of the day.
  private var focusTime: Date { isToday ? Date() : (spans.first?.start ?? stints.first?.start ?? day.addingTimeInterval(9 * 3600)) }

  private var grid: some View {
    VStack(spacing: 0) {
      ForEach(0..<24, id: \.self) { h in
        HStack(alignment: .top, spacing: 0) {
          Text(Self.hourLabel(h)).font(.system(size: 10.5)).monospacedDigit().foregroundStyle(Palette.muted)
            .frame(width: Self.gutter - 8, alignment: .trailing).offset(y: -6)
          Rectangle().fill(Palette.hairline).frame(height: 1).padding(.leading, 8)
        }
        .frame(height: hourHeight, alignment: .top)
      }
    }
  }

  private func nowLine(width: Double) -> some View {
    TimelineView(.periodic(from: .now, by: 30)) { ctx in
      HStack(spacing: 0) {
        Circle().fill(Palette.danger).frame(width: 7, height: 7)
        Rectangle().fill(Palette.danger).frame(height: 1.5)
      }
      .frame(width: width - Self.gutter + 4)
      .offset(x: Self.gutter - 4, y: y(ctx.date) - 3.5)
    }
  }

  static func hourLabel(_ h: Int) -> String {
    Calendar.current.date(bySettingHour: h, minute: 0, second: 0, of: Date())!
      .formatted(.dateTime.hour(.defaultDigits(amPM: .abbreviated)))
  }
}

struct ActivityBlockView: View {
  let block: ActivityBlock
  let height: Double
  var body: some View {
    let tint = Color(ProjectColor.pair(block.app).light)
    ZStack(alignment: .topLeading) {
      RoundedRectangle(cornerRadius: 4, style: .continuous).fill(tint.opacity(0.22))
      Rectangle().fill(tint).frame(width: 3)
      if height >= 18 {
        HStack(spacing: 6) {
          AppIcon(bundle: block.bundle).frame(width: 14, height: 14)
          Text(block.title.isEmpty ? block.app : block.title).font(.system(size: 11.5, weight: .medium)).lineLimit(1)
          Spacer(minLength: 4)
          Text(TimelineScreen.dur(block.end.timeIntervalSince(block.start))).font(.system(size: 11)).monospacedDigit()
            .foregroundStyle(Palette.secondary)
        }
        .padding(.leading, 8).padding(.trailing, 6).padding(.top, 3)
      }
    }
    .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
  }

  static func tip(_ b: ActivityBlock) -> String {
    "\(b.app)\(b.title.isEmpty ? "" : "\n" + b.title)\n\(TimelineRowView.clock(b.start))–\(TimelineRowView.clock(b.end)) · \(TimelineScreen.dur(b.end.timeIntervalSince(b.start)))"
  }
}

struct SessionLabel: View {
  let session: ActivitySession
  var body: some View {
    HStack(spacing: 6) {
      AppIcon(bundle: session.bundle).frame(width: 14, height: 14)
      Text(session.app).font(.system(size: 11.5, weight: .semibold))
      if !session.title.isEmpty, session.title != session.app {
        Text(session.title).font(.system(size: 11.5)).foregroundStyle(Palette.secondary).lineLimit(1).truncationMode(.middle)
      }
      Text(TimelineScreen.dur(session.end.timeIntervalSince(session.start))).font(.system(size: 11)).monospacedDigit()
        .foregroundStyle(Palette.secondary)
      if session.apps > 1 {
        Text("+\(session.apps - 1) apps").font(.system(size: 10.5)).foregroundStyle(Palette.muted)
      }
    }
    .padding(.horizontal, 7).frame(height: 20)
    .background(Capsule().fill(Palette.window.opacity(0.88)))
    .overlay(Capsule().strokeBorder(Palette.hairline))
    .fixedSize(horizontal: false, vertical: true)
    .help("\(TimelineRowView.clock(session.start))–\(TimelineRowView.clock(session.end))")
  }
}

struct DoingBlockView: View {
  let stint: DoingStint
  let height: Double
  /// Too thin for text: the block is a coloured bar and the hover card carries the details.
  var narrow = false
  var body: some View {
    ZStack(alignment: .topLeading) {
      RoundedRectangle(cornerRadius: 4, style: .continuous).fill(Palette.indigo.opacity(0.28))
      Rectangle().fill(Palette.indigo).frame(width: 3)
      if height >= 18, !narrow {
        HStack(spacing: 6) {
          Text(stint.title).font(.system(size: 11.5, weight: .medium)).lineLimit(height >= 36 ? 2 : 1)
          Spacer(minLength: 4)
          Text(TimelineScreen.dur(stint.end.timeIntervalSince(stint.start)) + (stint.open ? "+" : ""))
            .font(.system(size: 11)).monospacedDigit().foregroundStyle(Palette.secondary)
        }
        .padding(.leading, 8).padding(.trailing, 6).padding(.top, 3)
      }
    }
    .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
  }

  static func tip(_ st: DoingStint, others: Int) -> String {
    "\(st.title)\n\(TimelineRowView.clock(st.start))–\(TimelineRowView.clock(st.end)) · \(TimelineScreen.dur(st.end.timeIntervalSince(st.start)))\(st.open ? " (running)" : "")"
      + (others > 0 ? "\n\(others) other card\(others == 1 ? "" : "s") in Doing alongside" : "")
  }
}

/// Instant hover card (the system `.help` tooltip waits about a second).
enum HoverTip { static let space = "calendar" }

extension View {
  /// Shows `text` in the calendar's hover card while the pointer is over this view, following the pointer.
  func hoverTip(_ text: String, _ tip: Binding<(text: String, at: CGPoint)?>) -> some View {
    onContinuousHover(coordinateSpace: .named(HoverTip.space)) { phase in
      switch phase {
      case .active(let p): tip.wrappedValue = (text, p)
      case .ended: if tip.wrappedValue?.text == text { tip.wrappedValue = nil }
      }
    }
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
