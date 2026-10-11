import Carbon.HIToolbox
import AppKit
import Combine
import Foundation
import KanbanCore
import SwiftUI

enum ViewMode: String { case board, list, logbook }

/// Unsaved state of the view editor; `org` nil = all workspaces, "" = no org.
struct ViewDraft: Identifiable {
  var id = UUID()
  var existing = false
  var name = ""
  var query = ""
  var orgs: [String] = []
}

@MainActor
final class BoardStore: ObservableObject {
  @Published private(set) var columns: [Column] = []
  @Published private(set) var loaded = false
  @Published private(set) var error: String?
  @Published var saved: [SavedFilter]
  /// Selected workspaces; empty = all. "" (Filter.noOrg) selects cards with no org.
  @Published var orgScope: [String] = UserDefaults.standard.stringArray(forKey: "kanban.orgs")
    ?? UserDefaults.standard.string(forKey: "kanban.org").map { [$0] } ?? [] {
    didSet {
      UserDefaults.standard.set(orgScope, forKey: "kanban.orgs")
      // Each workspace selection keeps its own filter: switching brings that selection's filter back.
      if Self.scopeKey(oldValue) != Self.scopeKey(orgScope) {
        orgQueries[Self.scopeKey(oldValue)] = query
        query = orgQueries[Self.scopeKey(orgScope)] ?? ""
      }
    }
  }
  /// Last filter per workspace selection (`scopeKey`), kept as the filter changes; survives restarts.
  private var orgQueries: [String: String] = UserDefaults.standard.dictionary(forKey: "kanban.orgQueries") as? [String: String] ?? [:] {
    didSet { UserDefaults.standard.set(orgQueries, forKey: "kanban.orgQueries") }
  }
  /// Order-free key of a workspace selection; "" = all workspaces.
  static func scopeKey(_ orgs: [String]) -> String { orgs.map { $0.lowercased() }.sorted().joined(separator: "\t") }
  @Published var orgOrder: [String] = UserDefaults.standard.stringArray(forKey: "kanban.orgOrder") ?? [] {
    didSet { UserDefaults.standard.set(orgOrder, forKey: "kanban.orgOrder") }
  }
  /// Column order and user-hidden columns, by name.
  @Published var columnOrder: [String] = UserDefaults.standard.stringArray(forKey: "kanban.columnOrder") ?? [] {
    didSet { UserDefaults.standard.set(columnOrder, forKey: "kanban.columnOrder") }
  }
  @Published var hiddenColumns: [String] = UserDefaults.standard.stringArray(forKey: "kanban.hiddenColumns") ?? [] {
    didSet { UserDefaults.standard.set(hiddenColumns, forKey: "kanban.hiddenColumns") }
  }
  @Published var mode: ViewMode = ViewMode(rawValue: UserDefaults.standard.string(forKey: "kanban.mode") ?? "") ?? .board {
    didSet { UserDefaults.standard.set(mode.rawValue, forKey: "kanban.mode") }
  }
  @Published var showSidebar = UserDefaults.standard.object(forKey: "kanban.sidebar") as? Bool ?? true {
    didSet { UserDefaults.standard.set(showSidebar, forKey: "kanban.sidebar") }
  }
  @Published private(set) var selected: String?
  /// Card just moved into Doing without a guess; the board asks for one.
  @Published var estimating: Card?
  @Published private(set) var toast: String?
  /// Latest Doing change for the tracker widget's full-cover toast; `gen` restarts its timer.
  @Published private(set) var widgetToast: (gen: Int, changes: [DoingChange])?
  /// Live cards from the last refresh. Diffed against fresh data, not against `columns`,
  /// because optimistic moves already changed `columns` before the refresh lands.
  private var lastLive: [Card]?
  private var toastGen = 0
  /// Multi-selection (checkboxes); a drag of a picked card carries all of them.
  @Published var picked: Set<String> = []
  /// True while `DragController` carries cards; refresh results wait until it ends.
  var dragActive = false
  @Published private(set) var notes: [String: String] = [:]
  @Published var paletteOpen = false
  @Published var focusFilter = 0
  @Published var filterFocused = false
  @Published var pick = 0
  @Published var paletteText = ""
  @Published var paletteIndex = 0
  @Published var editing: ViewDraft?
  @Published var query: String {
    didSet {
      UserDefaults.standard.set(query, forKey: "kanban.query")
      if orgQueries[Self.scopeKey(orgScope)] != query { orgQueries[Self.scopeKey(orgScope)] = query }
    }
  }

  private let client = ObsidianClient()
  private var loop: Task<Void, Never>?
  let activity = ActivityMonitor()
  private var desktopMenu: DesktopMenu?
  private(set) var widget: TrackerWidget?
  private lazy var timeline = TimelineWindow(activity: activity, live: { [weak self] in
    (self?.stretch, self?.breakStart.map { BreakSpan(start: $0, end: .distantFuture) })
  }, moveItems: { [weak self] st in
    // A stint's ref can be stale after lines move; the title still names the card.
    guard let self, let card = columns.lazy.flatMap(\.cards).first(where: { $0.ref == st.ref })
      ?? columns.lazy.flatMap(\.cards).first(where: { $0.title == st.title }) else { return [] }
    return statusItems(card)
  })

