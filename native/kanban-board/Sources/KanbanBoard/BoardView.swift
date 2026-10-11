import KanbanCore
import SwiftUI

/// Main panel: an inset rounded sheet holding header, board or list, and the issue peek.
struct BoardView: View {
  @EnvironmentObject var store: BoardStore
  @EnvironmentObject var drag: DragController
  @FocusState private var boardFocus: Bool
  @State private var estimateText = ""

  var body: some View {
    HStack(spacing: 0) {
      VStack(spacing: 0) {
        BoardHeader()
        Group { switch store.mode { case .board: ColumnsScroller(); case .list: ListMode(); case .logbook: LogbookMode() } }
          .simultaneousGesture(DragGesture(minimumDistance: 4, coordinateSpace: .named(DragController.space))
            .onChanged { drag.changed($0) }
            .onEnded { _ in drag.ended() })
        StatusLine()
      }
      if let card = store.selectedCard {
        Rectangle().fill(Palette.hairline).frame(width: 1)
        Inspector(card: card).transition(.move(edge: .trailing).combined(with: .opacity))
      }
    }
    .overlay(alignment: .topLeading) { FloatingCard(pointer: drag.pointer) }
    .overlay(alignment: .bottom) { Toast(message: store.toast) }
    .coordinateSpace(.named(DragController.space))
    .background(Palette.base)
    .clipShape(.rect(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Palette.hairline))
    .padding(.top, 8).padding(.trailing, 8).padding(.bottom, 8)
    .alert("How long will this take?", isPresented: Binding(get: { store.estimating != nil }, set: { if !$0 { store.estimating = nil } })) {
      TextField("e.g. 30m, 2h, 1h30m", text: $estimateText)
      Button("Set") {
        if let card = store.estimating, let m = Age.minutes(estimateText) { store.setEstimate(m, for: card) }
        estimateText = ""
      }
      Button("Skip", role: .cancel) { estimateText = "" }
    } message: { Text(store.estimating?.title ?? "") }
    .onChange(of: store.estimating?.ref) { estimateText = store.estimating?.est.map { Age.label(minutes: $0) } ?? "" }
    .animation(.spring(duration: 0.32, bounce: 0.08), value: store.selected != nil)
    .focusable().focused($boardFocus).focusEffectDisabled()
    .onChange(of: store.selected) { boardFocus = true }
    .onKeyPress(.upArrow) { board { store.moveSelection(dx: 0, dy: -1) } }
    .onKeyPress(.downArrow) { board { store.moveSelection(dx: 0, dy: 1) } }
    .onKeyPress(.leftArrow) { board { store.moveSelection(dx: -1, dy: 0) } }
    .onKeyPress(.rightArrow) { board { store.moveSelection(dx: 1, dy: 0) } }
    .onKeyPress(characters: ["j"]) { _ in board { store.moveSelection(dx: 0, dy: 1) } }
    .onKeyPress(characters: ["k"]) { _ in board { store.moveSelection(dx: 0, dy: -1) } }
    .onKeyPress(characters: ["/"]) { _ in board { store.focusFilter += 1 } }
    .onKeyPress(.return) { board { store.openSelected() } }
    .onKeyPress(.escape) { board { store.select(nil) } }
  }

  /// Board shortcuts; keys go to the text instead while a text view (the Inspector note) has focus.
  private func board(_ action: () -> Void) -> KeyPress.Result {
    if NSApp.keyWindow?.firstResponder is NSTextView { return .ignored }
    action()
    return .handled
  }
}

struct BoardHeader: View {
  @EnvironmentObject var store: BoardStore
  @AppStorage(BreakHotKey.labelKey) private var breakKey = "F6"
  @FocusState private var focused: Bool
  @State private var pickingOrgs = false
  @State private var tabMonitor: Any?
  private let keys = ["col:", "tag:", "project:", "org:", "stale:", "age:", "no:", "has:"]

