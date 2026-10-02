import KanbanCore
import SwiftUI

/// Issue peek: identifier, title, property rows, and the task note.
struct Inspector: View {
  @EnvironmentObject var store: BoardStore
  let card: Card

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 8) {
        Text(card.identifier).font(.system(size: 12, design: .monospaced)).foregroundStyle(Palette.muted)
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
              Menu {
                ForEach(store.columns) { c in
                  Button { store.move(ref: card.ref, to: c.name) } label: { Label(c.name, systemImage: "circle") }
                }
              } label: { HStack(spacing: 7) { StatusGlyph(column: card.col); Text(card.col) } }
                .menuStyle(.borderlessButton).fixedSize()
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
              Menu {
                Button("None") { store.setSpace(nil, for: card) }
                ForEach(Array(Spaces.range), id: \.self) { n in Button("Desktop \(n)") { store.setSpace(n, for: card) } }
              } label: { Text(store.spaces[card.id].map { "Desktop \($0)" } ?? "None") }
                .menuStyle(.borderlessButton).fixedSize()
            }
            prop("In status") { Text(card.age).monospacedDigit() }
            prop("Note") { Text(card.ref).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Palette.muted).lineLimit(1).truncationMode(.middle) }
          }
          Divider().overlay(Palette.hairline)
          let note = store.notes[card.ref] ?? ""
          Text(note.isEmpty ? AttributedString("No description") : renderTitle(note))
            .font(.system(size: 13.5)).lineSpacing(4).tint(Palette.link)
            .foregroundStyle(note.isEmpty ? Palette.muted : Palette.secondary)
            .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
        }
        .padding(20)
      }
      .scrollIndicators(.never)
    }
    .frame(width: 380)
    .background(Palette.base)
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
