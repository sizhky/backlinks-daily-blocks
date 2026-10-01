import SwiftUI

@main
struct KanbanBoardApp: App {
  @StateObject private var store = BoardStore()
  @AppStorage("kanban.sidebar") private var showSidebar = true
  @AppStorage("kanban.sidebarWidth") private var sidebarWidth = 232.0
  @State private var dragStart: Double?

  var body: some Scene {
    WindowGroup("Kanban Board") {
      HStack(spacing: 0) {
        OrgRail()
        if showSidebar {
          SidebarView()
            .frame(width: sidebarWidth)
            .background(Color.white.opacity(0.02))
            .overlay(alignment: .trailing) { Rectangle().fill(Palette.hairline).frame(width: 1) }
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
      .background(Button("") { showSidebar.toggle() }.keyboardShortcut("\\", modifiers: .command).opacity(0))
      .environmentObject(store)
      .frame(minWidth: 1000, minHeight: 620)
      .preferredColorScheme(.dark)
      .ignoresSafeArea()
      .task { store.start() }
    }
    .windowStyle(.hiddenTitleBar)
    .defaultSize(width: 1500, height: 900)
  }
}