  private var terms: [QueryTerm] { Query.parse(store.query).filter { !$0.value.isEmpty } }
  private var viewName: String {
    let q = store.query.trimmingCharacters(in: .whitespaces)
    return store.activeView?.name ?? (q.isEmpty ? "All issues" : "Filtered")
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        breadcrumb
        Spacer()
        filterField
        Rectangle().fill(Palette.hairline).frame(width: 1, height: 16).padding(.horizontal, 2)
        HStack(spacing: 2) {
          IconButton(icon: "rectangle.split.3x1", help: "Board", active: store.mode == .board) { store.mode = .board }
          IconButton(icon: "list.bullet", help: "List", active: store.mode == .list) { store.mode = .list }
          IconButton(icon: "book.closed", help: "Logbook", active: store.mode == .logbook) { store.mode = .logbook }
        }
        IconButton(icon: "cup.and.saucer", help: "Take a break: park every Doing card; again to resume them" + (breakKey.isEmpty ? "" : " (\(breakKey))")) { store.takeBreak() }
        IconButton(icon: "calendar.day.timeline.left", help: "Timeline (⇧⌘T)") { store.openTimeline() }
        IconButton(icon: "command", help: "Commands (⌘K)") { store.paletteOpen = true }
      }
      .padding(.horizontal, 14).frame(height: 46)
      if focused || !terms.isEmpty { chips }
      Divider().overlay(Palette.hairline)
    }
    .onChange(of: store.focusFilter) { focused = true }
    .onAppear { installTabMonitor() }
    .onChange(of: focused) { store.filterFocused = focused }
    .onDisappear { tabMonitor.map(NSEvent.removeMonitor); tabMonitor = nil }
    .background(Button("") { focused = true }.keyboardShortcut("f", modifiers: .command).opacity(0))
  }

  private var breadcrumb: some View {
    HStack(spacing: 7) {
      if !store.activeOrgs.isEmpty {
        Button { pickingOrgs.toggle() } label: {
          HStack(spacing: 6) {
            ForEach(store.activeOrgs.prefix(3), id: \.self) { org in
              if org == Filter.noOrg { Image(systemName: "tray").font(.system(size: 11)) }
              else { OrgIcon(name: org, size: 16).clipShape(.circle) }
            }
            Text(store.activeOrgs.count == 1 ? OrgPicker.label(store.activeOrgs[0]) : "\(store.activeOrgs.count) workspaces")
              .foregroundStyle(Palette.secondary)
          }
        }
        .buttonStyle(.pointing)
        Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(Palette.muted)
      }
      Text(viewName).foregroundStyle(Palette.text)
      Text("\(store.shown)").font(.system(size: 12).monospacedDigit()).foregroundStyle(Palette.muted)
      Button { pickingOrgs.toggle() } label: {
        Image(systemName: "building.2").font(.system(size: 11)).foregroundStyle(Palette.muted)
      }
      .buttonStyle(.pointing).help("Choose workspaces")
    }
    .font(.system(size: 13, weight: .medium))
    .popover(isPresented: $pickingOrgs, arrowEdge: .bottom) {
      VStack(alignment: .leading, spacing: 8) {
        Text("Workspaces").font(.system(size: 12)).foregroundStyle(Palette.muted)
        OrgPicker(selected: $store.orgScope)
      }
      .padding(14).frame(width: 340)
    }
  }

  private var suggestions: [Suggestion] { focused ? Array(store.catalog.suggest(store.query).prefix(8)) : [] }

  /// The text field takes Tab for focus traversal before onKeyPress sees it, so catch it at the window.
  private func installTabMonitor() {
    guard tabMonitor == nil else { return }
    let store = store
    tabMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
      guard event.keyCode == 48, event.modifierFlags.intersection([.shift, .command, .option, .control]).isEmpty,
            NSApp.keyWindow?.firstResponder is NSTextView else { return event }
      if store.paletteOpen { return store.paletteTab() ? nil : event }
      guard let s = Array(store.catalog.suggest(store.query).prefix(8))[safe: store.pick] else { return event }
      Self.complete(s, store)
      return nil
    }
  }

  private func complete(_ s: Suggestion) { Self.complete(s, store) }

  @MainActor private static func complete(_ s: Suggestion, _ store: BoardStore) {
    if !s.isKey, s.term.lowercased().hasPrefix("view:") { store.accept(s.term); return }
    store.query = Catalog.replacing(store.query, with: s)
  }

  private var filterField: some View {
    let shown = suggestions
    return HStack(spacing: 7) {
      Image(systemName: "line.3.horizontal.decrease").font(.system(size: 11)).foregroundStyle(Palette.muted)
      TextField("Filter", text: $store.query)
        .textFieldStyle(.plain).font(.system(size: 12.5)).focused($focused)
        .foregroundStyle(focused || terms.isEmpty ? Palette.text : .clear)
        .overlay(alignment: .leading) {
          if !focused && !terms.isEmpty {
            Text("Filter").font(.system(size: 12.5)).foregroundStyle(Palette.muted).allowsHitTesting(false)
          }
        }
        .onKeyPress(.escape) { focused = false; return .handled }
        .onKeyPress(.downArrow) { guard !shown.isEmpty else { return .ignored }; store.pick = min(shown.count - 1, store.pick + 1); return .handled }
        .onKeyPress(.upArrow) { guard !shown.isEmpty else { return .ignored }; store.pick = max(0, store.pick - 1); return .handled }
        .onSubmit { if shown.indices.contains(store.pick) { complete(shown[store.pick]); focused = true } }
        .onChange(of: store.query) { store.pick = 0 }
    }
    .padding(.horizontal, 10).padding(.vertical, 5).frame(width: 280)
    .background(Color.white.opacity(0.04), in: .rect(cornerRadius: 7))
    .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(focused ? Palette.indigo : Palette.hairline))
    .overlay(alignment: .topLeading) { if !shown.isEmpty { suggestionList(shown).offset(y: 32) } }
    .zIndex(1)
  }

  private func suggestionList(_ shown: [Suggestion]) -> some View {
    VStack(spacing: 1) {
      ForEach(Array(shown.enumerated()), id: \.offset) { i, s in
        HStack(spacing: 8) {
          Image(systemName: s.isKey ? "number" : "text.append").font(.system(size: 10)).foregroundStyle(Palette.muted).frame(width: 14)
          Text(s.label).lineLimit(1).font(.system(size: 12.5, design: s.isKey ? .monospaced : .default))
          Spacer()
        }
        .padding(.horizontal, 8).padding(.vertical, 5)
        .background(i == store.pick ? Palette.selected : .clear, in: .rect(cornerRadius: 6))
        .contentShape(Rectangle())
        .onTapGesture { complete(s); focused = true }.pointerStyle(.link)
      }
    }
    .padding(4).frame(width: 280)
    .background(Palette.base, in: .rect(cornerRadius: 9))
    .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Palette.hairline))
  }

  private var chips: some View {
    FlowLayout(spacing: 6) {
      ForEach(Array(terms.enumerated()), id: \.offset) { index, term in chip(term, index) }
      if !terms.isEmpty {
        Button("Save view") { store.newView(query: store.query) }.buttonStyle(.pointing).foregroundStyle(Palette.muted).frame(height: 24)
        Button("Clear") { store.query = "" }.buttonStyle(.pointing).foregroundStyle(Palette.muted).frame(height: 24)
      }
      if focused {
        ForEach(keys, id: \.self) { key in
          Button(key) { store.append(key); focused = true }
            .buttonStyle(.pointing).font(.system(size: 11, design: .monospaced)).foregroundStyle(Palette.muted.opacity(0.8)).frame(height: 24)
        }
      }
    }
    .font(.system(size: 12))
    .padding(.horizontal, 14).padding(.bottom, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func chip(_ term: QueryTerm, _ index: Int) -> some View {
    let key = term.key.map { Query.canonical($0).capitalized } ?? "Text"
    return HStack(spacing: 0) {
      Text(key).foregroundStyle(Palette.secondary).padding(.horizontal, 8)
      Rectangle().fill(Palette.hairline).frame(width: 1)
      Text(term.key == nil ? "contains" : (term.negated ? "is not" : "is")).foregroundStyle(Palette.muted).padding(.horizontal, 7)
      Rectangle().fill(Palette.hairline).frame(width: 1)
      Text(term.value).foregroundStyle(Palette.text).padding(.horizontal, 8)
      Rectangle().fill(Palette.hairline).frame(width: 1)
      Button {
        store.query = Query.format(Query.parse(store.query).enumerated().filter { $0.element != term }.map(\.element))
      } label: { Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).padding(.horizontal, 7) }
        .buttonStyle(.pointing).foregroundStyle(Palette.muted)
    }
    .frame(height: 24)
    .background(Color.white.opacity(0.03), in: .rect(cornerRadius: 6))
    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.hairline))
  }
}

