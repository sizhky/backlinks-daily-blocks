import KanbanCore
import SwiftUI

/// Slack-style workspace rail: one tile per org, "All" on top, Doing count as badge, ⌘1-9 to switch.
struct OrgRail: View {
  @EnvironmentObject var store: BoardStore

  var body: some View {
    let orgs = store.orgs
    VStack(spacing: 10) {
      tile(selected: store.activeOrgs.isEmpty, badge: 0, help: "All workspaces (⌘0)") {
        RoundedRectangle(cornerRadius: 11).fill(Color.white.opacity(0.1))
          .overlay(Image(systemName: "square.grid.2x2.fill").font(.system(size: 15)).foregroundStyle(Palette.text))
      } action: { _ in store.orgScope = [] }
      Divider().overlay(Palette.hairline).frame(width: 28)
      ScrollView {
        VStack(spacing: 10) {
          ForEach(Array(orgs.enumerated()), id: \.element.name) { index, org in
            tile(selected: store.activeOrgs.contains(org.name), badge: store.doingCount(org: org.name),
                 help: "\(org.name) (⌘\(index + 1)) · ⌘-click to add") {
              OrgIcon(name: org.name, size: 38)
            } action: { store.selectOrg(org.name, additive: $0) }
          }
          if store.hasUnassigned {
            tile(selected: store.activeOrgs.contains(Filter.noOrg), badge: store.doingCount(org: Filter.noOrg),
                 help: "No organization", dashed: true) {
              Color.white.opacity(0.06)
                .overlay(Image(systemName: "tray").font(.system(size: 15)).foregroundStyle(Palette.muted))
            } action: { store.selectOrg(Filter.noOrg, additive: $0) }
          }
        }
        .padding(.vertical, 4).padding(.horizontal, 10)
      }
      .scrollIndicators(.never)
      .padding(.horizontal, -10)
      Spacer(minLength: 0)
    }
    .padding(.top, 52).padding(.horizontal, 12)
    .frame(width: 72)
    .background {
      Group {
        Button("") { store.orgScope = [] }.keyboardShortcut("0", modifiers: .command)
        ForEach(Array(orgs.prefix(9).enumerated()), id: \.element.name) { index, org in
          Button("") { store.orgScope = [org.name] }
            .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
        }
      }
      .opacity(0).frame(width: 0, height: 0)
    }
  }

  private func tile<Icon: View>(selected: Bool, badge: Int, help: String, dashed: Bool = false,
                                @ViewBuilder icon: () -> Icon, action: @escaping (Bool) -> Void) -> some View {
    Button { action(NSEvent.modifierFlags.contains(.command) || NSEvent.modifierFlags.contains(.shift)) } label: {
      icon()
        .frame(width: 38, height: 38)
        .clipShape(.rect(cornerRadius: selected ? 11 : 19))
        .overlay {
          if dashed {
            RoundedRectangle(cornerRadius: selected ? 11 : 19)
              .strokeBorder(Palette.muted.opacity(0.6), style: .init(lineWidth: 1, dash: [3, 3]))
          }
        }
        .overlay(alignment: .topTrailing) {
          if badge > 0 {
            Text("\(badge)").font(.system(size: 9.5, weight: .bold).monospacedDigit()).foregroundStyle(.white)
              .padding(.horizontal, 5).frame(minWidth: 16, minHeight: 16)
              .background(Palette.indigo, in: .capsule)
              .overlay(Capsule().strokeBorder(Palette.base, lineWidth: 2))
              .offset(x: 6, y: -5)
          }
        }
        .animation(.spring(duration: 0.25), value: selected)
    }
    .buttonStyle(.plain)
    .help(help)
    .overlay(alignment: .leading) {
      Capsule().fill(Palette.text).frame(width: 4, height: selected ? 26 : 0).offset(x: -10)
        .animation(.spring(duration: 0.25), value: selected)
    }
  }
}