  func openTimeline() { timeline.show() }
  private var desktopSink: Any?
  private var rulesSink: Any?
  let desktops = DesktopStore.shared
  /// 4.2 Rule moves; persisted so a relaunch can still resume what it parked.
  private var switches: SwitchEngine = UserDefaults.standard.data(forKey: "kanban.switches")
    .flatMap { try? JSONDecoder().decode(SwitchEngine.self, from: $0) } ?? SwitchEngine()

  /// 6.1 The one active Doing card (`Focus.active`, by desktop context); nil while away or when no card fits.
  @Published private(set) var activeID: String?
  /// Unwritten active seconds; persisted so a relaunch loses nothing, flushed to `%% kbactive %%`.
  private var clock: ActiveClock = UserDefaults.standard.data(forKey: "kanban.activeClock")
    .flatMap { try? JSONDecoder().decode(ActiveClock.self, from: $0) } ?? ActiveClock()
  private var lastFlush = Date()
  private var pin: FocusPin?
  /// The active card's stretch so far (`end` is `distantFuture`); logged when the active card changes.
  /// Saved on every change, so a relaunch that skips `willTerminate` (pkill, crash) can still log it.
  private(set) var stretch: ActiveStretch? {
    didSet { UserDefaults.standard.set(stretch.flatMap { try? JSONEncoder().encode($0) }, forKey: Self.stretchKey) }
  }
  private var stretchID: String?
  /// The previous run's unlogged stretch and its last tick; logged once the activity folder is known.
  private var orphan: ActiveStretch?
  private static let stretchKey = "kanban.activeStretch"
  /// When the running break started (`takeBreak`); nil when not on a break.
  /// Start of the current work session: the end of the last break, else the first presence today.
  @Published private(set) var workStart: Date? = UserDefaults.standard.object(forKey: "kanban.workStart") as? Date {
    didSet { UserDefaults.standard.set(workStart, forKey: "kanban.workStart") }
  }
  /// Start of today's first activity span (day log, read at launch; now on a new day): the base of the
  /// work/break share. Derived, not saved: `workStart` moves at every break end, so it cannot be the base.
  private var dayStart: Date?
  /// Today's finished breaks, from the day log at launch plus each one that ends.
  private var dayBreaks: [BreakSpan] = []
  @Published private(set) var breakStart: Date? = UserDefaults.standard.object(forKey: "kanban.breakStart") as? Date {
    didSet { UserDefaults.standard.set(breakStart, forKey: "kanban.breakStart") }
  }
  private var contextSink: Any?
  static let flushEvery: TimeInterval = 300
  /// When the Mac went to sleep (lid closed); screen lock and display sleep do not set it.
  private var sleptAt: Date?