struct ColumnsScroller: View {
  @EnvironmentObject var store: BoardStore
  @EnvironmentObject var drag: DragController
  @State private var position = ScrollPosition()
  @State private var offsetX: CGFloat = 0
  @State private var maxX: CGFloat = 0
  private let timer = Timer.publish(every: 1.0 / 60, on: .main, in: .common).autoconnect()
  private let zone: CGFloat = 150

  var body: some View {
    GeometryReader { geo in
      ScrollView(.horizontal) {
        HStack(alignment: .top, spacing: 10) {
          ForEach(store.visible.filter { !store.isHidden($0) }) { ColumnView(column: $0) }
          HiddenColumns(columns: store.visible.filter { store.isHidden($0) })
        }
        .animation(.spring(duration: 0.32, bounce: 0.08), value: store.visible.map { "\($0.name)\($0.cards.isEmpty)\(store.isHidden($0))" })
        .scrollTargetLayout()
        .frame(height: geo.size.height)
        .padding(.horizontal, 14)
      }
      .scrollIndicators(.never)
      .scrollPosition($position)
      .onScrollGeometryChange(for: CGPoint.self) {
        CGPoint(x: $0.contentOffset.x, y: max(0, $0.contentSize.width - $0.containerSize.width))
      } action: { _, new in (offsetX, maxX) = (new.x, new.y) }
      .onReceive(timer) { _ in autoscroll(in: geo.frame(in: .global)) }
      .onChange(of: store.selected) {
        if let card = store.selectedCard { withAnimation { position.scrollTo(id: card.col) } }
      }
    }
  }

  /// While the mouse button is held (a card drag), the outer `zone` points of the board
  /// scroll it sideways; speed grows quadratically with depth into the zone.
  private func autoscroll(in frame: CGRect) {
    guard NSEvent.pressedMouseButtons & 1 != 0, let win = NSApp.keyWindow, let content = win.contentView else { return }
    let mouse = win.mouseLocationOutsideOfEventStream
    let y = content.bounds.height - mouse.y
    let x = mouse.x - frame.minX
    var direction = 0, depth: CGFloat = 0
    if y >= frame.minY && y <= frame.maxY {
      if x < zone { direction = -1; depth = min(1, (zone - x) / zone) }
      else if x > frame.width - zone { direction = 1; depth = min(1, (x - (frame.width - zone)) / zone) }
    }
    guard direction != 0 else { return }
    let next = min(maxX, max(0, offsetX + CGFloat(direction) * depth * depth * 28))
    if next != offsetX { offsetX = next; position.scrollTo(x: next); drag.retarget() }
  }
}

