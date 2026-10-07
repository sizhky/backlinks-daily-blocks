import AppKit
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
    didSet { UserDefaults.standard.set(orgScope, forKey: "kanban.orgs") }
  }
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
    didSet { UserDefaults.standard.set(query, forKey: "kanban.query") }
  }

  private let client = ObsidianClient()
  private var loop: Task<Void, Never>?
  let activity = ActivityMonitor()
  private var desktopMenu: DesktopMenu?
  private(set) var widget: TrackerWidget?
  private lazy var timeline = TimelineWindow(activity: activity)

  func openTimeline() { timeline.show() }
  private var desktopSink: Any?
  let desktops = DesktopStore.shared
  /// 4.2 Rule moves; persisted so a relaunch can still resume what it parked.
  private var switches: SwitchEngine = UserDefaults.standard.data(forKey: "kanban.switches")
    .flatMap { try? JSONDecoder().decode(SwitchEngine.self, from: $0) } ?? SwitchEngine()

  init() {
    query = UserDefaults.standard.string(forKey: "kanban.query") ?? ""
    saved = UserDefaults.standard.data(forKey: "kanban.saved")
      .flatMap { try? JSONDecoder().decode([SavedFilter].self, from: $0) } ?? SavedFilter.defaults
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
    if column.done { return Logbook.newestFirst(column.cards) }
    let rest = column.cards.filter { $0.rank == nil }
    return Ranking.ordered(column.cards.filter { $0.rank != nil })
      + (mode == .board ? Grouping.byProject(rest).flatMap(\.cards) : rest)
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
    desktopMenu = DesktopMenu(store: self)
    widget = TrackerWidget(store: self)
    desktopSink = desktops.objectWillChange.sink { [weak self] in MainActor.assumeIsolated { self?.objectWillChange.send() } }
    Task {
      do {
        let vault = URL(fileURLWithPath: try await client.vaultPath(), isDirectory: true)
        desktops.start(dir: vault.appendingPathComponent(".activity", isDirectory: true))
        activity.start(vault: vault)
      } catch { self.error = error.localizedDescription }
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
      withAnimation(DragController.spring) { columns = fresh }
      picked.formIntersection(columns.flatMap(\.cards).map(\.ref))
      error = nil
      switchTasks()
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

  /// Names a desktop and rewrites cards that pointed at its old name or its number, so links survive.
  func renameDesktop(_ space: DesktopSpace, to name: String?) {
    let old = space.ref
    guard desktops.rename(space, to: name) else {
      error = "Desktop names need 1 to 40 characters, not only digits, and no %"
      return
    }
    guard let fresh = desktops.spaces.first(where: { $0.uuid == space.uuid }), fresh.ref != old else { return }
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

  /// Presses the user's "Switch to Desktop N" shortcut. Needs Accessibility permission.
  func switchDesktop(_ n: Int) {
    let hotkeys = UserDefaults(suiteName: "com.apple.symbolichotkeys")?.dictionary(forKey: "AppleSymbolicHotKeys") ?? [:]
    guard let key = Spaces.shortcut(n, in: hotkeys) else {
      error = "Enable Switch to Desktop \(n) in Keyboard Shortcuts > Mission Control"
      return
    }
    guard AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary) else {
      error = "Allow Kanban Board in Privacy & Security > Accessibility, then try again"
      return
    }
    for down in [true, false] {
      let event = CGEvent(keyboardEventSource: nil, virtualKey: key.code, keyDown: down)
      event?.flags = CGEventFlags(rawValue: key.flags)
      event?.post(tap: .cghidEventTap)
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
    return saved.first { $0.query == q && Set($0.orgs) == Set(activeOrgs) }
  }

  func apply(_ view: SavedFilter) {
    orgScope = view.orgs
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