  init() {
    query = UserDefaults.standard.string(forKey: "kanban.query") ?? ""
    saved = UserDefaults.standard.data(forKey: "kanban.saved")
      .flatMap { try? JSONDecoder().decode([SavedFilter].self, from: $0) } ?? SavedFilter.defaults
    if var s = UserDefaults.standard.data(forKey: Self.stretchKey).flatMap({ try? JSONDecoder().decode(ActiveStretch.self, from: $0) }),
       let last = clock.last {
      s.end = last
      orphan = s
    }
    let ws = NSWorkspace.shared.notificationCenter
    ws.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.sleptAt = Date() }
    }
    ws.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.parkSlept() }
    }
    NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.closeStretch(at: Date()) }
    }
  }

  /// Parks every Doing card at the sleep moment; the plugin skips cards that moved after it.
  private func parkSlept() {
    guard let at = sleptAt else { return }
    sleptAt = nil
    parkAll(at: at)
  }

  /// Card ids (`Card.id`) the last break moved from Doing to Parked; persisted so a relaunch can end the break.
  private var breakParked: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "kanban.breakParked") ?? []) {
    didSet { UserDefaults.standard.set(Array(breakParked), forKey: "kanban.breakParked") }
  }

  /// The break key (`BreakHotKey`) toggles: while a card the break parked is still in Parked, it ends the
  /// break and moves those cards back to Doing; otherwise it parks every Doing card now.
  /// The widget gets one "Break" or "Started" toast instead of one per card: the next refresh skips its diff.
  func takeBreak() {
    let back = columns.flatMap(\.cards)
      .filter { breakParked.contains($0.id) && $0.col.caseInsensitiveCompare("Parked") == .orderedSame }
    lastLive = nil
    breakParked = []
    if !back.isEmpty {
      endBreak()
      show("Break over. Resumed \(back.count) task\(back.count == 1 ? "" : "s").")
      widgetToast = ((widgetToast?.gen ?? 0) + 1,
                     [DoingChange(title: "Resumed \(back.count) task\(back.count == 1 ? "" : "s")", verb: "Started")])
      move(refs: back.map(\.ref), to: "Doing")
      return
    }
    show("Parked everything. Take a break.")
    let doing = columns.filter { !$0.done && $0.name.caseInsensitiveCompare("Doing") == .orderedSame }.flatMap(\.cards)
    let n = doing.count
    breakParked = Set(doing.map(\.id))
    if breakStart == nil { breakStart = Date() }
    widgetToast = ((widgetToast?.gen ?? 0) + 1,
                   [DoingChange(title: n == 0 ? "Nothing was running" : "Parked \(n) task\(n == 1 ? "" : "s")", verb: "Break")])
    parkAll(at: Date())
  }

  /// Share of today since first presence spent on breaks (0...1), the running break included.
  func breakShare(at now: Date) -> Double {
    guard let first = dayStart ?? workStart ?? breakStart else { return 0 }
    let running = breakStart.map { [BreakSpan(start: $0, end: .distantFuture)] } ?? []
    return ActivityLog.breakShare(dayBreaks + running, from: max(first, Calendar.current.startOfDay(for: now)), now: now)
  }

  /// Logs the running break. It ends on the resume press, or when any card is back in Doing.
  private func endBreak() {
    guard let start = breakStart else { return }
    breakStart = nil
    let end = Date()
    workStart = end
    if end > start {
      activity.record(BreakSpan(start: start, end: end))
      dayBreaks.append(BreakSpan(start: start, end: end))
    }
  }

  private func parkAll(at: Date) {
    writeGen += 1
    Task {
      do { try await client.parkAll(at: at) } catch { self.error = error.localizedDescription }
      await refresh()
    }
  }

  /// Selected org, ignored once it no longer exists on the board.
  var activeOrgs: [String] {
    let known = Set(orgs.map(\.name))
    return orgScope.filter { $0 == Filter.noOrg || known.contains($0) || !loaded }
  }
  var scoped: [Column] { Filter.scope(columns, orgs: activeOrgs) }
  var visible: [Column] {
    let cols = Filter.apply(scoped, Query.parse(query))
    return Ordering.arranged(cols.map(\.name), saved: columnOrder).compactMap { n in cols.first { $0.name == n } }
  }
  func isHidden(_ column: Column) -> Bool { hiddenColumns.contains(column.name) }
  func setHidden(_ column: Column, _ hide: Bool) {
    withAnimation(.spring(duration: 0.3)) {
      hiddenColumns = hide ? hiddenColumns + [column.name] : hiddenColumns.filter { $0 != column.name }
    }
  }
  /// Drops `refs` before `before` in `column`'s shown order and saves the ranks.
  func place(_ refs: [String], before: String?, in column: Column) {
    let pairs = Ranking.place(refs, before: before, in: ordered(column))
    guard !pairs.isEmpty else { return }
    let rank = Dictionary(pairs.map { ($0.ref, $0.rank) }, uniquingKeysWith: { a, _ in a })
    let moving = Set(refs)
    let cards = columns.flatMap(\.cards).filter { moving.contains($0.ref) }
    do {
      for i in columns.indices {
        columns[i].cards.removeAll { moving.contains($0.ref) }
        for j in columns[i].cards.indices { if let r = rank[columns[i].cards[j].ref] { columns[i].cards[j].rank = r } }
        if columns[i].name == column.name {
          columns[i].cards += cards.map { c in
            var m = c.col == column.name ? c : c.moved(to: column.name)
            m.rank = rank[c.ref]
            return m
          }
        }
      }
    }
    picked.subtract(moving)
    askEstimate(cards, entering: column.name)
    writeGen += 1
    Task {
      do { try await client.rank(pairs, in: column.name) } catch { self.error = error.localizedDescription }
      await refresh()
    }
  }
  /// Swaps a column with its neighbour; `by` is -1 (left) or +1 (right).
  func shiftColumn(_ column: Column, by step: Int) {
    let names = visible.map(\.name)
    guard let i = names.firstIndex(of: column.name), names.indices.contains(i + step) else { return }
    withAnimation(.spring(duration: 0.3)) { columnOrder = Ordering.moving(names, column.name, onto: names[i + step]) }
  }
  var total: Int { scoped.reduce(0) { $0 + $1.cards.count } }
  /// Rail order: the user's arrangement first, then new orgs by frequency.
  var orgs: [(name: String, count: Int)] {
    let found = counts(in: columns, \.orgs)
    let order = Ordering.arranged(found.map(\.name), saved: orgOrder)
    return order.compactMap { name in found.first { $0.name == name } }
  }

  func moveOrg(_ name: String, onto target: String) {
    withAnimation(.spring(duration: 0.3)) { orgOrder = Ordering.moving(orgs.map(\.name), name, onto: target) }
  }
  var shown: Int { visible.reduce(0) { $0 + $1.cards.count } }

  /// Counts of a card field over non-done columns, most frequent first.
  /// Names come from the org scope; counts come from what the board currently shows.
  func facets(_ pick: (Card) -> [String]) -> [(name: String, count: Int)] {
    let shown = Dictionary(uniqueKeysWithValues: counts(in: visible, pick).map { ($0.name, $0.count) })
    return counts(in: scoped, pick).map { (name: $0.name, count: shown[$0.name] ?? 0) }
  }

  func count(org: String, in column: String) -> Int {
    Filter.scope(columns, orgs: [org]).first { $0.name.caseInsensitiveCompare(column) == .orderedSame }?.cards.count ?? 0
  }

  func doingCount(org: String) -> Int { count(org: org, in: "Doing") }
  func todoCount(org: String) -> Int { count(org: org, in: "Todo") }

  var hasUnassigned: Bool { columns.contains { $0.done == false && $0.cards.contains { $0.orgs.isEmpty } } }

  private func counts(in columns: [Column], _ pick: (Card) -> [String]) -> [(name: String, count: Int)] {
    var counts: [String: Int] = [:]
    for column in columns where !column.done { for card in column.cards { for v in pick(card) { counts[v, default: 0] += 1 } } }
    return counts.map { (name: $0.key, count: $0.value) }.sorted { ($1.count, $0.name) < ($0.count, $1.name) }
  }

  var selectedCard: Card? { selected.flatMap { ref in columns.lazy.flatMap(\.cards).first { $0.ref == ref } } }

  /// Every shown card ref, column by column, in screen order.
  var shownRefs: [String] { visible.filter { !isHidden($0) }.flatMap { ordered($0).map(\.ref) } }

  /// Cards in the order the screen shows them, so arrow keys follow the eye.
  func ordered(_ column: Column) -> [Card] {
    Ranking.ordered(column.cards)
  }

  func select(_ ref: String?) {
    selected = ref
    guard let card = selectedCard else { return }
    Task { notes[card.ref] = (try? await client.note(card)) ?? "" }
  }

  /// dx walks to the neighbouring non-empty column; dy walks within a column.
  func moveSelection(dx: Int, dy: Int) {
    let cols = visible.map(ordered)
    guard let ref = selected, let ci = cols.firstIndex(where: { $0.contains { $0.ref == ref } }),
          let ri = cols[ci].firstIndex(where: { $0.ref == ref }) else {
      if let first = cols.first(where: { !$0.isEmpty })?.first { select(first.ref) }
      return
    }
    if dy != 0 { select(cols[ci][min(cols[ci].count - 1, max(0, ri + dy))].ref); return }
    var next = ci + dx
    while cols.indices.contains(next), cols[next].isEmpty { next += dx }
    if cols.indices.contains(next) { select(cols[next][min(ri, cols[next].count - 1)].ref) }
  }

  func openSelected() { selectedCard.map(open) }

  func copyID(_ card: Card) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(card.identifier, forType: .string)
    show("Copied \(card.identifier)")
  }

  /// Short confirmation at the bottom of the board; a newer toast replaces an older one.
  func show(_ message: String) {
    toastGen += 1
    let gen = toastGen
    withAnimation(.spring(duration: 0.25)) { toast = message }
    Task {
      try? await Task.sleep(for: .seconds(1.6))
      guard gen == toastGen else { return }
      withAnimation(.spring(duration: 0.25)) { toast = nil }
    }
  }

  func start() {
    guard loop == nil else { return }
    BreakHotKey.shared.action = { [weak self] in self?.takeBreak() }
    BreakHotKey.shared.install()
    desktopMenu = DesktopMenu(store: self)
    widget = TrackerWidget(store: self)
    desktopSink = desktops.objectWillChange.sink { [weak self] in MainActor.assumeIsolated { self?.objectWillChange.send() } }
    rulesSink = activity.$rules.sink { [weak self] _ in MainActor.assumeIsolated { self?.objectWillChange.send() } }
    // @Published fires before the value changes; the hop to the main queue reads the new context.
    contextSink = activity.$context.dropFirst().receive(on: DispatchQueue.main).sink { [weak self] _ in
      MainActor.assumeIsolated { self?.trackActive() }
    }
    // Retries until Obsidian answers: one failed read at launch left tracking off until the next launch.
    Task {
      while !Task.isCancelled {
        do {
          let vault = URL(fileURLWithPath: try await client.vaultPath(), isDirectory: true)
          desktops.start(dir: vault.appendingPathComponent(".activity", isDirectory: true))
          activity.start(vault: vault)
          if let o = orphan, o.end > o.start { activity.record(o) }
          if let dir = activity.dir {
            let read = { (name: String) in try? Data(contentsOf: dir.appendingPathComponent(name)) }
            dayBreaks = read(BreakSpan.fileName(Date())).map { ActivityLog.parseLines($0) } ?? []
            dayStart = read(Span.fileName(Date()))
              .flatMap { ActivityLog.parse($0).first?.start }
          }
          orphan = nil
          return
        } catch { self.error = error.localizedDescription }
        try? await Task.sleep(for: .seconds(6))
      }
    }
    loop = Task { [weak self] in
      while !Task.isCancelled {
        await self?.refresh()
        try? await Task.sleep(for: .seconds(6))
      }
    }
  }

  /// Bumped by every write. A refresh that started before a write (or lands mid-drag)
  /// carries stale data and is dropped, so an optimistic move never snaps back.
  private var writeGen = 0

  func refresh() async {
    let gen = writeGen
    do {
      let fresh = try await client.board()
      guard gen == writeGen, !dragActive else { return }
      let live = fresh.filter { !$0.done }.flatMap(\.cards)
      if let before = lastLive {
        let changes = DoingChange.diff(before: before, after: live)
        if !changes.isEmpty { widgetToast = ((widgetToast?.gen ?? 0) + 1, changes) }
      }
      lastLive = live
      // An unchanged board would still redraw every card each refresh.
      if fresh != columns { withAnimation(DragController.spring) { columns = fresh } }
      picked.formIntersection(columns.flatMap(\.cards).map(\.ref))
      if breakStart != nil, live.contains(where: { $0.col.caseInsensitiveCompare("Doing") == .orderedSame }) { endBreak() }
      error = nil
      switchTasks()
      trackActive()
    } catch {
      self.error = error.localizedDescription
    }
    loaded = true
  }

  /// 4.2 Parks cards whose context the user left and resumes the ones the engine parked,
  /// with stamps at the moment the context changed.
  private func switchTasks() {
    let live = columns.filter { !$0.done }.flatMap(\.cards)
    let moves = switches.step(now: Date(), context: activity.context, contextSince: activity.contextSince,
                              cards: live, rules: activity.rules)
    UserDefaults.standard.set(try? JSONEncoder().encode(switches), forKey: "kanban.switches")
    guard !moves.isEmpty else { return }
    writeGen += 1
    Task {
      for group in Dictionary(grouping: moves, by: { "\($0.column)|\($0.at.timeIntervalSince1970)" }).values {
        do { try await client.move(refs: group.map(\.ref), to: group[0].column, at: group[0].at) }
        catch { self.error = error.localizedDescription }
      }
      let verb = moves[0].column == "Parked" ? "Parked" : "Resumed"
      show(moves.count == 1 ? "\(verb) \(moves[0].title)" : "\(verb) \(moves.count) cards")
      await refresh()
    }
  }

  /// Logs the running stretch as ended at `end`; going away ends it at the idle start.
  private func closeStretch(at end: Date) {
    guard var s = stretch else { return }
    (stretch, stretchID) = (nil, nil)
    s.end = max(s.start, end)
    if s.end > s.start { activity.record(s) }
  }

  /// Makes a Doing card active by hand until the desktop changes (`FocusPin`).
  func activate(_ id: String) {
    pin = FocusPin(id: id, context: activity.context)
    withAnimation(.spring(duration: 0.4, bounce: 0.15)) { trackActive() }
  }

  /// 6.1 Credits the time since the last tick to the active card and flushes on a switch, on going
  /// away, and every `flushEvery` seconds.
  private func trackActive() {
    let cards = columns.flatMap(\.cards)
    let active = Focus.active(cards, context: activity.context, rules: activity.rules, pin: pin)
    if pin != nil, active?.id != pin?.id { pin = nil }
    if activity.context != nil, breakStart == nil, !(workStart.map(Calendar.current.isDateInToday) ?? false) {
      (workStart, dayStart, dayBreaks) = (Date(), Date(), [])
    }
    let awaySince = activity.context == nil ? activity.contextSince : nil
    if stretchID != active?.id {
      closeStretch(at: awaySince ?? Date())
      stretch = active.map { ActiveStretch(ref: $0.ref, title: $0.title, start: Date(), end: .distantFuture) }
      stretchID = active?.id
    }
    let before = clock.current
    clock.tick(now: Date(), active: active?.id, awaySince: awaySince)
    if !cards.isEmpty { clock.keep(Set(cards.map(\.id))) }
    if activeID != active?.id { activeID = active?.id }
    if before != active?.id || Date().timeIntervalSince(lastFlush) >= Self.flushEvery { flushActive() }
    UserDefaults.standard.set(try? JSONEncoder().encode(clock), forKey: "kanban.activeClock")
  }

  /// Writes whole unwritten seconds with one `kb.addActive`; the board shows them at once, and a
  /// failed write puts them back.
  private func flushActive() {
    lastFlush = Date()
    var refs: [String: String] = [:]
    for c in columns.flatMap(\.cards) where refs[c.id] == nil { refs[c.id] = c.ref }
    let taken = clock.take()
    let items = taken.compactMap { id, n in refs[id].map { (ref: $0, seconds: n) } }
    guard !items.isEmpty else { return }
    for i in columns.indices { for j in columns[i].cards.indices {
      if let n = taken[columns[i].cards[j].id] { columns[i].cards[j].activeSeconds = (columns[i].cards[j].activeSeconds ?? 0) + n }
    } }
    writeGen += 1
    Task {
      do { try await client.addActive(items) } catch {
        clock.restore(taken)
        self.error = error.localizedDescription
      }
    }
  }

  /// Active seconds of a card at `now`: written total plus unwritten time.
  func activeTime(_ card: Card, at now: Date) -> TimeInterval {
    Double(card.activeSeconds ?? 0) + clock.unwritten(card.id, now: now)
  }

  func move(ref: String, to column: String) { move(refs: [ref], to: column) }

  func move(refs: [String], to column: String) {
    let wanted = Set(refs)
    let cards = columns.flatMap(\.cards).filter { wanted.contains($0.ref) && $0.col.caseInsensitiveCompare(column) != .orderedSame }
    guard !cards.isEmpty else { return }
    let moving = Set(cards.map(\.ref))
    withAnimation(.spring(duration: 0.38, bounce: 0.14)) {
      for i in columns.indices {
        columns[i].cards.removeAll { moving.contains($0.ref) }
        if columns[i].name == column { columns[i].cards.insert(contentsOf: cards.map { $0.moved(to: column) }, at: 0) }
      }
    }
    picked.subtract(moving)
    askEstimate(cards, entering: column)
    writeGen += 1
    Task {
      do {
        if cards.count == 1 { try await client.move(cards[0], to: column) } else { try await client.move(cards, to: column) }
      } catch { self.error = error.localizedDescription }
      await refresh()
    }
  }

  func togglePick(_ ref: String) {
    if picked.contains(ref) { picked.remove(ref) } else { picked.insert(ref) }
  }
  /// Picks every card shown on the board, or only `column`'s.
  func pickAll(in column: Column? = nil) {
    let cols = column.map { [$0] } ?? visible.filter { !isHidden($0) }
    picked.formUnion(cols.flatMap(\.cards).map(\.ref))
  }


  /// Sweeps the cards visible in `column` (current scope and filter) to `target`.
  func sweep(_ column: Column, to target: String) {
    guard !column.cards.isEmpty else { return }
    writeGen += 1
    Task {
      do { try await client.sweep(column.cards, from: column.name, to: target) } catch { self.error = error.localizedDescription }
      await refresh()
    }
  }

  /// Asks for a time guess when exactly one card without one enters Doing from another column.
  private func askEstimate(_ cards: [Card], entering column: String) {
    guard column.caseInsensitiveCompare("Doing") == .orderedSame, cards.count == 1,
          cards[0].est == nil, cards[0].col.caseInsensitiveCompare(column) != .orderedSame else { return }
    estimating = cards[0]
  }

  func setEstimate(_ minutes: Int, for card: Card) {
    for i in columns.indices {
      if let j = columns[i].cards.firstIndex(where: { $0.ref == card.ref }) { columns[i].cards[j].est = minutes }
    }
    writeGen += 1
    Task {
      do { try await client.setEstimate(card, minutes: minutes) } catch { self.error = error.localizedDescription }
      await refresh()
    }
  }

  /// `ref` is a desktop name or number (`DesktopSpace.ref`); nil clears.
  /// Saves an edited note once its text has loaded; the refresh after it picks up refs that shifted below it in the same file.
  func setNote(_ text: String, ref: String) {
    guard let old = notes[ref], old != text else { return }
    notes[ref] = text
    writeGen += 1
    Task {
      do { try await client.setNote(ref: ref, text); await refresh() } catch { self.error = error.localizedDescription }
    }
  }

  func setDesktop(_ ref: String?, for card: Card) {
    for i in columns.indices {
      if let j = columns[i].cards.firstIndex(where: { $0.ref == card.ref }) { columns[i].cards[j].desktop = ref }
    }
    writeGen += 1
    Task {
      do { try await client.setDesktop(card, ref) } catch { self.error = error.localizedDescription }
      await refresh()
    }
  }

  /// The desktop a project is pinned to (Settings > Tracking, sidebar menu); nil = none.
  func projectDesktop(_ project: String) -> String? {
    DesktopPin.pins(activity.rules).first { $0.kind == .project && $0.name.caseInsensitiveCompare(project) == .orderedSame }?.desktop
  }

  /// The desktop a card shows and switches to: its own, else its project's or org's pin.
  func desktop(_ card: Card) -> String? {
    DesktopPin.desktop(own: card.desktop, orgs: card.orgs, projects: card.projects, activity.rules)
  }

  func setDesktop(_ ref: String?, project: String) {
    activity.saveRules(DesktopPin.setting(activity.rules, kind: .project, name: project, desktop: ref))
  }

  /// Names a desktop and rewrites cards that pointed at its old name or its number, so links survive.
  func renameDesktop(_ space: DesktopSpace, to name: String?) {
    let old = space.ref
    guard desktops.rename(space, to: name) else {
      error = "Desktop names need 1 to 40 characters, not only digits, and no %"
      return
    }
    guard let fresh = desktops.spaces.first(where: { $0.uuid == space.uuid }), fresh.ref != old else { return }
    let pins = DesktopPin.pins(activity.rules).filter { $0.desktop.caseInsensitiveCompare(old) == .orderedSame }
    if !pins.isEmpty {
      activity.saveRules(pins.reduce(activity.rules) { DesktopPin.setting($0, kind: $1.kind, name: $1.name, desktop: fresh.ref) })
    }
    let cards = columns.flatMap(\.cards).filter { $0.desktop?.caseInsensitiveCompare(old) == .orderedSame }
    guard !cards.isEmpty else { return }
    writeGen += 1
    Task {
      for card in cards.sorted(by: { $0.file == $1.file ? $0.line > $1.line : $0.file < $1.file }) {
        do { try await client.setDesktop(card, fresh.ref) } catch { self.error = error.localizedDescription }
      }
      await refresh()
    }
  }

  /// Switches to the desktop a card points at, by name or number.
  func switchDesktop(ref: String) {
    guard let space = desktops.resolve(ref) else {
      error = "No desktop named \(ref)"
      return
    }
    switchDesktop(space.number)
  }

  /// Presses Right Cmd+N while BetterTouchTool runs, else the macOS "Switch to Desktop N" shortcut.
  /// Needs Accessibility permission.
  func switchDesktop(_ n: Int) {
    let bttRunning = !NSRunningApplication.runningApplications(withBundleIdentifier: "com.hegenberg.BetterTouchTool").isEmpty
    let hotkeys = UserDefaults(suiteName: "com.apple.symbolichotkeys")?.dictionary(forKey: "AppleSymbolicHotKeys") ?? [:]
    guard let key = bttRunning ? Spaces.rightCommand(n) : Spaces.shortcut(n, in: hotkeys) else {
      error = "Enable Switch to Desktop \(n) in Keyboard Shortcuts > Mission Control"
      return
    }
    guard AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary) else {
      error = "Allow Kanban Board in Privacy & Security > Accessibility, then try again"
      return
    }
    // Right Cmd is pressed as its own key around the digit so modifier-side tracking sees it.
    let modifier: [(UInt16, Bool, UInt64)] = bttRunning ? [(Spaces.rightCommandKey, true, key.flags)] : []
    let release: [(UInt16, Bool, UInt64)] = bttRunning ? [(Spaces.rightCommandKey, false, 0)] : []
    for (code, down, flags) in modifier + [(key.code, true, key.flags), (key.code, false, key.flags)] + release {
      let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
      event?.flags = CGEventFlags(rawValue: flags)
      event?.post(tap: .cghidEventTap)
    }
  }

  /// Selects `card` and brings the board window forward. Launch Services activation, like
  /// `ObsidianClient.bringForward`: a widget click never makes this app active. With no board
  /// window open, the reopen event makes SwiftUI create one.
  func reveal(_ card: Card) {
    select(card.ref)
    let config = NSWorkspace.OpenConfiguration()
    config.activates = true
    NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: config) { _, _ in
      DispatchQueue.main.async {
        guard let board = NSApp.windows.first(where: { $0.title == "Kanban Board" }) else { return }
        if board.isMiniaturized { board.deminiaturize(nil) }
        board.makeKeyAndOrderFront(nil)
      }
    }
  }

  func open(_ card: Card) {
    Task { do { try await client.open(card) } catch { self.error = error.localizedDescription } }
  }

  func append(_ term: String) {
    if let t = Query.parse(term).first, let key = t.key, !t.value.isEmpty,
       Query.singleValued.contains(Query.canonical(key)) {
      let next = Query.toggling(query, term: term)
      query = next.isEmpty ? "" : next + " "
      return
    }
    let spaced = query.isEmpty || query.hasSuffix(" ") ? query : query + " "
    if !Query.parse(query).contains(where: { "\($0.key ?? ""):\($0.value)" == term.replacingOccurrences(of: "\"", with: "") }) {
      query = spaced + term + (term.hasSuffix(":") ? "" : " ")
    }
  }

  var catalog: Catalog {
    Catalog.make(columns: columns.map(\.name), projects: facets(\.projects).map(\.name), orgs: orgs.map(\.name),
                 tags: facets(\.tags).map(\.name), views: visibleViews.map(\.name))
  }

  /// A finished `view:Name` term applies that view; any other term joins the filter.
  func accept(_ term: String) {
    guard let t = Query.parse(term).first, t.key == "view", !t.negated else { return append(term) }
    saved.first { $0.name.caseInsensitiveCompare(t.value) == .orderedSame }.map(apply)
  }

  func quote(_ value: String) -> String { value.contains(" ") ? "\"\(value)\"" : value }

  /// Views listed in the sidebar: all-workspace views, plus the current workspace's own
  /// (every view while no workspace is selected).
  var visibleViews: [SavedFilter] {
    saved.filter { $0.orgs.isEmpty || activeOrgs.isEmpty || !Set($0.orgs).isDisjoint(with: activeOrgs) }
  }

  var activeView: SavedFilter? {
    let q = query.trimmingCharacters(in: .whitespaces)
    return saved.first { $0.query == q && ($0.orgs.isEmpty || Set($0.orgs) == Set(activeOrgs)) }
  }

  /// A view without orgs is a filter for any workspace: it keeps the current selection.
  func apply(_ view: SavedFilter) {
    if !view.orgs.isEmpty { orgScope = view.orgs }
    query = view.query
  }

  /// Plain click selects one workspace; command-click adds or removes it.
  func selectOrg(_ name: String, additive: Bool) {
    guard additive else { orgScope = [name]; return }
    if orgScope.contains(name) { orgScope.removeAll { $0 == name } } else { orgScope.append(name) }
  }

  func newView(query: String = "") { editing = ViewDraft(query: query, orgs: activeOrgs) }

  func edit(_ view: SavedFilter) {
    editing = ViewDraft(id: view.id, existing: true, name: view.name, query: view.query, orgs: view.orgs)
  }

  func saveDraft(_ draft: ViewDraft) {
    let view = SavedFilter(id: draft.id, name: draft.name.trimmingCharacters(in: .whitespaces),
                           query: draft.query.trimmingCharacters(in: .whitespaces), orgs: draft.orgs)
    guard !view.name.isEmpty else { return }
    if let i = saved.firstIndex(where: { $0.id == view.id }) { saved[i] = view } else { saved.append(view); apply(view) }
    persistSaved()
    editing = nil
  }

  func updateToCurrent(_ view: SavedFilter) {
    guard let i = saved.firstIndex(where: { $0.id == view.id }) else { return }
    saved[i].query = query.trimmingCharacters(in: .whitespaces)
    saved[i].orgs = activeOrgs
    persistSaved()
  }

  func matchCount(query: String, orgs: [String]) -> Int {
    Filter.apply(Filter.scope(columns, orgs: orgs), Query.parse(query)).reduce(0) { $0 + $1.cards.count }
  }

  func delete(_ filter: SavedFilter) {
    saved.removeAll { $0.id == filter.id }
    persistSaved()
  }

  private func persistSaved() {
    UserDefaults.standard.set(try? JSONEncoder().encode(saved), forKey: "kanban.saved")
  }
}