struct ColumnView: View {
  @EnvironmentObject var store: BoardStore
  @EnvironmentObject var drag: DragController
  @AppStorage(Density.key) private var density: Density = .compact
  let column: Column

  /// An empty column shrinks to a slim strip in place. A drag over it only highlights the strip;
  /// the column widens after the drop puts a card in it.
  private var collapsed: Bool { column.cards.isEmpty }

  /// `collapsed` as last animated. A drop ends its transaction with animations off, so the shrink
  /// follows `collapsed` through its own `withAnimation` instead of the transaction that caused it.
  @State private var shrunk: Bool?

  var body: some View {
    let shrunk = shrunk ?? collapsed
    ZStack(alignment: .top) {
      full.frame(width: density.columnWidth - 8).opacity(shrunk ? 0 : 1).allowsHitTesting(!shrunk)
      strip.opacity(shrunk ? 1 : 0).allowsHitTesting(false)
    }
    .padding(4)
    .frame(width: shrunk ? Self.stripWidth : density.columnWidth, alignment: .top)
    // Deferred a turn: inside the drop's transaction (animations disabled) a nested withAnimation is also disabled.
    .onChange(of: collapsed) { _, now in
      Task { @MainActor in withAnimation(.spring(duration: 0.32, bounce: 0.08)) { self.shrunk = now } }
    }
    .clipped()
    .background(targeted ? accent(for: column.name).opacity(0.08) : Color.white.opacity(0.02), in: .rect(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(targeted ? accent(for: column.name).opacity(0.55) : .clear))
    .dragFrame(column.name, in: \.columns, drag.frames)
  }

  static let stripWidth: CGFloat = 44

  private var strip: some View {
    VStack(spacing: 10) {
      StatusGlyph(column: column.name, size: 14).padding(.top, 6)
      Text(column.name).font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.muted)
        .fixedSize().rotationEffect(.degrees(90)).frame(width: 16, height: 8 + CGFloat(column.name.count) * 7.5)
    }
  }

  private var full: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        StatusGlyph(column: column.name, size: 14)
        Text(column.name).font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.text)
        Text("\(column.cards.count)").font(.system(size: 13).monospacedDigit()).foregroundStyle(Palette.muted)
        Spacer()
        ColumnMenu(column: column)
      }
      .padding(.horizontal, 8).padding(.top, 6)
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: density.cardGap) {
            ForEach(drag.rows(column, store)) { row in
              if let card = row.card {
                IssueCard(card: card).dragFrame(card.id, in: \.cards, drag.frames)
              } else {
                GhostCard(column: column.name)
              }
            }
          }
          .padding(.horizontal, 4).padding(.bottom, 16)
        }
        .scrollIndicators(.never)
        .onChange(of: store.selected) {
          if let ref = store.selected, column.cards.contains(where: { $0.ref == ref }) {
            withAnimation { proxy.scrollTo(store.selectedCard?.id ?? ref) }
          }
        }
      }
    }
  }

  /// Highlight only a column the drag is entering from elsewhere.
  private var targeted: Bool { drag.slot?.column == column.name && drag.session?.home != column.name }
}

/// Total time in Doing (every stint) and active time; ticks each second while the card is in Doing.
struct TimePills: View {
  @EnvironmentObject var store: BoardStore
  let card: Card
  let live: Bool
  var tint = accent(for: "Doing")

  var body: some View {
    if card.col.caseInsensitiveCompare("Doing") == .orderedSame {
      TimelineView(.periodic(from: .now, by: 1)) { pills($0.date) }
    } else {
      pills(Date())
    }
  }

  @ViewBuilder private func pills(_ now: Date) -> some View {
    let doing = card.seconds(in: "Doing", at: now), active = store.activeTime(card, at: now)
    HStack(spacing: 6) {
      if doing > 0 {
        Pill(text: Age.span(seconds: doing), color: accent(for: "Doing")) { Image(systemName: "timer").imageScale(.small) }
          .help("Time in Doing, all stints")
      }
      if active > 0 || live {
        Pill(text: Age.span(seconds: active), color: live ? tint : Palette.muted) {
          Image(systemName: live ? "bolt.fill" : "bolt").imageScale(.small)
        }
        .help(live ? "Active now; active time" : "Active time")
      }
    }
  }
}

/// Column header options: hide, move left or right, and the plugin's sweep routes.
struct ColumnMenu: View {
  @EnvironmentObject var store: BoardStore
  let column: Column

  var body: some View {
    MenuTrigger(trailing: true, items: { store.columnItems(column) }) {
      Image(systemName: "ellipsis").font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.muted)
        .frame(width: 22, height: 22).contentShape(Rectangle())
    }
    .accessibilityLabel("Column options")
  }
}

