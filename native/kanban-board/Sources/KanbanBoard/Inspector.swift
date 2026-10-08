import KanbanCore
import SwiftUI

/// Issue peek: identifier, title, property rows, and the task note as editable raw text.
struct Inspector: View {
  @EnvironmentObject var store: BoardStore
  let card: Card
  /// The note as raw text; saved to Obsidian when the editor loses focus or the card changes.
  @State private var draft = ""
  @FocusState private var editing: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 8) {
        CopyIDButton(card: card, font: .system(size: 12, design: .monospaced))
        Spacer()
        IconButton(icon: "arrow.up.forward.app", help: "Open in Obsidian (↵)") { store.open(card) }
        IconButton(icon: "xmark", help: "Close (esc)") { store.select(nil) }
      }
      .padding(.horizontal, 14).frame(height: 46)
      Divider().overlay(Palette.hairline)
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          Text(renderTitle(card.title)).font(.system(size: 19, weight: .semibold)).tracking(-0.2)
            .foregroundStyle(Palette.text).tint(Palette.link)
            .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
          VStack(alignment: .leading, spacing: 2) {
            prop("Status") {
              MenuTrigger(items: { store.statusItems(card) }) { HStack(spacing: 7) { StatusGlyph(column: card.col); Text(card.col) } }
            }
            if let project = card.projects.first {
              prop("Project") { HStack(spacing: 7) { Monogram(name: project, size: 16); Text(project) } }
            }
            if let org = card.orgs.first {
              prop("Org") { HStack(spacing: 7) { OrgIcon(name: org, size: 16).clipShape(.circle); Text(org) } }
            }
            if !card.tags.isEmpty {
              prop("Labels") {
                FlowLayout { ForEach(card.tags, id: \.self) { tag in Pill(text: String(tag.dropFirst())) { labelDot(tag) } } }
              }
            }
            prop("Desktop") {
              MenuTrigger(items: { store.desktopItems(card) }) { Text(card.desktop.map(store.desktops.name) ?? "None") }
            }
            prop("Estimate") {
              Button { store.estimating = card } label: { Text(card.est.map { Age.label(minutes: $0) } ?? "None") }
                .buttonStyle(.pointing).help("Edit time estimate")
            }
            prop("In status") { Text(card.age).monospacedDigit() }
            prop("Note") { Text(card.ref).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Palette.muted).lineLimit(1).truncationMode(.middle) }
          }
          Divider().overlay(Palette.hairline)
          TimeBreakdown(card: card)
          Divider().overlay(Palette.hairline)
          TextEditor(text: $draft)
            .font(.system(size: 13.5)).lineSpacing(4).foregroundStyle(Palette.secondary)
            .scrollContentBackground(.hidden).scrollDisabled(true)
            .focused($editing)
            .frame(maxWidth: .infinity, minHeight: 160, alignment: .topLeading)
            .overlay(alignment: .topLeading) {
              if draft.isEmpty && !editing {
                Text("No description").font(.system(size: 13.5)).foregroundStyle(Palette.muted).padding(.leading, 5).allowsHitTesting(false)
              }
            }
        }
        .padding(20)
      }
      .scrollIndicators(.never)
    }
    .frame(width: 380)
    .background(Palette.base)
    .onAppear { draft = store.notes[card.ref] ?? "" }
    .onChange(of: store.notes[card.ref]) { _, now in if !editing { draft = now ?? "" } }
    .onChange(of: editing) { _, now in if !now { store.setNote(draft, ref: card.ref) } }
    .onChange(of: card.ref) { old, now in
      store.setNote(draft, ref: old)
      draft = store.notes[now] ?? ""
    }
    .onDisappear { store.setNote(draft, ref: card.ref) }
  }

  private func prop<V: View>(_ label: String, @ViewBuilder _ value: () -> V) -> some View {
    HStack(alignment: .center, spacing: 12) {
      Text(label).font(.system(size: 12.5)).foregroundStyle(Palette.muted).frame(width: 74, alignment: .leading)
      value().font(.system(size: 13)).foregroundStyle(Palette.secondary)
      Spacer(minLength: 0)
    }
    .frame(minHeight: 30)
  }
}

/// Time per column as one stacked bar plus rows, and active time; instant hover cards on the bar.
struct TimeBreakdown: View {
  @EnvironmentObject var store: BoardStore
  let card: Card
  @State private var pointer: CGPoint?

  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { ctx in
      let parts = buckets(ctx.date), total = parts.reduce(0) { $0 + $1.seconds }
      VStack(alignment: .leading, spacing: 8) {
        Text("Time").font(.system(size: 12.5)).foregroundStyle(Palette.muted)
        if total > 0 {
          GeometryReader { geo in
            HStack(spacing: 2) {
              ForEach(parts, id: \.name) { p in
                Rectangle().fill(accent(for: p.name)).frame(width: max(2, (geo.size.width - CGFloat(parts.count - 1) * 2) * p.seconds / total))
              }
            }
            .clipShape(.rect(cornerRadius: 4))
            .contentShape(Rectangle())
            .onContinuousHover { phase in if case .active(let p) = phase { pointer = p } else { pointer = nil } }
            .overlay(alignment: .topLeading) {
              if let p = pointer, let hit = hit(p.x, parts, total, geo.size.width) {
                HoverCard(text: "\(hit.name)  \(Age.span(seconds: hit.seconds))  (\(Int((hit.seconds / total * 100).rounded()))%)", at: p, bounds: geo.size)
                  .allowsHitTesting(false)
              }
            }
          }
          .frame(height: 10).zIndex(1)
        }
        ForEach(parts, id: \.name) { p in row(AnyView(StatusGlyph(column: p.name)), p.name, p.seconds) }
        row(AnyView(Image(systemName: store.activeID == card.id ? "bolt.fill" : "bolt").foregroundStyle(accent(for: "Doing"))),
            "Active", store.activeTime(card, at: ctx.date))
      }
    }
  }

  /// Columns in board order with time in them, the current one included.
  private func buckets(_ now: Date) -> [(name: String, seconds: Double)] {
    store.columns.map(\.name).map { ($0, card.seconds(in: $0, at: now)) }.filter { $0.1 > 0 }
  }

  private func hit(_ x: CGFloat, _ parts: [(name: String, seconds: Double)], _ total: Double, _ width: CGFloat) -> (name: String, seconds: Double)? {
    var edge: CGFloat = 0
    for p in parts {
      edge += width * p.seconds / total
      if x <= edge { return p }
    }
    return parts.last
  }

  private func row(_ icon: AnyView, _ name: String, _ seconds: Double) -> some View {
    HStack(spacing: 8) {
      icon.font(.system(size: 12)).frame(width: 16)
      Text(name).foregroundStyle(Palette.secondary)
      Spacer()
      Text(Age.span(seconds: seconds)).monospacedDigit().foregroundStyle(Palette.text)
    }
    .font(.system(size: 13))
  }
}
