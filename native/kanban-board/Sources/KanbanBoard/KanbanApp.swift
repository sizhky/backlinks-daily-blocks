import SwiftUI

@main
struct KanbanBoardApp: App {
  @StateObject private var store = BoardStore()
  @AppStorage("kanban.sidebarWidth") private var sidebarWidth = 232.0
  @State private var dragStart: Double?
  @AppStorage("kanban.zoom") private var zoom = 1.0

  /// Cmd+ / Cmd- step the whole window between 70% and 160%.
  private func setZoom(_ z: Double) { zoom = min(1.6, max(0.7, (z * 10).rounded() / 10)) }

  var body: some Scene {
    WindowGroup("Kanban Board") {
      GeometryReader { geo in
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
      .overlay { if store.paletteOpen { CommandPalette() } }
      .frame(width: geo.size.width / zoom, height: geo.size.height / zoom)
      .scaleEffect(zoom, anchor: .topLeading)
      }
      .background(Backdrop().ignoresSafeArea())
      .background {
        Group {
          Button("") { store.showSidebar.toggle() }.keyboardShortcut("\\", modifiers: .command)
          Button("") { store.paletteOpen.toggle() }.keyboardShortcut("k", modifiers: .command)
          Button("") { setZoom(zoom + 0.1) }.keyboardShortcut("=", modifiers: .command)
        }
        .opacity(0).frame(width: 0, height: 0)
      }
      .sheet(item: $store.editing) { ViewEditor(draft: $0).environmentObject(store) }
      .environmentObject(store)
      .frame(minWidth: 1000, minHeight: 620)
      .preferredColorScheme(.dark)
      .ignoresSafeArea()
      .task { store.start() }
    }
    .windowStyle(.hiddenTitleBar)
    .defaultSize(width: 1500, height: 900)
    .commands {
      CommandGroup(after: .toolbar) {
        Button("Zoom In") { setZoom(zoom + 0.1) }.keyboardShortcut("+", modifiers: .command)
        Button("Zoom Out") { setZoom(zoom - 0.1) }.keyboardShortcut("-", modifiers: .command)
        Button("Actual Size") { zoom = 1 }.keyboardShortcut("0", modifiers: .command)
      }
    }

    Settings { SettingsView().preferredColorScheme(.dark) }
  }
}