/// Global "take a break" key (Settings > Tracking), default F6 (fn+F6 on a Mac keyboard).
/// Carbon hot keys work while the app is in the background and need no Accessibility permission.
@MainActor
final class BreakHotKey {
  static let shared = BreakHotKey()
  static let codeKey = "kanban.breakKey", modsKey = "kanban.breakMods", labelKey = "kanban.breakLabel"
  var action: () -> Void = {}
  private var ref: EventHotKeyRef?
  private var handler: EventHandlerRef?

  func install() {
    if handler == nil {
      var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
      InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
        DispatchQueue.main.async { MainActor.assumeIsolated { BreakHotKey.shared.action() } }
        return noErr
      }, 1, &spec, nil, &handler)
    }
    register()
  }

  /// Unregisters, then registers the stored key; a stored code of -1 means none.
  func register() {
    pause()
    let d = UserDefaults.standard
    let code = d.object(forKey: Self.codeKey) as? Int ?? kVK_F6
    guard code >= 0 else { return }
    RegisterEventHotKey(UInt32(code), UInt32(d.integer(forKey: Self.modsKey)), EventHotKeyID(signature: 0x4B42524B, id: 1),
                        GetApplicationEventTarget(), 0, &ref)
  }

  /// Off while Settings records a new key, so the old one does not fire.
  func pause() {
    if let ref { UnregisterEventHotKey(ref) }
    ref = nil
  }

  /// Carbon modifier mask from AppKit flags.
  static func carbon(_ f: NSEvent.ModifierFlags) -> Int {
    (f.contains(.command) ? cmdKey : 0) | (f.contains(.shift) ? shiftKey : 0)
      | (f.contains(.option) ? optionKey : 0) | (f.contains(.control) ? controlKey : 0)
  }

  /// "⌃⌥F6", "⌘B".
  static func label(_ e: NSEvent) -> String {
    let fkeys = [122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8",
                 101: "F9", 109: "F10", 103: "F11", 111: "F12", 105: "F13", 107: "F14", 113: "F15"]
    let f = e.modifierFlags
    let mods = (f.contains(.control) ? "⌃" : "") + (f.contains(.option) ? "⌥" : "") + (f.contains(.shift) ? "⇧" : "") + (f.contains(.command) ? "⌘" : "")
    return mods + (fkeys[Int(e.keyCode)] ?? (e.charactersIgnoringModifiers ?? "?").uppercased())
  }
}
