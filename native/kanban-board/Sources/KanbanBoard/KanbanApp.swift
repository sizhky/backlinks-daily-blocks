import SwiftUI

@main
struct KanbanBoardApp: App {
  @StateObject private var store = BoardStore()
  @AppStorage("kanban.sidebarWidth") private var sidebarWidth = 232.0
  @State private var dragStart: Double?

  var body: some Scene {
    WindowGroup("Kanban Board") {
      HStack(spacing: 0) {
        OrgRail()
        if store.showSidebar {
          SidebarView()
            .frame(width: sidebarWidth)
            .overlay(alignment: .trailing) {
              Color.clear.frame(width: 8).contentShape(Rectangle()).offset(x: 4)
                .onHover { $0 ? NSCursor.resizeLeftRight.push() : NSCursor.pop() }
                .gesture(DragGesture(minimumDistance: 1, coordinateSpace: .global)
                  .onChanged { drag in
                    let start = dragStart ?? sidebarWidth
                    dragStart = start
                    sidebarWidth = min(420, max(180, start + drag.translation.width))
                  }
                  .onEnded { _ in dragStart = nil })
            }
        }
        BoardView()
      }
      .background(Backdrop().ignoresSafeArea())
      .background {
        Group {
          Button("") { store.showSidebar.toggle() }.keyboardShortcut("\\", modifiers: .command)
          Button("") { store.paletteOpen.toggle() }.keyboardShortcut("k", modifiers: .command)
        }
        .opacity(0).frame(width: 0, height: 0)
      }
      .overlay { if store.paletteOpen { CommandPalette() } }
      .sheet(item: $store.editing) { ViewEditor(draft: $0).environmentObject(store) }
      .environmentObject(store)
      .frame(minWidth: 1000, minHeight: 620)
      .preferredColorScheme(.dark)
      .ignoresSafeArea()
      .task { store.start() }
    }
    .windowStyle(.hiddenTitleBar)
    .defaultSize(width: 1500, height: 900)

    Settings { SettingsView().preferredColorScheme(.dark) }
  }
}
