import Combine
import Foundation
import KanbanCore
import SwiftUI

/// State of one board window: workspace scope, filter, selection, picks, palette and editors.
/// The board data, moves and tracking stay in the one shared `BoardStore`.
/// The main window (`org` nil) saves its state to defaults; an org window starts on that org and its saved filter.
@MainActor
final class BoardWindow: ObservableObject {
  let store: BoardStore
  /// The org this window was opened for; nil for the main window.
  let org: String?
  private var persists: Bool { org == nil }

  /// Selected workspaces; empty = all. "" (Filter.noOrg) selects cards with no org.
  @Published var orgScope: [String] {
    didSet {
      if persists { UserDefaults.standard.set(orgScope, forKey: "kanban.orgs") }
      // Each workspace selection keeps its own filter: switching brings that selection's filter back.
      if BoardStore.scopeKey(oldValue) != BoardStore.scopeKey(orgScope) {
        store.orgQueries[BoardStore.scopeKey(oldValue)] = query
        query = store.orgQueries[BoardStore.scopeKey(orgScope)] ?? ""
      }
    }
  }
  @Published var query: String {
    didSet {
      if persists { UserDefaults.standard.set(query, forKey: "kanban.query") }
      if store.orgQueries[BoardStore.scopeKey(orgScope)] != query { store.orgQueries[BoardStore.scopeKey(orgScope)] = query }
    }
  }
  @Published var mode: ViewMode = ViewMode(rawValue: UserDefaults.standard.string(forKey: "kanban.mode") ?? "") ?? .board {
    didSet { if persists { UserDefaults.standard.set(mode.rawValue, forKey: "kanban.mode") } }
  }
  @Published var showSidebar = UserDefaults.standard.object(forKey: "kanban.sidebar") as? Bool ?? true {
    didSet { if persists { UserDefaults.standard.set(showSidebar, forKey: "kanban.sidebar") } }
  }
  @Published private(set) var selected: String?
  /// Multi-selection (checkboxes); a drag of a picked card carries all of them.
  @Published var picked: Set<String> = []
  @Published var paletteOpen = false
  /// Column the new-card modal adds to; nil while it is closed.
  @Published var newCardColumn: String?
  @Published var focusFilter = 0
  @Published var filterFocused = false
  @Published var paletteText = ""
  @Published var paletteIndex = 0
  @Published var editing: ViewDraft?
  private var sinks: Set<AnyCancellable> = []

  init(store: BoardStore, org: String?) {
    self.store = store
    self.org = org
    if let org {
      orgScope = [org]
      query = store.orgQueries[BoardStore.scopeKey([org])] ?? ""
    } else {
      orgScope = UserDefaults.standard.stringArray(forKey: "kanban.orgs")
        ?? UserDefaults.standard.string(forKey: "kanban.org").map { [$0] } ?? []
      query = UserDefaults.standard.string(forKey: "kanban.query") ?? ""
    }
    // Moved cards leave the picks; refreshed data drops picks whose card is gone.
    store.moved.sink { [weak self] refs in self?.picked.subtract(refs) }.store(in: &sinks)
    store.$columns.sink { [weak self] columns in
      guard let self else { return }
      let refs = Set(columns.flatMap(\.cards).map(\.ref))
      if !picked.isSubset(of: refs) { picked.formIntersection(refs) }
    }.store(in: &sinks)
  }

  /// Selected org, ignored once it no longer exists on the board.
  var activeOrgs: [String] {
    let known = Set(store.orgs.map(\.name))
    return orgScope.filter { $0 == Filter.noOrg || known.contains($0) || !store.loaded }
  }
  var scoped: [Column] { Filter.scope(store.columns, orgs: activeOrgs) }
  var visible: [Column] {
    let cols = Filter.apply(scoped, Query.parse(query))
    return Ordering.arranged(cols.map(\.name), saved: store.columnOrder).compactMap { n in cols.first { $0.name == n } }
  }
  var total: Int { scoped.reduce(0) { $0 + $1.cards.count } }
  var shown: Int { visible.reduce(0) { $0 + $1.cards.count } }

  /// Swaps a column with its neighbour; `by` is -1 (left) or +1 (right).
  func shiftColumn(_ column: Column, by step: Int) {
    let names = visible.map(\.name)
    guard let i = names.firstIndex(of: column.name), names.indices.contains(i + step) else { return }
    withAnimation(.spring(duration: 0.3)) { store.columnOrder = Ordering.moving(names, column.name, onto: names[i + step]) }
  }

  /// Counts of a card field over non-done columns, most frequent first.
  /// Names come from the org scope; counts come from what the board currently shows.
  func facets(_ pick: (Card) -> [String]) -> [(name: String, count: Int)] {
    let shown = Dictionary(uniqueKeysWithValues: BoardStore.counts(in: visible, pick).map { ($0.name, $0.count) })
    return BoardStore.counts(in: scoped, pick).map { (name: $0.name, count: shown[$0.name] ?? 0) }
  }

  var selectedCard: Card? { selected.flatMap { ref in store.columns.lazy.flatMap(\.cards).first { $0.ref == ref } } }

  /// Every shown card ref, column by column, in screen order.
  var shownRefs: [String] { visible.filter { !store.isHidden($0) }.flatMap { store.ordered($0).map(\.ref) } }

  func select(_ ref: String?) {
    selected = ref
    selectedCard.map(store.loadNote)
  }

  /// dx walks to the neighbouring non-empty column; dy walks within a column.
  func moveSelection(dx: Int, dy: Int) {
    let cols = visible.map(store.ordered)
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

  func openSelected() { selectedCard.map(store.open) }

  func togglePick(_ ref: String) {
    if picked.contains(ref) { picked.remove(ref) } else { picked.insert(ref) }
  }
  /// Picks every card shown on the board, or only `column`'s.
  func pickAll(in column: Column? = nil) {
    let cols = column.map { [$0] } ?? visible.filter { !store.isHidden($0) }
    picked.formUnion(cols.flatMap(\.cards).map(\.ref))
  }

  /// Org and project a new card takes from the workspace scope and the filter (`NewCard.scope`).
  var newCardScope: (org: String?, project: String?) {
    NewCard.scope(orgScope: activeOrgs, terms: Query.parse(query), cards: store.columns.flatMap(\.cards))
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
    Catalog.make(columns: store.columns.map(\.name), projects: facets(\.projects).map(\.name), orgs: store.orgs.map(\.name),
                 tags: facets(\.tags).map(\.name), views: visibleViews.map(\.name))
  }

  /// A finished `view:Name` term applies that view; any other term joins the filter.
  func accept(_ term: String) {
    guard let t = Query.parse(term).first, t.key == "view", !t.negated else { return append(term) }
    store.saved.first { $0.name.caseInsensitiveCompare(t.value) == .orderedSame }.map(apply)
  }

  /// Views listed in the sidebar: all-workspace views, plus the current workspace's own
  /// (every view while no workspace is selected).
  var visibleViews: [SavedFilter] {
    store.saved.filter { $0.orgs.isEmpty || activeOrgs.isEmpty || !Set($0.orgs).isDisjoint(with: activeOrgs) }
  }

  var activeView: SavedFilter? {
    let q = query.trimmingCharacters(in: .whitespaces)
    return store.saved.first { $0.query == q && ($0.orgs.isEmpty || Set($0.orgs) == Set(activeOrgs)) }
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
    if store.save(view) { apply(view) }
    editing = nil
  }

  func updateToCurrent(_ view: SavedFilter) {
    store.update(view, query: query.trimmingCharacters(in: .whitespaces), orgs: activeOrgs)
  }
}
