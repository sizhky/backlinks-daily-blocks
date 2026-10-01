import KanbanCore
import SwiftUI

/// Main panel: an inset rounded sheet holding header, board or list, and the issue peek.
struct BoardView: View {
  @EnvironmentObject var store: BoardStore
  @FocusState private var boardFocus: Bool

  var body: some View {
    HStack(spacing: 0) {
      VStack(spacing: 0) {
        BoardHeader()
        if store.mode == .board { ColumnsScroller() } else { ListMode() }
        StatusLine()
      }
      if store.inspectorOpen, let card = store.selectedCard {
        Rectangle().fill(Palette.hairline).frame(width: 1)
        Inspector(card: card).transition(.move(edge: .trailing).combined(with: .opacity))
      }
    }
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
        IconButton(icon: "rectangle.grid.1x2", help: "Group by project", active: store.grouped) { store.grouped.toggle() }
        IconButton(icon: "sidebar.right", help: "Inspector (space)", active: store.inspectorOpen) { store.inspectorOpen.toggle() }
        IconButton(icon: "command", help: "Commands (⌘K)") { store.paletteOpen = true }
      }
      .padding(.horizontal, 14).frame(height: 46)
      if focused || !terms.isEmpty { chips }
      Divider().overlay(Palette.hairline)
    }
    .onChange(of: store.focusFilter) { focused = true }
    .background(Button("") { focused = true }.keyboardShortcut("f", modifiers: .command).opacity(0))
  }

  private var breadcrumb: some View {
    HStack(spacing: 7) {
      if let org = store.activeOrg {
        if org == Filter.noOrg {
          Text("No organization").foregroundStyle(Palette.secondary)
        } else {
          OrgIcon(name: org, size: 16).clipShape(.circle)
          Text(org).foregroundStyle(Palette.secondary)
        }
        Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(Palette.muted)
      }
      Text(viewName).foregroundStyle(Palette.text)
      Text("\(store.shown)").font(.system(size: 12).monospacedDigit()).foregroundStyle(Palette.muted)
    }
    .font(.system(size: 13, weight: .medium))
  }

  private var filterField: some View {
    HStack(spacing: 7) {
      Image(systemName: "line.3.horizontal.decrease").font(.system(size: 11)).foregroundStyle(Palette.muted)
      TextField("Filter…  press /", text: $store.query)
        .textFieldStyle(.plain).font(.system(size: 12.5)).focused($focused)
        .onKeyPress(.escape) { focused = false; return .handled }
    }
    .padding(.horizontal, 10).padding(.vertical, 5).frame(width: 280)
    .background(Color.white.opacity(0.04), in: .rect(cornerRadius: 7))
    .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(focused ? Palette.indigo : Palette.hairline))
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
  @State private var position = ScrollPosition()
  @State private var offsetX: CGFloat = 0
  @State private var maxX: CGFloat = 0
  private let timer = Timer.publish(every: 1.0 / 60, on: .main, in: .common).autoconnect()
  private let zone: CGFloat = 150

  var body: some View {
    GeometryReader { geo in
      ScrollView(.horizontal) {
        HStack(alignment: .top, spacing: 10) {
          ForEach(store.visible) { ColumnView(column: $0) }
        }
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
    if next != offsetX { offsetX = next; position.scrollTo(x: next) }
  }
}

struct ColumnView: View {
  @EnvironmentObject var store: BoardStore
  let column: Column
  @State private var targeted = false

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        StatusGlyph(column: column.name, size: 14)
        Text(column.name).font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.text)
        Text("\(column.cards.count)").font(.system(size: 13).monospacedDigit()).foregroundStyle(Palette.muted)
        Spacer()
      }
      .padding(.horizontal, 8).padding(.top, 6)
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 8) {
            if column.cards.isEmpty {
              Text("No issues").font(.system(size: 12)).foregroundStyle(Palette.muted.opacity(0.6))
                .frame(maxWidth: .infinity).padding(.top, 18)
            } else if store.grouped {
              ForEach(Grouping.byProject(column.cards)) { group in
                GroupHeader(group: group)
                ForEach(group.cards) { IssueCard(card: $0) }
              }
            } else {
              ForEach(column.cards) { IssueCard(card: $0) }
            }
          }
          .padding(.horizontal, 4).padding(.bottom, 16)
          .animation(.spring(duration: 0.38, bounce: 0.12), value: column.cards.map(\.id))
        }
        .scrollIndicators(.never)
        .onChange(of: store.selected) {
          if let ref = store.selected, column.cards.contains(where: { $0.ref == ref }) {
            withAnimation { proxy.scrollTo(ref) }
          }
        }
      }
    }
    .padding(4)
    .frame(width: 316)
    .background(targeted ? accent(for: column.name).opacity(0.08) : Color.white.opacity(0.02), in: .rect(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(targeted ? accent(for: column.name).opacity(0.55) : .clear))
    .dropDestination(for: String.self) { refs, _ in
      refs.forEach { store.move(ref: $0, to: column.name) }
      return !refs.isEmpty
    } isTargeted: { targeted = $0 }
  }
}

struct GroupHeader: View {
  let group: CardGroup

  var body: some View {
    HStack(spacing: 7) {
      Monogram(name: group.name, size: 15)
      Text(group.name ?? "No project").font(.system(size: 12, weight: .medium)).lineLimit(1)
      Text("\(group.cards.count)").font(.system(size: 12).monospacedDigit())
      Spacer()
    }
    .foregroundStyle(Palette.muted)
    .padding(.horizontal, 6).padding(.top, 8)
  }
}