extension BoardStore {
  func columnItems(_ column: Column) -> [MenuItem] {
    let names = visible.map(\.name)
    var items: [MenuItem] = [
      .action(isHidden(column) ? "Show column" : "Hide column", symbol: isHidden(column) ? "eye" : "eye.slash") { self.setHidden(column, !self.isHidden(column)) },
      .action("Select all in column", symbol: "checkmark.circle", disabled: column.cards.isEmpty) { self.pickAll(in: column) },
      .separator,
      .action("Move left", symbol: "arrow.left", disabled: names.first == column.name) { self.shiftColumn(column, by: -1) },
      .action("Move right", symbol: "arrow.right", disabled: names.last == column.name) { self.shiftColumn(column, by: 1) },
    ]
    if !column.sweeps.isEmpty {
      items.append(.separator)
      for target in column.sweeps {
        items.append(.action("Move \(column.cards.count) shown to \(target)", symbol: "arrow.right.circle", disabled: column.cards.isEmpty) {
          self.sweep(column, to: target)
        })
      }
    }
    return items
  }

  /// Right-click menu of a card; Status and Desktop are shared with the inspector.
  func cardItems(_ card: Card) -> [MenuItem] {
    [
      .action("Open in Obsidian", symbol: "arrow.up.forward.app", hint: "↵") { self.open(card) },
      .action("Copy ID", symbol: "number", hint: "⇧⌘C") { self.copyID(card) },
      .separator,
      .submenu("Move to", symbol: "arrow.right", statusItems(card)),
      .submenu("Desktop", symbol: "rectangle.3.group", desktopItems(card)),
    ]
  }

  func statusItems(_ card: Card) -> [MenuItem] {
    columns.map { c in
      .action(c.name, glyph: AnyView(StatusGlyph(column: c.name, size: 12)), checked: c.name == card.col) {
        self.move(ref: card.ref, to: c.name)
      }
    }
  }

  func desktopItems(_ card: Card) -> [MenuItem] {
    desktopChoices(card.desktop) { self.setDesktop($0, for: card) }
  }

  /// Desktop menu for a project row in the sidebar: pins every card of the project (`DesktopPin`).
  /// Color submenu for a sidebar project: Automatic (hashed), Randomise (any hue), or a 5 x 8 grid of `ProjectColor.palette`.
  func colorItems(project: String) -> [MenuItem] {
    let current = ProjectHues.all()[project]
    let swatch = { (c: OKLCH) in AnyView(Circle().fill(Color(c)).frame(width: 10, height: 10)) }
    return [.action("Automatic", glyph: swatch(ProjectColor.base(project)), checked: current == nil) { ProjectHues.set(project, nil) },
            .action("Randomise", symbol: "dice") { ProjectHues.set(project, OKLCH(l: 0.68, c: 0.13, h: Double(Int.random(in: 0..<360)))) }, .separator]
      + [.grid(columns: 5, ProjectColor.palette.map { c in
          MenuSwatch(color: Color(c), help: "Hue \(Int(c.h))°, lightness \(Int(c.l * 100))%, chroma \(c.c)", checked: current == c) { ProjectHues.set(project, c) }
        })]
  }

  func desktopItems(project: String) -> [MenuItem] {
    desktopChoices(projectDesktop(project)) { self.setDesktop($0, project: project) }
  }

  /// None, then the user's desktops (numbers when the Space probe fails), the current one checked.
  private func desktopChoices(_ current: String?, set: @escaping (String?) -> Void) -> [MenuItem] {
    let mine = desktops.resolve(current)
    let spaces = desktops.spaces.isEmpty
      ? Spaces.range.map { n in MenuItem.action("Desktop \(n)", checked: current == String(n)) { set(String(n)) } }
      : desktops.spaces.map { d in MenuItem.action(d.name, checked: mine?.uuid == d.uuid) { set(d.ref) } }
    return [.action("None", checked: current == nil) { set(nil) }, .separator] + spaces
  }
}

/// The card's identifier; a click copies it (same as Copy ID).
struct CopyIDButton: View {
  @EnvironmentObject var store: BoardStore
  let card: Card
  let font: Font

  var body: some View {
    Button { store.copyID(card) } label: { Text(card.identifier).font(font).foregroundStyle(Palette.muted) }
      .buttonStyle(.pointing).pointerStyle(.link).help("Copy ID (⇧⌘C)")
  }
}

/// Floating confirmation, the only glass on the board.
struct Toast: View {
  let message: String?

  var body: some View {
    if let message {
      Text(message).font(.system(size: 12.5, weight: .medium)).foregroundStyle(Palette.text)
        .padding(.horizontal, 14).padding(.vertical, 8)
        .glassEffect(.regular, in: .capsule)
        .padding(.bottom, 40)
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .allowsHitTesting(false)
        .accessibilityAddTraits(.updatesFrequently)
    }
  }
}

/// Linear's right-hand list of hidden and empty columns; each row is still a drop target.
struct HiddenColumns: View {
  let columns: [Column]
  @AppStorage("kanban.hiddenOpen") private var open = true

