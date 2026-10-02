import KanbanCore
import SwiftUI

/// Main panel: an inset rounded sheet holding header, board or list, and the issue peek.
struct BoardView: View {
  @EnvironmentObject var store: BoardStore
  @EnvironmentObject var drag: DragController
  @FocusState private var boardFocus: Bool

  var body: some View {
    HStack(spacing: 0) {
      VStack(spacing: 0) {
        BoardHeader()
        Group { if store.mode == .board { ColumnsScroller() } else { ListMode() } }
          .simultaneousGesture(DragGesture(minimumDistance: 4, coordinateSpace: .named(DragController.space))
            .onChanged { drag.changed($0) }
            .onEnded { _ in drag.ended() })
        StatusLine()
      }
      if store.inspectorOpen, let card = store.selectedCard {
        Rectangle().fill(Palette.hairline).frame(width: 1)
        Inspector(card: card).transition(.move(edge: .trailing).combined(with: .opacity))
      }
    }
    .overlay(alignment: .topLeading) { FloatingCard(pointer: drag.pointer) }
    .coordinateSpace(.named(DragController.space))
    .background(Palette.base)
    .clipShape(.rect(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Palette.hairline))
    .padding(.top, 8).padding(.trailing, 8).padding(.bottom, 8)
    .animation(.spring(duration: 0.32, bounce: 0.08), value: store.selected != nil && store.inspectorOpen)
    .focusable().focused($boardFocus).focusEffectDisabled()
    .onChange(of: store.selected) { boardFocus = true }
    .onKeyPress(.upArrow) { store.moveSelection(dx: 0, dy: -1); return .handled }
    .onKeyPress(.downArrow) { store.moveSelection(dx: 0, dy: 1); return .handled }
    .onKeyPress(.leftArrow) { store.moveSelection(dx: -1, dy: 0); return .handled }
    .onKeyPress(.rightArrow) { store.moveSelection(dx: 1, dy: 0); return .handled }
    .onKeyPress(characters: ["j"]) { _ in store.moveSelection(dx: 0, dy: 1); return .handled }
    .onKeyPress(characters: ["k"]) { _ in store.moveSelection(dx: 0, dy: -1); return .handled }
    .onKeyPress(characters: ["/"]) { _ in store.focusFilter += 1; return .handled }
    .onKeyPress(.return) { store.openSelected(); return .handled }
    .onKeyPress(.space) { store.inspectorOpen.toggle(); return .handled }
    .onKeyPress(.escape) { store.select(nil); return .handled }
  }
}

