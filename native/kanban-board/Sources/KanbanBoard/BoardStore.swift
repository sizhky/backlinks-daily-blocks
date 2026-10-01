import Foundation
import KanbanCore
import SwiftUI

enum ViewMode: String { case board, list }

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
  @Published var grouped = UserDefaults.standard.object(forKey: "kanban.grouped2") as? Bool ?? false {
    didSet { UserDefaults.standard.set(grouped, forKey: "kanban.grouped2") }
  }
  /// Selected workspaces; empty = all. "" (Filter.noOrg) selects cards with no org.
  @Published var orgScope: [String] = UserDefaults.standard.stringArray(forKey: "kanban.orgs")
    ?? UserDefaults.standard.string(forKey: "kanban.org").map { [$0] } ?? [] {
    didSet { UserDefaults.standard.set(orgScope, forKey: "kanban.orgs") }
  }
  @Published var mode: ViewMode = ViewMode(rawValue: UserDefaults.standard.string(forKey: "kanban.mode") ?? "") ?? .board {
    didSet { UserDefaults.standard.set(mode.rawValue, forKey: "kanban.mode") }
  }
  @Published var showSidebar = UserDefaults.standard.object(forKey: "kanban.sidebar") as? Bool ?? true {
    didSet { UserDefaults.standard.set(showSidebar, forKey: "kanban.sidebar") }
  }
  @Published var inspectorOpen = UserDefaults.standard.object(forKey: "kanban.inspector") as? Bool ?? true {
    didSet { UserDefaults.standard.set(inspectorOpen, forKey: "kanban.inspector") }
  }
  @Published private(set) var selected: String?
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
  var visible: [Column] { Filter.apply(scoped, Query.parse(query)) }
  var total: Int { scoped.reduce(0) { $0 + $1.cards.count } }
  var orgs: [(name: String, count: Int)] { counts(in: columns, \.orgs) }
  var shown: Int { visible.reduce(0) { $0 + $1.cards.count } }

  /// Counts of a card field over non-done columns, most frequent first.
  /// Names come from the org scope; counts come from what the board currently shows.
  func facets(_ pick: (Card) -> [String]) -> [(name: String, count: Int)] {
    let shown = Dictionary(uniqueKeysWithValues: counts(in: visible, pick).map { ($0.name, $0.count) })
    return counts(in: scoped, pick).map { (name: $0.name, count: shown[$0.name] ?? 0) }
  }

  func doingCount(org: String) -> Int {
    Filter.scope(columns, orgs: [org]).first { $0.name.caseInsensitiveCompare("Doing") == .orderedSame }?.cards.count ?? 0
  }

  var hasUnassigned: Bool { columns.contains { $0.done == false && $0.cards.contains { $0.orgs.isEmpty } } }

  private func counts(in columns: [Column], _ pick: (Card) -> [String]) -> [(name: String, count: Int)] {
    var counts: [String: Int] = [:]
    for column in columns where !column.done { for card in column.cards { for v in pick(card) { counts[v, default: 0] += 1 } } }
    return counts.map { (name: $0.key, count: $0.value) }.sorted { ($1.count, $0.name) < ($0.count, $1.name) }
  }

  var selectedCard: Card? { selected.flatMap { ref in columns.lazy.flatMap(\.cards).first { $0.ref == ref } } }

  /// Cards in the order the screen shows them, so arrow keys follow the eye.
  func ordered(_ column: Column) -> [Card] {
    grouped && mode == .board ? Grouping.byProject(column.cards).flatMap(\.cards) : column.cards
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

  func start() {
    guard loop == nil else { return }
    loop = Task { [weak self] in
      while !Task.isCancelled {
        await self?.refresh()
        try? await Task.sleep(for: .seconds(6))
      }
    }
  }

  func refresh() async {
    do {
      columns = try await client.board()
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
    loaded = true
  }

  func move(ref: String, to column: String) {
    guard let card = columns.lazy.flatMap(\.cards).first(where: { $0.ref == ref }),
      card.col.caseInsensitiveCompare(column) != .orderedSame else { return }
    withAnimation(.spring(duration: 0.38, bounce: 0.14)) {
      for i in columns.indices {
        columns[i].cards.removeAll { $0.ref == ref }
        if columns[i].name == column { columns[i].cards.insert(card.moved(to: column), at: 0) }
      }
    }
    Task {
      do { try await client.move(card, to: column) } catch { self.error = error.localizedDescription }
      await refresh()
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
