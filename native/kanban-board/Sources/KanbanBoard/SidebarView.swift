import SwiftUI

struct SidebarView: View {
  @EnvironmentObject var store: BoardStore

  var body: some View {
    List {
      Section("Saved") {
        ForEach(store.saved) { filter in
          row(filter.name, active: store.query == filter.query, count: nil, icon: "star") { store.query = filter.query }
            .contextMenu { Button("Delete", role: .destructive) { store.delete(filter) } }
        }
      }
      Section("Projects") {
        ForEach(store.facets(\.projects), id: \.name) { f in
          row(f.name, active: false, count: f.count, icon: "folder", project: true) { store.append("project:" + store.quote(f.name)) }
        }
      }
      Section("Tags") {
        ForEach(store.facets(\.tags).prefix(15), id: \.name) { f in
          row(f.name, active: false, count: f.count, icon: "number") { store.append("tag:" + f.name.dropFirst()) }
        }
      }
    }
    .listStyle(.sidebar)
    .scrollContentBackground(.hidden)
    .padding(.top, 40)
  }

  private func row(_ title: String, active: Bool, count: Int?, icon: String, project: Bool = false, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack {
        if project {
          HStack(spacing: 8) { Monogram(name: title, size: 16); Text(title).lineLimit(1) }
        } else {
          Label(title, systemImage: icon).lineLimit(1)
        }
        Spacer()
        if let count { Text("\(count)").font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
      }
      .fontWeight(active ? .semibold : .regular)
      .opacity(count == 0 ? 0.4 : 1)
    }
    .buttonStyle(.plain)
  }
}
