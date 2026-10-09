import AppKit
import KanbanCore
import SwiftUI

/// One row of a custom menu. Replaces `Menu` and `.contextMenu` so every menu shares the Linear look.
struct MenuItem: Identifiable {
  enum Kind { case action(() -> Void), submenu([MenuItem]), separator, grid(columns: Int, [MenuSwatch]) }
  let id = UUID()
  var title = ""
  var icon: AnyView?
  var checked = false
  var hint: String?
  var disabled = false
  var destructive = false
  var kind: Kind

  var isRow: Bool {
    switch kind { case .separator, .grid: false; default: true }
  }
  var enabled: Bool { isRow && !disabled }
  var height: CGFloat {
    switch kind {
    case .separator: MenuMetrics.separator
    case .grid(let columns, let cells): CGFloat((cells.count + columns - 1) / columns) * MenuMetrics.swatch + 8
    default: MenuMetrics.row
    }
  }

  static let separator = MenuItem(kind: .separator)

  static func action(_ title: String, symbol: String? = nil, glyph: AnyView? = nil, checked: Bool = false,
                     hint: String? = nil, disabled: Bool = false, destructive: Bool = false,
                     run: @escaping () -> Void) -> MenuItem {
    MenuItem(title: title, icon: glyph ?? symbol.map(MenuItem.symbol), checked: checked, hint: hint,
             disabled: disabled, destructive: destructive, kind: .action(run))
  }

  static func submenu(_ title: String, symbol: String? = nil, disabled: Bool = false, _ items: [MenuItem]) -> MenuItem {
    MenuItem(title: title, icon: symbol.map(MenuItem.symbol), disabled: disabled, kind: .submenu(items))
  }

  /// Colour cells clicked by the pointer; arrow keys skip the grid.
  static func grid(columns: Int, _ cells: [MenuSwatch]) -> MenuItem { MenuItem(kind: .grid(columns: columns, cells)) }

  static func symbol(_ name: String) -> AnyView {
    AnyView(Image(systemName: name).font(.system(size: 12, weight: .medium)))
  }
}

/// One cell of a `.grid` menu item.
struct MenuSwatch: Identifiable {
  let id = UUID()
  var color: Color
  var help: String
  var checked = false
  var run: () -> Void
}

enum MenuMetrics {
  static let row: CGFloat = 28
  static let swatch: CGFloat = 34
  static let separator: CGFloat = 9
  static let pad: CGFloat = 4
  static let width: CGFloat = 220
  static let edge: CGFloat = 8

  static func height(_ items: [MenuItem]) -> CGFloat { items.reduce(pad * 2) { $0 + $1.height } }
  static func offset(of index: Int, in items: [MenuItem]) -> CGFloat { items.prefix(index).reduce(pad) { $0 + $1.height } }
}

/// One open panel: the root menu or a submenu, with its keyboard or hover highlight.
struct MenuLevel {
  var items: [MenuItem]
  var origin: CGPoint
  var highlight: Int?
}

/// Owns the open menu. Panels draw in `MenuHost`; anchors are in the `MenuController.space` coordinate space.
@MainActor
final class MenuController: ObservableObject {
  static let space = "menu"
  @Published private(set) var levels: [MenuLevel] = []
  var bounds: CGSize = .zero
  private var keys: Any?
  private var resign: Any?

  var isOpen: Bool { !levels.isEmpty }

  /// Opens at a click in window coordinates (bottom-left origin), undoing the window zoom.
  func show(_ items: [MenuItem], atWindow point: CGPoint) {
    let zoom = UserDefaults.standard.double(forKey: "kanban.zoom")
    let height = NSApp.keyWindow?.contentView?.bounds.height ?? 0
    let z = zoom > 0 ? zoom : 1
    show(items, at: CGPoint(x: point.x / z, y: (height - point.y) / z))
  }

  /// Opens below `frame`, aligned to its leading or trailing edge; flips above when there is no room.
  func show(_ items: [MenuItem], below frame: CGRect, trailing: Bool = false) {
    let x = trailing ? frame.maxX - MenuMetrics.width : frame.minX
    show(items, at: CGPoint(x: x, y: frame.maxY + 4), flipTo: frame.minY - 4)
  }

  func show(_ items: [MenuItem], at point: CGPoint, flipTo bottom: CGFloat? = nil) {
    guard !items.isEmpty else { return }
    let size = CGSize(width: MenuMetrics.width, height: MenuMetrics.height(items))
    var y = point.y
    if y + size.height > bounds.height - MenuMetrics.edge { y = (bottom ?? point.y) - size.height }
    let origin = clamp(CGPoint(x: point.x, y: y), size)
    install()
    withAnimation(.easeOut(duration: 0.12)) { levels = [MenuLevel(items: items, origin: origin, highlight: nil)] }
  }