/// Board card: id and org avatar on top, title, then property pills.
struct IssueCard: View {
  @EnvironmentObject var store: BoardStore
  let card: Card
  @State private var hovering = false

  private var stale: Bool { (card.ageHours ?? 0) >= 24 * 7 }
  private var selected: Bool { store.selected == card.ref }

  var body: some View {
    VStack(alignment: .leading, spacing: 9) {
      HStack {
        Text(card.identifier).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Palette.muted)
        Spacer()
        if store.activeOrg == nil, let org = card.orgs.first { OrgIcon(name: org, size: 18).clipShape(.circle) }
      }
      Text(card.title.isEmpty ? AttributedString("(untitled)") : renderTitle(card.title))
        .font(.system(size: 13.5, weight: .medium)).tracking(-0.1)
        .foregroundStyle(Palette.text).tint(Palette.link)
        .lineLimit(4).lineSpacing(1.5).frame(maxWidth: .infinity, alignment: .leading)
      FlowLayout(spacing: 5) {
        if !store.grouped, let project = card.projects.first {
          Pill(text: project) { Monogram(name: project, size: 13) }
        }
        ForEach(card.tags.prefix(3), id: \.self) { tag in
          Button { store.append("tag:" + tag.dropFirst()) } label: { Pill(text: String(tag.dropFirst())) { labelDot(tag) } }
            .buttonStyle(.plain)
        }
        Pill(text: card.age, color: stale ? Palette.amber : Palette.muted) {
          Image(systemName: "clock").font(.system(size: 9.5))
        }
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(hovering || selected ? Palette.cardHover : Palette.card, in: .rect(cornerRadius: 9))
    .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(selected ? Palette.indigo : (hovering ? Palette.hairlineStrong : Palette.hairline)))
    .animation(.easeOut(duration: 0.12), value: hovering)
    .onHover { hovering = $0 }
    .draggable(card.ref) { DragPreview(card: card) }
    .onTapGesture(count: 2) { store.open(card) }
    .onTapGesture { store.select(card.ref) }
    .contextMenu { CardMenu(card: card) }
    .transition(.asymmetric(insertion: .scale(scale: 0.96).combined(with: .opacity), removal: .opacity))
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

/// What follows the cursor while dragging: a lifted, slightly tilted card.
struct DragPreview: View {
  let card: Card

  var body: some View {
    Text(renderTitle(card.title)).font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.text)
      .lineLimit(2).padding(.horizontal, 14).padding(.vertical, 10).frame(width: 260, alignment: .leading)
      .background(Palette.cardHover, in: .rect(cornerRadius: 10))
      .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Palette.hairlineStrong))
      .shadow(color: .black.opacity(0.5), radius: 14, y: 8)
      .rotationEffect(.degrees(-2))
  }
}

/// Dense list: status group bars, then one 36 pt line per issue.
struct ListMode: View {
  @EnvironmentObject var store: BoardStore

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(spacing: 0) {
          ForEach(store.visible.filter { !$0.cards.isEmpty }) { column in
            HStack(spacing: 8) {
              StatusGlyph(column: column.name, size: 14)
              Text(column.name).font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.text)
              Text("\(column.cards.count)").font(.system(size: 13).monospacedDigit()).foregroundStyle(Palette.muted)
              Spacer()
            }
            .padding(.horizontal, 16).frame(height: 36)
            .background(Color.white.opacity(0.03))
            ForEach(store.ordered(column)) { IssueRow(card: $0) }
          }
        }
      }
      .scrollIndicators(.never)
      .onChange(of: store.selected) { if let ref = store.selected { withAnimation { proxy.scrollTo(ref) } } }
    }
  }
}

struct IssueRow: View {
  @EnvironmentObject var store: BoardStore
  let card: Card
  @State private var hovering = false

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
      ForEach(card.tags.prefix(2), id: \.self) { tag in Pill(text: String(tag.dropFirst())) { labelDot(tag) } }
      if let project = card.projects.first { Pill(text: project) { Monogram(name: project, size: 13) } }
      if store.activeOrg == nil, let org = card.orgs.first { OrgIcon(name: org, size: 18).clipShape(.circle) }
      Text(card.age).font(.system(size: 12).monospacedDigit())
        .foregroundStyle(stale ? Palette.amber : Palette.muted).frame(width: 36, alignment: .trailing)
    }
    .padding(.horizontal, 16).frame(height: 38)
    .background(selected ? Palette.selected : (hovering ? Palette.hover : .clear))
    .overlay(alignment: .bottom) { Rectangle().fill(Color.white.opacity(0.04)).frame(height: 1) }
    .contentShape(Rectangle())
    .onHover { hovering = $0 }
    .draggable(card.ref) { DragPreview(card: card) }
    .onTapGesture(count: 2) { store.open(card) }
    .onTapGesture { store.select(card.ref) }
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
        Text("\(store.shown) of \(store.total)  ·  / filter  ·  ⌘K commands  ·  ↑↓←→ select  ·  ↵ open  ·  space peek")
          .monospacedDigit().foregroundStyle(Palette.muted.opacity(0.75))
      }
    }
    .font(.system(size: 11)).frame(height: 28)
  }
}
