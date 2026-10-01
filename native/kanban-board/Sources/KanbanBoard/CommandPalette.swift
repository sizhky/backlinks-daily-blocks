import KanbanCore
import SwiftUI

struct Command: Identifiable {
  let id = UUID()
  let title: String
  let icon: String
  let run: () -> Void
}

extension BoardStore {
  func commands() -> [Command] {
    var out: [Command] = []
    if let card = selectedCard {
      out.append(Command(title: "Open “\(card.title.prefix(40))” in Obsidian", icon: "arrow.up.forward.app") { self.open(card) })
      for c in columns where c.name != card.col {
        out.append(Command(title: "Move to \(c.name)", icon: "arrow.right") { self.move(ref: card.ref, to: c.name) })
      }
    }
    out.append(Command(title: "Clear filter", icon: "xmark.circle") { self.query = "" })
    out.append(Command(title: "New view…", icon: "plus") { self.newView(query: self.query) })
    for v in visibleViews { out.append(Command(title: "View: \(v.name)", icon: "line.3.horizontal.decrease") { self.apply(v) }) }
    out.append(Command(title: "Show all organizations", icon: "square.grid.2x2") { self.org = nil })
    for o in orgs { out.append(Command(title: "Switch to \(o.name)", icon: "building.2") { self.org = o.name }) }
    for p in facets(\.projects) { out.append(Command(title: "Project: \(p.name)", icon: "folder") { self.append("project:" + self.quote(p.name)) }) }
    out.append(Command(title: mode == .board ? "Switch to list view" : "Switch to board view", icon: "rectangle.3.group") {
      self.mode = self.mode == .board ? .list : .board
    })
    out.append(Command(title: "Toggle grouping by project", icon: "rectangle.grid.1x2") { self.grouped.toggle() })
    out.append(Command(title: "Toggle sidebar", icon: "sidebar.left") { self.showSidebar.toggle() })
    out.append(Command(title: "Toggle inspector", icon: "sidebar.right") { self.inspectorOpen.toggle() })
    out.append(Command(title: "Refresh", icon: "arrow.clockwise") { Task { await self.refresh() } })
    return out
  }
}

/// ⌘K: type to filter every action; ↑↓ choose, ↵ run, esc close.
struct CommandPalette: View {
  @EnvironmentObject var store: BoardStore
  @State private var text = ""
  @State private var index = 0
  @FocusState private var focused: Bool

  private var results: [Command] {
    let words = text.lowercased().split(separator: " ")
    return store.commands().filter { c in words.allSatisfy { c.title.lowercased().contains($0) } }
  }

  var body: some View {
    let shown = Array(results.prefix(9))
    ZStack(alignment: .top) {
      Color.black.opacity(0.4).ignoresSafeArea().onTapGesture { store.paletteOpen = false }
      VStack(spacing: 0) {
        HStack(spacing: 10) {
          Image(systemName: "command").foregroundStyle(Palette.muted)
          TextField("Type a command", text: $text).textFieldStyle(.plain).font(.system(size: 15))
            .focused($focused)
            .onSubmit { run(shown) }
            .onKeyPress(.downArrow) { index = min(shown.count - 1, index + 1); return .handled }
            .onKeyPress(.upArrow) { index = max(0, index - 1); return .handled }
            .onKeyPress(.escape) { store.paletteOpen = false; return .handled }
            .onChange(of: text) { index = 0 }
        }
        .padding(.horizontal, 18).padding(.vertical, 14)
        if !shown.isEmpty {
          Divider().overlay(Palette.hairline)
          VStack(spacing: 2) {
            ForEach(Array(shown.enumerated()), id: \.element.id) { i, c in
              HStack(spacing: 12) {
                Image(systemName: c.icon).frame(width: 18).foregroundStyle(Palette.muted)
                Text(c.title).lineLimit(1)
                Spacer()
              }
              .font(.system(size: 13)).padding(.horizontal, 12).padding(.vertical, 8)
              .background(i == index ? Palette.selected : .clear, in: .rect(cornerRadius: 10))
              .contentShape(Rectangle())
              .onTapGesture { index = i; run(shown) }
            }
          }
          .padding(8)
        }
      }
      .frame(width: 560)
      .glassEffect(.regular, in: .rect(cornerRadius: 22))
      .padding(.top, 110)
    }
    .onAppear { focused = true }
  }

  private func run(_ shown: [Command]) {
    guard shown.indices.contains(index) else { return }
    store.paletteOpen = false
    shown[index].run()
  }
}
