import AppKit
import SwiftUI
import KanbanCore

/// Day timeline window: what the Mac showed, second by second (activity log), beside what was
/// in Doing (`kb.chronicle`). Read-only; it never moves cards.
@MainActor
final class TimelineWindow {
  private var window: NSWindow?
  private let model: TimelineModel

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
  @State private var hovered: String?

  var body: some View {
    VStack(spacing: 0) {
      header
      DayStrip(spans: model.spans, stints: model.stints, day: model.day)
        .frame(height: 64)
        .padding(.horizontal, 20).padding(.bottom, 12)
      Divider().overlay(Palette.hairline)
      list
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

/// 24-hour overview: activity lane coloured by app, Doing lane below.
struct DayStrip: View {
  let spans: [Span]
  let stints: [DoingStint]
  let day: Date

  var body: some View {
    GeometryReader { geo in
      let w = geo.size.width
      let x = { (d: Date) in max(0, min(w, d.timeIntervalSince(day) / 86400 * w)) }
      ZStack(alignment: .topLeading) {
        ForEach(Array(stride(from: 0, through: 24, by: 3)), id: \.self) { h in
          Rectangle().fill(Palette.hairline).frame(width: 1, height: 44).offset(x: w * Double(h) / 24)
          Text(String(format: "%02d", h)).font(.system(size: 9)).foregroundStyle(Palette.muted).monospacedDigit()
            .offset(x: w * Double(h) / 24 + 3, y: 46)
        }
        ForEach(spans, id: \.start) { s in
          Rectangle().fill(Color(ProjectColor.pair(s.app).light))
            .frame(width: max(1, x(s.end) - x(s.start)), height: 18).offset(x: x(s.start), y: 2)
            .help("\(s.app) \(TimelineRowView.clock(s.start))–\(TimelineRowView.clock(s.end))")
        }
        ForEach(stints) { st in
          RoundedRectangle(cornerRadius: 2).fill(Palette.indigo.opacity(0.8))
            .frame(width: max(1, x(st.end) - x(st.start)), height: 14).offset(x: x(st.start), y: 26)
            .help("\(st.title) \(TimelineRowView.clock(st.start))–\(TimelineRowView.clock(st.end))")
        }
      }
    }
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
