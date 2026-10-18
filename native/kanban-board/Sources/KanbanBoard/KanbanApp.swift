import SwiftUI

/// Cmd+ / Cmd- step the whole window between 70% and 160%.
private func zoomStep(_ z: Double) -> Double { min(1.6, max(0.7, (z * 10).rounded() / 10)) }

@main
struct KanbanBoardApp: App {
  @StateObject private var store = BoardStore()

  var body: some Scene {
    // One window per workspace: no value is the main window, an org name opens that org (`BoardWindow.org`).
    WindowGroup("Kanban Board", for: String.self) { $org in
      BoardScene(store: store, org: org).environmentObject(store)
    }
    .windowStyle(.hiddenTitleBar)
    .defaultSize(width: 1500, height: 900)
    .commands { BoardCommands(store: store) }

    Settings {
      SettingsView().preferredColorScheme(.dark)
        .environmentObject(store).environmentObject(store.activity).environmentObject(store.desktops)
    }
  }
}

/// The title the board window for `org` carries; `BoardStore.summon` finds the main window by it.
func boardTitle(_ org: String?) -> String { org.map { "Kanban Board · \($0)" } ?? "Kanban Board" }

/// One board window with its own `BoardWindow`, drag and menu state.
struct BoardScene: View {
  @EnvironmentObject var store: BoardStore
  @StateObject private var win: BoardWindow
  @StateObject private var drag = DragController()
  @StateObject private var menu = MenuController()
  @AppStorage("kanban.sidebarWidth") private var sidebarWidth = 232.0
  @State private var dragStart: Double?
  @AppStorage("kanban.zoom") private var zoom = 1.0

  init(store: BoardStore, org: String?) {
    _win = StateObject(wrappedValue: BoardWindow(store: store, org: org))
  }

  var body: some View {
    GeometryReader { geo in
      HStack(spacing: 0) {
        OrgRail()
        if win.showSidebar {
          SidebarView()
            .frame(width: sidebarWidth)
            .overlay(alignment: .trailing) { sidebarHandle }
        }
        BoardView()
      }
      .coordinateSpace(.named(MenuController.space))
      .overlay { if win.paletteOpen { CommandPalette() } }
      .overlay { if let column = win.newCardColumn { NewCardForm(column: column) } }
      .overlay { MenuHost() }
      .frame(width: geo.size.width / zoom, height: geo.size.height / zoom)
      .scaleEffect(zoom, anchor: .topLeading)
    }
    .background(Backdrop().ignoresSafeArea())
    .background { shortcuts }
    .background(WindowHook { window in
      window.title = boardTitle(win.org)
      // Summoning the board brings it to the current desktop instead of switching to its desktop.
      window.collectionBehavior.insert(.moveToActiveSpace)
    })
    .navigationTitle(boardTitle(win.org))
    .sheet(item: $win.editing) { ViewEditor(draft: $0).environmentObject(store).environmentObject(win) }
    .environmentObject(win)
    .environmentObject(drag)
    .environmentObject(menu)
    .focusedSceneObject(win)
    .frame(minWidth: 1000, minHeight: 620)
    .preferredColorScheme(.dark)
    .ignoresSafeArea()
    .task {
      drag.store = store
      drag.win = win
      if win.org == nil { store.mainWindow = win }
      store.start()
    }
  }

  private var sidebarHandle: some View {
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

  private var shortcuts: some View {
    Group {
      Button("") { win.showSidebar.toggle() }.keyboardShortcut("\\", modifiers: .command)
      Button("") { win.showSidebar.toggle() }.keyboardShortcut("b", modifiers: .command)
      Button("") { win.paletteOpen.toggle() }.keyboardShortcut("k", modifiers: .command)
      Button("") { zoom = zoomStep(zoom + 0.1) }.keyboardShortcut("=", modifiers: .command)
    }
    .opacity(0).frame(width: 0, height: 0)
  }
}

/// Menu commands; card and pick commands act on the key window's `BoardWindow`.
struct BoardCommands: Commands {
  let store: BoardStore
  @FocusedObject private var win: BoardWindow?
  @AppStorage("kanban.zoom") private var zoom = 1.0

  var body: some Commands {
    CommandGroup(replacing: .pasteboard) {
      Button("Cut") { NSApp.sendAction(#selector(NSText.cut(_:)), to: nil, from: nil) }.keyboardShortcut("x")
      Button("Copy") { NSApp.sendAction(#selector(NSText.copy(_:)), to: nil, from: nil) }.keyboardShortcut("c")
      Button("Copy ID") { win?.selectedCard.map(store.copyID) }.keyboardShortcut("c", modifiers: [.command, .shift])
        .disabled(win?.selectedCard == nil)
      Button("Paste") { NSApp.sendAction(#selector(NSText.paste(_:)), to: nil, from: nil) }.keyboardShortcut("v")
      Divider()
      // Text fields keep Cmd-A; elsewhere it picks every shown card.
      Button("Select All") {
        if NSApp.keyWindow?.firstResponder is NSText { NSApp.sendAction(#selector(NSText.selectAll(_:)), to: nil, from: nil) }
        else { win?.pickAll() }
      }.keyboardShortcut("a")
      Button("Deselect All") { win?.picked.removeAll() }.keyboardShortcut("a", modifiers: [.command, .shift])
        .disabled(win?.picked.isEmpty ?? true)
    }
    CommandGroup(after: .toolbar) {
      Button("Timeline") { store.openTimeline() }.keyboardShortcut("t", modifiers: [.command, .shift])
      Divider()
      Button("Zoom In") { zoom = zoomStep(zoom + 0.1) }.keyboardShortcut("+", modifiers: .command)
      Button("Zoom Out") { zoom = zoomStep(zoom - 0.1) }.keyboardShortcut("-", modifiers: .command)
      Button("Actual Size") { zoom = 1 }.keyboardShortcut("0", modifiers: .command)
    }
  }
}

/// Hands the hosting `NSWindow` to `attach` once the view is in a window.
struct WindowHook: NSViewRepresentable {
  let attach: (NSWindow) -> Void

  func makeNSView(context: Context) -> NSView { HookView(attach: attach) }
  func updateNSView(_ view: NSView, context: Context) {}

  private final class HookView: NSView {
    let attach: (NSWindow) -> Void
    init(attach: @escaping (NSWindow) -> Void) { self.attach = attach; super.init(frame: .zero) }
    required init?(coder: NSCoder) { nil }
    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      if let window { attach(window) }
    }
  }
}
