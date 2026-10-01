import KanbanCore
import SwiftUI

/// Create or edit a saved view: name, query, and the workspace it belongs to.
struct ViewEditor: View {
  @EnvironmentObject var store: BoardStore
  @State var draft: ViewDraft
  @FocusState private var nameFocused: Bool
  private let presets = ["created:today", "created:week", "stale:7d", "-col:done,cancelled", "no:project", "col:Doing"]

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(draft.existing ? "Edit view" : "New view").font(.system(size: 15, weight: .semibold))
      field("Name") {
        TextField("e.g. Created today", text: $draft.name).textFieldStyle(.plain).focused($nameFocused)
      }
      field("Filter") {
        TextField("col:Doing created:today -tag:x", text: $draft.query).textFieldStyle(.plain)
          .font(.system(size: 12.5, design: .monospaced))
      }
      FlowLayout(spacing: 6) {
        ForEach(presets, id: \.self) { preset in
          Button { draft.query = Query.format(Query.parse(draft.query + " " + preset)) } label: {
            Text(preset).font(.system(size: 11, design: .monospaced)).foregroundStyle(Palette.muted)
              .padding(.horizontal, 7).padding(.vertical, 3)
              .overlay(Capsule().strokeBorder(Palette.hairline))
          }
          .buttonStyle(.plain)
        }
      }
      field("Workspace") {
        Picker("", selection: $draft.org) {
          Text("All workspaces").tag(String?.none)
          ForEach(store.orgs, id: \.name) { Text($0.name).tag(String?.some($0.name)) }
          Text("No organization").tag(String?.some(Filter.noOrg))
        }
        .labelsHidden().pickerStyle(.menu)
      }
      HStack {
        Text("\(store.matchCount(query: draft.query, org: draft.org)) issues match")
          .font(.system(size: 12)).foregroundStyle(Palette.muted)
        Spacer()
        Button("Cancel") { store.editing = nil }.keyboardShortcut(.cancelAction)
        Button(draft.existing ? "Save" : "Create view") { store.saveDraft(draft) }
          .keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
          .disabled(draft.name.trimmingCharacters(in: .whitespaces).isEmpty)
      }
    }
    .padding(22).frame(width: 460)
    .background(Palette.base)
    .onAppear { nameFocused = true }
  }

  private func field<C: View>(_ label: String, @ViewBuilder _ content: () -> C) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(label).font(.system(size: 12)).foregroundStyle(Palette.muted)
      content().padding(.horizontal, 10).padding(.vertical, 7).font(.system(size: 13))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(0.04), in: .rect(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Palette.hairline))
    }
  }
}