  var body: some View {
    if !columns.isEmpty {
      VStack(alignment: .leading, spacing: 8) {
        Button { withAnimation(.spring(duration: 0.25)) { open.toggle() } } label: {
          HStack(spacing: 8) {
            Image(systemName: "triangle.fill").font(.system(size: 7)).rotationEffect(.degrees(open ? 180 : 90))
            Text("Hidden columns").font(.system(size: 13, weight: .medium))
            Text("\(columns.count)").font(.system(size: 13).monospacedDigit())
          }
          .foregroundStyle(Palette.muted).contentShape(Rectangle())
        }
        .buttonStyle(.pointing).padding(.horizontal, 6).padding(.top, 10)
        if open { ForEach(columns) { HiddenColumnRow(column: $0) } }
      }
      .frame(width: 260, alignment: .leading)
    }
  }
}

struct HiddenColumnRow: View {
  @EnvironmentObject var store: BoardStore
  @EnvironmentObject var drag: DragController
  let column: Column
  @State private var hovering = false

  var body: some View {
    HStack(spacing: 10) {
      StatusGlyph(column: column.name, size: 14)
      Text(column.name).font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.text)
      if !column.cards.isEmpty {
        Text("\(column.cards.count)").font(.system(size: 13).monospacedDigit()).foregroundStyle(Palette.muted)
      }
      Spacer()
      if hovering { ColumnMenu(column: column) }
    }
    .padding(.horizontal, 12).frame(height: 40)
    .background(targeted ? accent(for: column.name).opacity(0.10) : Palette.card, in: .rect(cornerRadius: 8))
    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(targeted ? accent(for: column.name).opacity(0.55) : Palette.hairline))
    .onHover { hovering = $0 }
    .rightClickMenu { store.columnItems(column) }
    .help(store.isHidden(column) ? "\(column.name): hidden" : "\(column.name): no issues")
    .dragFrame(column.name, in: \.columns, drag.frames)
  }

  private var targeted: Bool { drag.session != nil && drag.slot?.column == column.name }
}

/// Board card: title with age and org on its first line; project and labels below only when present.
struct IssueCard: View {
  @EnvironmentObject var store: BoardStore
  let card: Card
  @State private var hovering = false
  @AppStorage(Density.key) private var density: Density = .compact

  private var stale: Bool { (card.ageHours ?? 0) >= 24 * 7 }
  private var selected: Bool { store.selected == card.ref }
  private var picked: Bool { store.picked.contains(card.ref) }
  /// The one card `trackActive` credits time to (`BoardStore.activeID`).
  private var live: Bool { store.activeID == card.id }
  @AppStorage(ProjectHues.key) private var hues = ""
  /// The active card's highlight: its project's colour, Doing's when it has no project.
  private var tint: Color { card.projects.first.map { Color(ProjectHues.pair($0, hues).light) } ?? accent(for: "Doing") }

