import KanbanCore
import SwiftUI

struct BoardView: View {
  @EnvironmentObject var store: BoardStore

  var body: some View {
    ZStack {
      VStack(spacing: 14) {
        QueryBar()
        GeometryReader { geo in
          ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: 12) {
              ForEach(store.visible) { ColumnView(column: $0) }
            }
            .frame(height: geo.size.height)
            .padding(.horizontal, 20)
          }
          .scrollIndicators(.never)
        }
        StatusLine()
      }
      .padding(.top, 14)
    }
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
        Text("\(store.shown) of \(store.total)").monospacedDigit().foregroundStyle(Palette.muted)
      }
    }
    .font(.system(size: 11))
    .padding(.bottom, 10)
  }
}

struct QueryBar: View {
  @EnvironmentObject var store: BoardStore
  @FocusState private var focused: Bool
  @State private var naming = false
  @State private var name = ""
  private let keys = ["col:", "tag:", "project:", "org:", "stale:", "age:", "no:", "has:"]

  var body: some View {
    VStack(spacing: 9) {
      HStack(spacing: 10) {
        Image(systemName: "line.3.horizontal.decrease").foregroundStyle(Palette.muted)
        TextField("Filter  col:Doing  tag:#win  project:\"…\"  stale:7d  -col:done", text: $store.query)
          .textFieldStyle(.plain)
          .font(.system(size: 13))
          .focused($focused)
        if !store.query.isEmpty {
          Button { naming = true } label: { Image(systemName: "star") }
            .help("Save this filter")
          Button { store.query = "" } label: { Image(systemName: "xmark.circle.fill") }
        }
      }
      .buttonStyle(.plain).foregroundStyle(Palette.muted)
      .padding(.horizontal, 16).padding(.vertical, 10)
      .glassEffect(.regular.interactive(), in: .capsule)
      .frame(maxWidth: 640)
      .overlay(alignment: .trailing) {
        Button { store.grouped.toggle() } label: {
          Image(systemName: store.grouped ? "rectangle.grid.1x2.fill" : "rectangle.grid.1x2")
        }
        .buttonStyle(.glass).buttonBorderShape(.circle)
        .help("Group by project")
        .offset(x: 48)
      }

      HStack(spacing: 14) {
        ForEach(keys, id: \.self) { key in
          Button(key) { store.append(key); focused = true }
            .buttonStyle(.plain)
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(Palette.muted)
        }
      }
    }
    .background(Button("") { focused = true }.keyboardShortcut("f", modifiers: .command).opacity(0))
    .alert("Save filter", isPresented: $naming) {
      TextField("Name", text: $name)
      Button("Save") { store.save(name: name); name = "" }
      Button("Cancel", role: .cancel) { name = "" }
    } message: { Text(store.query) }
  }
}

struct ColumnView: View {
  @EnvironmentObject var store: BoardStore
  let column: Column
  @State private var targeted = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 7) {
        Circle().fill(accent(for: column.name)).frame(width: 7, height: 7)
        Text(column.name).font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.text)
        Spacer()
        Text("\(column.cards.count)").font(.system(size: 12).monospacedDigit()).foregroundStyle(Palette.muted)
      }
      .padding(.horizontal, 14).padding(.vertical, 11)
      Divider().overlay(Palette.hairline)
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          if column.cards.isEmpty {
            Text("No cards").font(.system(size: 11)).foregroundStyle(Palette.muted.opacity(0.6))
              .frame(maxWidth: .infinity).padding(.top, 24)
          } else if store.grouped {
            ForEach(Grouping.byProject(column.cards)) { group in
              GroupHeader(group: group)
              ForEach(group.cards) { RowView(card: $0, last: $0.id == group.cards.last?.id) }
            }
          } else {
            ForEach(column.cards) { RowView(card: $0, last: $0.id == column.cards.last?.id) }
          }
        }
      }
      .scrollIndicators(.never)
    }
    .frame(width: 300)
    .background(targeted ? accent(for: column.name).opacity(0.08) : Palette.column)
    .clipShape(.rect(cornerRadius: 16))
    .overlay(RoundedRectangle(cornerRadius: 16)
      .strokeBorder(targeted ? accent(for: column.name).opacity(0.6) : Palette.hairline))
    .dropDestination(for: String.self) { refs, _ in
      refs.forEach { store.move(ref: $0, to: column.name) }
      return !refs.isEmpty
    } isTargeted: { targeted = $0 }
  }
}

struct GroupHeader: View {
  let group: CardGroup

  var body: some View {
    HStack(spacing: 8) {
      Monogram(name: group.name, size: 16)
      Text(group.name ?? "No project").font(.system(size: 11.5, weight: .semibold)).lineLimit(1)
      Spacer()
      Text("\(group.cards.count)").font(.system(size: 11).monospacedDigit())
    }
    .foregroundStyle(Palette.muted)
    .padding(.horizontal, 14).padding(.top, 14).padding(.bottom, 6)
  }
}

/// One line per card, hairline below; title and age share the left and right edges.
struct RowView: View {
  @EnvironmentObject var store: BoardStore
  let card: Card
  let last: Bool
  @State private var hovering = false

  private var stale: Bool { (card.ageHours ?? 0) >= 24 * 7 }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: 5) {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          Text(card.title.isEmpty ? "(untitled)" : card.title)
            .font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.text)
            .lineLimit(3).lineSpacing(1.5)
          Spacer(minLength: 0)
          HStack(spacing: 3) {
            if stale { Image(systemName: "clock") }
            Text(card.age).monospacedDigit()
          }
          .font(.system(size: 11))
          .foregroundStyle(stale ? Palette.amber : Palette.muted)
        }
        if !card.tags.isEmpty {
          HStack(spacing: 8) {
            ForEach(card.tags.prefix(3), id: \.self) { tag in
              Button(tag) { store.append("tag:" + tag.dropFirst()) }.buttonStyle(.plain)
            }
          }
          .font(.system(size: 11)).foregroundStyle(Palette.muted)
        }
      }
      .padding(.horizontal, 14).padding(.vertical, 10)
      if !last { Rectangle().fill(Palette.hairline).frame(height: 1).padding(.leading, 14) }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(hovering ? Color.white.opacity(0.045) : .clear)
    .contentShape(Rectangle())
    .onHover { hovering = $0 }
    .draggable(card.ref)
    .onTapGesture(count: 2) { store.open(card) }
    .contextMenu {
      Button("Open in Obsidian") { store.open(card) }
      Menu("Move to") {
        ForEach(store.columns) { c in Button(c.name) { store.move(ref: card.ref, to: c.name) } }
      }
    }
  }
}