struct BoardHeader: View {
  @EnvironmentObject var store: BoardStore
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
        }
        IconButton(icon: "sidebar.right", help: "Inspector (space)", active: store.inspectorOpen) { store.inspectorOpen.toggle() }
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
        .buttonStyle(.plain)
        Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(Palette.muted)
      }
      Text(viewName).foregroundStyle(Palette.text)
      Text("\(store.shown)").font(.system(size: 12).monospacedDigit()).foregroundStyle(Palette.muted)
      Button { pickingOrgs.toggle() } label: {
        Image(systemName: "building.2").font(.system(size: 11)).foregroundStyle(Palette.muted)
      }
      .buttonStyle(.plain).help("Choose workspaces")
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
        .onTapGesture { complete(s); focused = true }
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
        Button("Save view") { store.newView(query: store.query) }.buttonStyle(.plain).foregroundStyle(Palette.muted).frame(height: 24)
        Button("Clear") { store.query = "" }.buttonStyle(.plain).foregroundStyle(Palette.muted).frame(height: 24)
      }
      if focused {
        ForEach(keys, id: \.self) { key in
          Button(key) { store.append(key); focused = true }
            .buttonStyle(.plain).font(.system(size: 11, design: .monospaced)).foregroundStyle(Palette.muted.opacity(0.8)).frame(height: 24)
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
        .buttonStyle(.plain).foregroundStyle(Palette.muted)
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
          ForEach(store.visible.filter { !store.isHidden($0) && !$0.cards.isEmpty }) { ColumnView(column: $0) }
          HiddenColumns(columns: store.visible.filter { store.isHidden($0) || $0.cards.isEmpty })
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

  var body: some View {
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
          VStack(alignment: .leading, spacing: density.cardGap) {
            ForEach(drag.rows(column, store)) { row in
              if let card = row.card {
                IssueCard(card: card).dragFrame(card.id, in: \.cards, drag.frames)
              } else {
                GhostCard()
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
    .padding(4)
    .frame(width: density.columnWidth)
    .background(targeted ? accent(for: column.name).opacity(0.08) : Color.white.opacity(0.02), in: .rect(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(targeted ? accent(for: column.name).opacity(0.55) : .clear))
    .dragFrame(column.name, in: \.columns, drag.frames)
  }

  /// Highlight only a column the drag is entering from elsewhere.
  private var targeted: Bool { drag.slot?.column == column.name && drag.session?.home != column.name }
}

/// Column header options: hide, move left or right, and the plugin's sweep routes.
struct ColumnMenu: View {
  @EnvironmentObject var store: BoardStore
  let column: Column

  var body: some View {
    let names = store.visible.map(\.name)
    Menu {
      Button(store.isHidden(column) ? "Show column" : "Hide column") { store.setHidden(column, !store.isHidden(column)) }
      Button("Select all in column") { store.pickAll(in: column) }.disabled(column.cards.isEmpty)
      Divider()
      Button("Move left") { store.shiftColumn(column, by: -1) }.disabled(names.first == column.name)
      Button("Move right") { store.shiftColumn(column, by: 1) }.disabled(names.last == column.name)
      if !column.sweeps.isEmpty {
        Divider()
        ForEach(column.sweeps, id: \.self) { target in
          Button("Move \(column.cards.count) shown to \(target)") { store.sweep(column, to: target) }
            .disabled(column.cards.isEmpty)
        }
      }
    } label: {
      Image(systemName: "ellipsis").font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.muted)
        .frame(width: 22, height: 22).contentShape(Rectangle())
    }
    .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
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
        .buttonStyle(.plain).padding(.horizontal, 6).padding(.top, 10)
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
    .contextMenu { if store.isHidden(column) { Button("Show column") { store.setHidden(column, false) } } }
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

  var body: some View {
    VStack(alignment: .leading, spacing: density.cardInner) {
      HStack(spacing: 6) {
        Text(card.identifier).font(.system(size: density.metaSize)).foregroundStyle(Palette.muted)
        Spacer()
        // The org icon is the selection toggle; picked shows a check in its place.
        Button { store.togglePick(card.ref) } label: {
          ZStack {
            if picked {
              Image(systemName: "checkmark.circle.fill").resizable().foregroundStyle(.white, Palette.indigo)
            } else if hovering {
              Image(systemName: "circle").resizable().foregroundStyle(Palette.secondary)
            } else if let org = card.orgs.first {
              OrgIcon(name: org, size: 18).clipShape(.circle)
            } else {
              Circle().strokeBorder(Palette.muted, style: StrokeStyle(lineWidth: 1, dash: [2, 2]))
            }
          }
          .frame(width: 18, height: 18).contentShape(Circle())
        }
        .buttonStyle(.plain).help(picked ? "Deselect" : "Select")
      }
      HStack(alignment: .firstTextBaseline, spacing: 7) {
        StatusGlyph(column: card.col, size: 13).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 }
        Text(card.title.isEmpty ? AttributedString("(untitled)") : renderTitle(card.title))
          .font(.system(size: density.titleSize, weight: .semibold))
          .foregroundStyle(Palette.text).tint(Palette.link)
          .lineLimit(4).lineSpacing(1.5).frame(maxWidth: .infinity, alignment: .leading)
      }
      FlowLayout(spacing: 6) {
        Pill(text: card.age, color: stale ? Palette.amber : Palette.secondary) { Image(systemName: "clock").imageScale(.small) }
        if let n = card.desktop { Pill(text: "Desktop \(n)") { Image(systemName: "rectangle.3.group").imageScale(.small) }.help("Desktop \(n)") }
        if let project = card.projects.first { Pill(text: project) { Monogram(name: project, size: 13) } }
        ForEach(card.tags.prefix(3), id: \.self) { tag in
          Button { store.append("tag:" + tag.dropFirst()) } label: { Pill(text: String(tag.dropFirst())) { labelDot(tag) } }
            .buttonStyle(.plain)
        }
      }
      .padding(.top, 2)
    }
    .padding(.horizontal, density.cardPadH).padding(.vertical, density.cardPadV)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(picked ? Palette.indigo.opacity(0.14) : (hovering || selected ? Palette.cardHover : Palette.card), in: .rect(cornerRadius: 9))
    .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(selected || picked ? Palette.indigo : (hovering ? Palette.hairlineStrong : Palette.hairline)))
    .animation(.easeOut(duration: 0.12), value: hovering)
    .onHover { hovering = $0 }
    // A single tap selects at once; a count-2 onTapGesture would delay it by the double-click interval.
    .onTapGesture {
      if NSEvent.modifierFlags.contains(.command) { store.togglePick(card.ref) } else { store.select(card.ref) }
    }
    .simultaneousGesture(TapGesture(count: 2).onEnded { store.activate(card) })
    .contextMenu { CardMenu(card: card) }
    // Inserted cards appear in place: on drop the ghost they replace is already there.
    .transition(.asymmetric(insertion: .identity, removal: .opacity))
  }
}

struct CardMenu: View {
  @EnvironmentObject var store: BoardStore
  let card: Card

  var body: some View {
    Button("Open in Obsidian") { store.open(card) }
    Menu("Move to") {
      ForEach(store.columns) { c in Button(c.name) { store.move(ref: card.ref, to: c.name) } }
    }
  }
}

/// Dashed slot where dragged cards will land: the grabbed card's size, registered so the
/// floating card can settle onto it.
struct GhostCard: View {
  @EnvironmentObject var drag: DragController

  var body: some View {
    let count = drag.session?.refs.count ?? 1
    RoundedRectangle(cornerRadius: 9)
      .strokeBorder(Palette.indigo.opacity(0.7), style: StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
      .background(Palette.indigo.opacity(0.06), in: .rect(cornerRadius: 9))
      .overlay { if count > 1 { Text("\(count) issues").font(.system(size: 12)).foregroundStyle(Palette.secondary) } }
      .frame(height: drag.session?.size.height ?? 78)
      .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(DragController.space)) } action: { drag.frames.ghost = $0 }
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
              if let card = row.card { IssueRow(card: card).dragFrame(card.id, in: \.cards, drag.frames) } else { GhostCard() }
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
      Text(card.identifier).font(.system(size: 12, design: .monospaced)).foregroundStyle(Palette.muted)
        .frame(width: 84, alignment: .leading)
      Text(card.title.isEmpty ? AttributedString("(untitled)") : renderTitle(card.title))
        .font(.system(size: 13.5, weight: .medium)).foregroundStyle(Palette.text).tint(Palette.link).lineLimit(1)
      Spacer(minLength: 12)
      if let n = card.desktop { Pill(text: "Desktop \(n)") { Image(systemName: "rectangle.3.group").imageScale(.small) }.help("Desktop \(n)") }
      ForEach(card.tags.prefix(2), id: \.self) { tag in Pill(text: String(tag.dropFirst())) { labelDot(tag) } }
      if let project = card.projects.first { Pill(text: project) { Monogram(name: project, size: 13) } }
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
    .simultaneousGesture(TapGesture(count: 2).onEnded { store.activate(card) })
    .contextMenu { CardMenu(card: card) }
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