  var body: some View {
    VStack(alignment: .leading, spacing: density.cardInner) {
      HStack(spacing: 6) {
        CopyIDButton(card: card, font: .system(size: density.metaSize))
        Spacer()
        // The checkbox sits over the org icon on hover; the icon dims behind it and stays in place.
        Button { store.togglePick(card.ref) } label: {
          ZStack {
            Group {
              if let org = card.orgs.first {
                OrgIcon(name: org, size: 18).clipShape(.circle)
              } else {
                Circle().strokeBorder(Palette.muted, style: StrokeStyle(lineWidth: 1, dash: [2, 2]))
              }
            }
            .opacity(picked || hovering ? 0.3 : 1)
            if picked {
              Image(systemName: "checkmark.circle.fill").resizable().foregroundStyle(.white, Palette.indigo)
            } else if hovering {
              Image(systemName: "circle").resizable().foregroundStyle(Palette.secondary)
            }
          }
          .frame(width: 18, height: 18).contentShape(Circle())
        }
        .buttonStyle(.pointing).help(picked ? "Deselect" : "Select")
      }
      HStack(alignment: .firstTextBaseline, spacing: 7) {
        StatusGlyph(column: card.col, size: 13).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 }
        Text(card.title.isEmpty ? AttributedString("(untitled)") : renderTitle(card.title))
          .font(.system(size: density.titleSize, weight: .semibold))
          .foregroundStyle(Palette.text).tint(Palette.link)
          .lineLimit(4).lineSpacing(1.5).frame(maxWidth: .infinity, alignment: .leading)
      }
      FlowLayout(spacing: 6) {
        if card.col.caseInsensitiveCompare("Doing") != .orderedSame {
          Pill(text: card.age, color: stale ? Palette.amber : Palette.secondary) { Image(systemName: "clock").imageScale(.small) }
        }
        TimePills(card: card, live: live, tint: tint)
        if let est = card.est {
          Button { store.estimating = card } label: { Pill(text: Age.label(minutes: est)) { Image(systemName: "hourglass").imageScale(.small) } }
            .buttonStyle(.pointing).pointerStyle(.link).help("Edit time estimate")
        }
        if let d = store.desktop(card) {
        Button { store.switchDesktop(ref: d) } label: { Pill(text: store.desktops.name(d)) { Image(systemName: "rectangle.3.group").imageScale(.small) } }
          .buttonStyle(.pointing).pointerStyle(.link).help("Switch to \(store.desktops.name(d))")
      }
        if let project = card.projects.first {
        Button { store.append("project:" + store.quote(project)) } label: { Pill(text: project) { Monogram(name: project, size: 13) } }
          .buttonStyle(.pointing).pointerStyle(.link).help("Filter by \(project)")
      }
        ForEach(card.tags.prefix(3), id: \.self) { tag in
          Button { store.append("tag:" + tag.dropFirst()) } label: { Pill(text: String(tag.dropFirst())) { labelDot(tag) } }
            .buttonStyle(.pointing).pointerStyle(.link)
        }
      }
      .padding(.top, 2)
    }
    .padding(.horizontal, density.cardPadH).padding(.vertical, density.cardPadV)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(picked ? Palette.indigo.opacity(0.14) : (hovering || selected ? Palette.cardHover : Palette.card), in: .rect(cornerRadius: 9))
    .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(selected || picked ? Palette.indigo
      : live ? tint.opacity(0.85) : (hovering ? Palette.hairlineStrong : Palette.hairline), lineWidth: live ? 1.5 : 1))
    .shadow(color: live ? tint.opacity(0.3) : .clear, radius: 8)
    .animation(.easeOut(duration: 0.12), value: hovering)
    .onHover { hovering = $0 }
    .onTapGesture {
      if NSEvent.modifierFlags.contains(.command) { store.togglePick(card.ref) } else { store.select(card.ref) }
    }
    .simultaneousGesture(TapGesture(count: 2).onEnded { store.open(card) })
    .help("Double-click to open in Obsidian")
    .pointerStyle(.link)
    .rightClickMenu { store.cardItems(card) }
    // Inserted cards appear in place: on drop the ghost they replace is already there.
    .transition(.asymmetric(insertion: .identity, removal: .opacity))
  }
}

/// Dashed slot where dragged cards will land: the grabbed card's size, registered so the
/// floating card can settle onto it.
struct GhostCard: View {
  @EnvironmentObject var drag: DragController
  let column: String

  var body: some View {
    let count = drag.session?.refs.count ?? 1
    RoundedRectangle(cornerRadius: 9)
      .strokeBorder(Palette.indigo.opacity(0.7), style: StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
      .background(Palette.indigo.opacity(0.06), in: .rect(cornerRadius: 9))
      .overlay { if count > 1 { Text("\(count) issues").font(.system(size: 12)).foregroundStyle(Palette.secondary) } }
      .frame(height: drag.session?.size.height ?? 78)
      .dragFrame(column, in: \.ghosts, drag.frames)
      .transition(.opacity)
  }
}

/// Dense list: status group bars, then one 36 pt line per issue.
struct ListMode: View {
  @EnvironmentObject var store: BoardStore
  @EnvironmentObject var drag: DragController

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(spacing: 0) {
          ForEach(store.visible.filter { !$0.cards.isEmpty && !store.isHidden($0) }) { column in
            VStack(spacing: 0) {
            HStack(spacing: 8) {
              StatusGlyph(column: column.name, size: 14)
              Text(column.name).font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.text)
              Text("\(column.cards.count)").font(.system(size: 13).monospacedDigit()).foregroundStyle(Palette.muted)
              Spacer()
            }
            .padding(.horizontal, 16).frame(height: 36)
            .background(Color.white.opacity(0.03))
            ForEach(drag.rows(column, store)) { row in
              if let card = row.card { IssueRow(card: card).dragFrame(card.id, in: \.cards, drag.frames) } else { GhostCard(column: column.name) }
            }
            }
            .dragFrame(column.name, in: \.columns, drag.frames)
          }
        }
      }
      .scrollIndicators(.never)
      .onChange(of: store.selected) { if let id = store.selectedCard?.id { withAnimation { proxy.scrollTo(id) } } }
    }
  }
}

/// Done cards by day, newest first: what got finished, not what is pending.
struct LogbookMode: View {
  @EnvironmentObject var store: BoardStore

