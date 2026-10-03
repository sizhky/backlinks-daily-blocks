import KanbanCore
import SwiftUI

/// Linear-style sidebar: workspace title, then collapsible Views, Projects, Labels.
struct SidebarView: View {
  @EnvironmentObject var store: BoardStore
  @State private var collapsed: Set<String> = []
  @State private var expanded: Set<String> = []

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 8) {
          Text(title).font(.system(size: 13.5, weight: .semibold)).foregroundStyle(Palette.text).lineLimit(1)
          Spacer()
          IconButton(icon: "magnifyingglass", help: "Commands (⌘K)") { store.paletteOpen = true }
        }
        .padding(.horizontal, 8).padding(.bottom, 10)

        item("All issues", icon: "tray.full", active: store.query.isEmpty, count: nil) { store.query = "" }

        section("Views", add: { store.newView() }) {
          ForEach(store.visibleViews) { view in
            item(view.name, leading: viewIcon(view), active: store.activeView?.id == view.id, count: nil) {
              store.apply(view)
            }
            .rightClickMenu {
              [
                .action("Edit…", symbol: "pencil") { store.edit(view) },
                .action("Update to current filter", symbol: "arrow.triangle.2.circlepath") { store.updateToCurrent(view) },
                .separator,
                .action("Delete view", symbol: "trash", destructive: true) { store.delete(view) },
              ]
            }
          }
        }
        section("Projects") {
          ForEach(nonEmpty(store.facets(\.projects), "Projects"), id: \.name) { f in
            item(f.name, leading: AnyView(Monogram(name: f.name, size: 18)), active: false, count: f.count) {
              store.append("project:" + store.quote(f.name))
            }
          }
          showAll(store.facets(\.projects), "Projects")
        }
        section("Labels") {
          ForEach(nonEmpty(Array(store.facets(\.tags).prefix(15)), "Labels"), id: \.name) { f in
            item(String(f.name.dropFirst()), leading: AnyView(labelDot(f.name).frame(width: 16)), active: false, count: f.count) {
              store.append("tag:" + f.name.dropFirst())
            }
          }
          showAll(Array(store.facets(\.tags).prefix(15)), "Labels")
        }
      }
      .padding(.horizontal, 10).padding(.top, 16).padding(.bottom, 16)
    }
    .scrollIndicators(.never)
  }

  /// Rows with a zero count stay hidden until the section is expanded.
  private func nonEmpty(_ facets: [(name: String, count: Int)], _ section: String) -> [(name: String, count: Int)] {
    expanded.contains(section) ? facets : facets.filter { $0.count > 0 }
  }

  @ViewBuilder private func showAll(_ facets: [(name: String, count: Int)], _ section: String) -> some View {
    let hidden = facets.filter { $0.count == 0 }.count
    if hidden > 0 {
      let open = expanded.contains(section)
      item(open ? "Hide empty" : "Show \(hidden) empty", icon: open ? "chevron.up" : "ellipsis", active: false, count: nil) {
        if open { expanded.remove(section) } else { expanded.insert(section) }
      }
    }
  }

  private var title: String {
    switch store.activeOrgs.count {
    case 0: "All workspaces"
    case 1: OrgPicker.label(store.activeOrgs[0])
    default: "\(store.activeOrgs.count) workspaces"
    }
  }

  /// All-workspace views show the grid icon; workspace views show their org.
  private func viewIcon(_ view: SavedFilter) -> AnyView {
    if view.orgs.count == 1, view.orgs[0] != Filter.noOrg {
      return AnyView(OrgIcon(name: view.orgs[0], size: 16).clipShape(.circle))
    }
    let icon = view.orgs.isEmpty ? "square.grid.2x2" : (view.orgs.count == 1 ? "tray" : "rectangle.stack")
    return AnyView(Image(systemName: icon).font(.system(size: 12)).foregroundStyle(Palette.muted).frame(width: 16))
  }

  private func section<Content: View>(_ name: String, add: (() -> Void)? = nil, @ViewBuilder _ content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Button {
        if collapsed.contains(name) { collapsed.remove(name) } else { collapsed.insert(name) }
      } label: {
        HStack(spacing: 4) {
          Text(name).font(.system(size: 12, weight: .medium))
          Image(systemName: "chevron.right").font(.system(size: 8, weight: .bold))
            .rotationEffect(.degrees(collapsed.contains(name) ? 0 : 90))
          Spacer()
        }
        .foregroundStyle(Palette.muted).padding(.horizontal, 8).padding(.top, 16).padding(.bottom, 4)
      }
      .buttonStyle(.plain)
      .overlay(alignment: .trailing) {
        if let add { IconButton(icon: "plus", help: "New view", action: add).padding(.top, 12) }
      }
      if !collapsed.contains(name) { content() }
    }
  }

  private func item(_ title: String, icon: String, active: Bool, count: Int?, action: @escaping () -> Void) -> some View {
    item(title, leading: AnyView(Image(systemName: icon).font(.system(size: 12)).foregroundStyle(Palette.muted).frame(width: 16)),
         active: active, count: count, action: action)
  }

  private func item(_ title: String, leading: AnyView, active: Bool, count: Int?, action: @escaping () -> Void) -> some View {
    SidebarRow(title: title, leading: leading, active: active, count: count, action: action)
  }
}

struct SidebarRow: View {
  /// One leading width for every row, so all names start at the same x.
  static let slot: CGFloat = 28
  let title: String
  let leading: AnyView
  let active: Bool
  let count: Int?
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      HStack(spacing: 9) {
        leading.frame(width: SidebarRow.slot)
        Text(title).font(.system(size: 13, weight: active ? .medium : .regular)).lineLimit(1)
          .foregroundStyle(active ? Palette.text : Palette.secondary)
        Spacer(minLength: 4)
        if let count { Text("\(count)").font(.system(size: 12).monospacedDigit()).foregroundStyle(Palette.muted) }
      }
      .padding(.horizontal, 8).frame(height: 28)
      .background(active ? Palette.active : (hovering ? Palette.hover : .clear), in: .rect(cornerRadius: 6))
      .opacity(count == 0 ? 0.45 : 1)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain).onHover { hovering = $0 }
  }
}