  func close() {
    guard isOpen else { return }
    withAnimation(.easeOut(duration: 0.08)) { levels = [] }
    uninstall()
  }

  /// Pointer over a row: highlight it, drop deeper panels, and open its submenu.
  func hover(_ level: Int, _ index: Int) {
    guard levels.indices.contains(level), levels[level].items[index].enabled else { return }
    trim(to: level)
    levels[level].highlight = index
    openSubmenu(level, index, selectFirst: false)
  }

  func activate(_ level: Int, _ index: Int) {
    guard levels.indices.contains(level), levels[level].items[index].enabled else { return }
    switch levels[level].items[index].kind {
    case .action(let run): close(); run()
    case .submenu: trim(to: level); levels[level].highlight = index; openSubmenu(level, index, selectFirst: true)
    case .separator, .grid: break
    }
  }

  private func trim(to level: Int) { if levels.count > level + 1 { levels.removeSubrange((level + 1)...) } }

  private func openSubmenu(_ level: Int, _ index: Int, selectFirst: Bool) {
    guard case .submenu(let items) = levels[level].items[index].kind else { return }
    let parent = levels[level]
    let size = CGSize(width: MenuMetrics.width, height: MenuMetrics.height(items))
    let rowTop = parent.origin.y + MenuMetrics.offset(of: index, in: parent.items)
    var x = parent.origin.x + MenuMetrics.width - 4
    if x + size.width > bounds.width - MenuMetrics.edge { x = parent.origin.x - size.width + 4 }
    let origin = clamp(CGPoint(x: x, y: rowTop - MenuMetrics.pad), size)
    let first = selectFirst ? MenuNav.step(items.map(\.enabled), from: nil, by: 1) : nil
    levels.append(MenuLevel(items: items, origin: origin, highlight: first))
  }

  private func clamp(_ p: CGPoint, _ size: CGSize) -> CGPoint {
    let e = MenuMetrics.edge
    return CGPoint(x: max(e, min(p.x, bounds.width - size.width - e)), y: max(e, min(p.y, bounds.height - size.height - e)))
  }

  // MARK: keyboard

  private func install() {
    guard keys == nil else { return }
    keys = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
      guard let self, self.isOpen, event.modifierFlags.intersection([.command, .control, .option]).isEmpty else { return event }
      return MainActor.assumeIsolated { self.key(event.keyCode) } ? nil : event
    }
    resign = NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.close() }
    }
  }

  private func uninstall() {
    keys.map(NSEvent.removeMonitor); keys = nil
    resign.map(NotificationCenter.default.removeObserver); resign = nil
  }

  /// Arrows move, right opens a submenu, left or esc steps out, return runs. Every key is swallowed while open.
  private func key(_ code: UInt16) -> Bool {
    guard let top = levels.indices.last else { return false }
    let level = levels[top]
    switch code {
    case 53: levels.count > 1 ? trim(to: top - 1) : close()
    case 125, 126:
      levels[top].highlight = MenuNav.step(level.items.map(\.enabled), from: level.highlight, by: code == 125 ? 1 : -1)
    case 124: if let i = level.highlight { activate(top, i) }
    case 123: if levels.count > 1 { trim(to: top - 1) }
    case 36, 76: if let i = level.highlight { activate(top, i) }
    default: break
    }
    return true
  }
}

/// Draws the open panels above the whole window and closes on a click outside.
struct MenuHost: View {
  @EnvironmentObject var menu: MenuController

  var body: some View {
    GeometryReader { geo in
      ZStack(alignment: .topLeading) {
        if menu.isOpen {
          Color.clear.contentShape(Rectangle()).onTapGesture { menu.close() }
          ForEach(Array(menu.levels.enumerated()), id: \.offset) { depth, level in
            MenuPanel(depth: depth, level: level)
              .offset(x: level.origin.x, y: level.origin.y)
              .transition(.opacity.combined(with: .scale(scale: 0.97, anchor: .topLeading)))
          }
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .onAppear { menu.bounds = geo.size }
      .onChange(of: geo.size) { menu.bounds = geo.size }
    }
  }
}

struct MenuPanel: View {
  @EnvironmentObject var menu: MenuController
  let depth: Int
  let level: MenuLevel

  var body: some View {
    let aligned = level.items.contains { $0.icon != nil }
    VStack(spacing: 0) {
      ForEach(Array(level.items.enumerated()), id: \.element.id) { i, item in
        if case .grid(let columns, let cells) = item.kind {
          SwatchGrid(columns: columns, cells: cells).frame(height: item.height)
        } else if item.isRow {
          MenuRow(item: item, aligned: aligned, highlighted: level.highlight == i)
            .onHover { if $0 { menu.hover(depth, i) } }
            .onTapGesture { menu.activate(depth, i) }.pointerStyle(.link)
        } else {
          Rectangle().fill(Palette.hairline).frame(height: 1).padding(.horizontal, 4).frame(height: MenuMetrics.separator)
        }
      }
    }
    .padding(MenuMetrics.pad)
    .frame(width: MenuMetrics.width)
    .background(Palette.cardHover, in: .rect(cornerRadius: 9))
    .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Palette.hairlineStrong))
    .shadow(color: .black.opacity(0.45), radius: 14, y: 6)
  }
}