  var body: some View {
    let days = Logbook.days(store.visible.flatMap(\.cards))
    ScrollView {
      LazyVStack(spacing: 0) {
        if days.isEmpty {
          Text("Nothing done in the last 14 days").font(.system(size: 13)).foregroundStyle(Palette.muted).padding(.top, 80)
        }
        ForEach(days, id: \.day) { day in
          HStack(spacing: 8) {
            Text(title(day.day)).font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.text)
            Text("\(day.cards.count)").font(.system(size: 13).monospacedDigit()).foregroundStyle(Palette.muted)
            Spacer()
            Text(tally(day.cards)).font(.system(size: 12)).foregroundStyle(Palette.muted).lineLimit(1)
          }
          .padding(.horizontal, 16).frame(height: 36)
          .background(Color.white.opacity(0.03))
          ForEach(day.cards) { card in
            HStack(spacing: 0) {
              Text(card.doneAt!.formatted(date: .omitted, time: .shortened))
                .font(.system(size: 12).monospacedDigit()).foregroundStyle(Palette.muted)
                .frame(width: 64, alignment: .trailing)
              IssueRow(card: card)
              Text(card.est.map { guess(card, $0) } ?? "")
                .font(.system(size: 12).monospacedDigit())
                .foregroundStyle((card.took ?? 0) > (card.est ?? .max) ? Palette.amber : Palette.muted)
                .frame(width: 150, alignment: .trailing).padding(.trailing, 16)
            }
          }
        }
      }
    }
    .scrollIndicators(.never)
  }

  /// "est 1h · took 1h 20m".
  private func guess(_ card: Card, _ est: Int) -> String {
    "est \(Age.label(minutes: est))" + (card.took.map { " · took \(Age.label(minutes: $0))" } ?? "")
  }

  private func title(_ day: Date) -> String {
    if Calendar.current.isDateInToday(day) { return "Today" }
    if Calendar.current.isDateInYesterday(day) { return "Yesterday" }
    return day.formatted(.dateTime.weekday(.wide).day().month(.wide))
  }

  /// "Kanban App 5, Vyasa 2": per-project counts, largest first.
  private func tally(_ cards: [Card]) -> String {
    let counts = Dictionary(grouping: cards) { $0.projects.first ?? "No project" }.mapValues(\.count)
    return counts.sorted { ($1.value, $0.key) < ($0.value, $1.key) }.map { "\($0.key) \($0.value)" }.joined(separator: ", ")
  }
}

struct IssueRow: View {
  @EnvironmentObject var store: BoardStore
  let card: Card
  @State private var hovering = false
  @AppStorage(Density.key) private var density: Density = .compact

  private var stale: Bool { (card.ageHours ?? 0) >= 24 * 7 }
  private var selected: Bool { store.selected == card.ref }

  var body: some View {
    HStack(spacing: 10) {
      StatusGlyph(column: card.col, size: 13)
      // Widest possible id sizes the column, so ids never wrap and titles stay aligned.
      Text("XXX-000000-0000.00").font(.system(size: 12, design: .monospaced)).hidden()
        .overlay(alignment: .leading) { CopyIDButton(card: card, font: .system(size: 12, design: .monospaced)).lineLimit(1).fixedSize() }
      Text(card.title.isEmpty ? AttributedString("(untitled)") : renderTitle(card.title))
        .font(.system(size: 13.5, weight: .medium)).foregroundStyle(Palette.text).tint(Palette.link).lineLimit(1)
      Spacer(minLength: 12)
      if let d = store.desktop(card) {
        Button { store.switchDesktop(ref: d) } label: { Pill(text: store.desktops.name(d)) { Image(systemName: "rectangle.3.group").imageScale(.small) } }
          .buttonStyle(.pointing).pointerStyle(.link).help("Switch to \(store.desktops.name(d))")
      }
      ForEach(card.tags.prefix(2), id: \.self) { tag in Pill(text: String(tag.dropFirst())) { labelDot(tag) } }
      if let project = card.projects.first {
        Button { store.append("project:" + store.quote(project)) } label: { Pill(text: project) { Monogram(name: project, size: 13) } }
          .buttonStyle(.pointing).pointerStyle(.link).help("Filter by \(project)")
      }
      if store.activeOrgs.count != 1, let org = card.orgs.first { OrgIcon(name: org, size: 18).clipShape(.circle) }
      Text(card.age).font(.system(size: 12).monospacedDigit())
        .foregroundStyle(stale ? Palette.amber : Palette.muted).frame(width: 36, alignment: .trailing)
    }
    .padding(.horizontal, 16).frame(height: density.rowHeight)
    .background(selected ? Palette.selected : (hovering ? Palette.hover : .clear))
    .overlay(alignment: .bottom) { Rectangle().fill(Color.white.opacity(0.04)).frame(height: 1) }
    .contentShape(Rectangle())
    .onHover { hovering = $0 }

    .onTapGesture {
      if NSEvent.modifierFlags.contains(.command) { store.togglePick(card.ref) } else { store.select(card.ref) }
    }
    .simultaneousGesture(TapGesture(count: 2).onEnded { store.open(card) })
    .help("Double-click to open in Obsidian")
    .pointerStyle(.link)
    .rightClickMenu { store.cardItems(card) }
  }
}

struct StatusLine: View {
  @EnvironmentObject var store: BoardStore

  var body: some View {
    Group {
      if let error = store.error {
        Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.yellow)
      } else if !store.loaded {
        ProgressView().controlSize(.small)
      } else {
        Text("\(store.shown) of \(store.total) issues").monospacedDigit().foregroundStyle(Palette.muted.opacity(0.75))
      }
    }
    .font(.system(size: 11)).frame(height: 28)
  }
}

extension Array {
  subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}

