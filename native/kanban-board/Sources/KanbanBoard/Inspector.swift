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
            prop("In status") { Text(card.age).monospacedDigit() }
            prop("Note") { Text(card.ref).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Palette.muted).lineLimit(1).truncationMode(.middle) }
          }
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