/// `.grid` menu item: round swatches, a checkmark on the current one; a click runs it and closes the menu.
struct SwatchGrid: View {
  @EnvironmentObject var menu: MenuController
  let columns: Int
  let cells: [MenuSwatch]

  var body: some View {
    LazyVGrid(columns: Array(repeating: GridItem(.fixed(MenuMetrics.swatch), spacing: 4), count: columns), spacing: 0) {
      ForEach(cells) { cell in
        Circle().fill(cell.color).frame(width: 22, height: 22)
          .overlay { if cell.checked { Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.white) } }
          .overlay(Circle().strokeBorder(Color.white.opacity(cell.checked ? 0.9 : 0), lineWidth: 1.5).padding(-3))
          .frame(width: MenuMetrics.swatch, height: MenuMetrics.swatch).contentShape(Rectangle())
          .onTapGesture { menu.close(); cell.run() }.pointerStyle(.link).help(cell.help)
      }
    }
    .padding(.vertical, 4)
  }
}

struct MenuRow: View {
  let item: MenuItem
  let aligned: Bool
  let highlighted: Bool

  var body: some View {
    HStack(spacing: 9) {
      if aligned { (item.icon ?? AnyView(Color.clear)).foregroundStyle(Palette.muted).frame(width: 16) }
      Text(item.title).lineLimit(1)
      Spacer(minLength: 8)
      if let hint = item.hint { Text(hint).font(.system(size: 11.5)).foregroundStyle(Palette.muted) }
      if item.checked { Image(systemName: "checkmark").font(.system(size: 10.5, weight: .semibold)).foregroundStyle(Palette.secondary) }
      if case .submenu = item.kind { Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(Palette.muted) }
    }
    .font(.system(size: 13))
    .foregroundStyle(item.destructive ? Palette.danger : (highlighted ? Palette.text : Palette.secondary))
    .padding(.horizontal, 8).frame(height: MenuMetrics.row)
    .background(highlighted ? Palette.active : .clear, in: .rect(cornerRadius: 6))
    .opacity(item.disabled ? 0.4 : 1)
    .contentShape(Rectangle())
  }
}

// MARK: triggers

/// Button that opens a menu below itself.
struct MenuTrigger<Label: View>: View {
  @EnvironmentObject var menu: MenuController
  var trailing = false
  let items: () -> [MenuItem]
  @ViewBuilder var label: Label
  @State private var frame = CGRect.zero

  var body: some View {
    Button { menu.show(items(), below: frame, trailing: trailing) } label: { label }
      .buttonStyle(.pointing)
      .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(MenuController.space)) } action: { frame = $0 }
  }
}

extension View {
  /// Right-click (or control-click) opens `items` at the pointer.
  func rightClickMenu(_ items: @escaping () -> [MenuItem]) -> some View { modifier(RightClickMenu(items: items)) }
  /// Right-click (or control-click) runs `action`; for views that place the menu themselves.
  func onRightClick(_ action: @escaping () -> Void) -> some View { overlay(RightClickCatcher { _ in action() }) }
}

private struct RightClickMenu: ViewModifier {
  @EnvironmentObject var menu: MenuController
  let items: () -> [MenuItem]

  func body(content: Content) -> some View {
    content.overlay(RightClickCatcher { menu.show(items(), atWindow: $0) })
  }
}

/// Transparent AppKit view that takes only right clicks; every other event falls through to SwiftUI.
private struct RightClickCatcher: NSViewRepresentable {
  let onClick: (CGPoint) -> Void

  func makeNSView(context: Context) -> CatcherView { CatcherView() }
  func updateNSView(_ view: CatcherView, context: Context) { view.onClick = onClick }

  final class CatcherView: NSView {
    var onClick: (CGPoint) -> Void = { _ in }

    private static func isMenuClick(_ e: NSEvent) -> Bool {
      e.type == .rightMouseDown || (e.type == .leftMouseDown && e.modifierFlags.contains(.control))
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
      guard let e = NSApp.currentEvent, Self.isMenuClick(e) else { return nil }
      return super.hitTest(point)
    }
    override func rightMouseDown(with e: NSEvent) { onClick(e.locationInWindow) }
    override func mouseDown(with e: NSEvent) { if Self.isMenuClick(e) { onClick(e.locationInWindow) } }
  }
}
