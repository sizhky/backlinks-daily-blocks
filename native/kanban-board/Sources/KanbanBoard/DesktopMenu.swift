import AppKit
import KanbanCore

/// Menu bar item: the current desktop's name, every desktop to switch to, and Rename.
@MainActor
final class DesktopMenu: NSObject, NSMenuDelegate {
  private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let desktops = DesktopStore.shared
  private weak var store: BoardStore?
  private var observer: Any?

  init(store: BoardStore) {
    self.store = store
    super.init()
    let menu = NSMenu()
    menu.delegate = self
    item.menu = menu
    item.button?.toolTip = "Desktop"
    observer = desktops.$current.sink { [weak self] space in
      MainActor.assumeIsolated { self?.item.button?.title = space?.name ?? "Desktop" }
    }
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    for space in desktops.spaces {
      let row = NSMenuItem(title: space.name, action: #selector(switchTo(_:)), keyEquivalent: "")
      row.target = self
      row.representedObject = space.number
      row.state = space.id == desktops.current?.id ? .on : .off
      menu.addItem(row)
    }
    menu.addItem(.separator())
    let widget = NSMenuItem(title: "Show Widget", action: #selector(toggleWidget), keyEquivalent: "")
    widget.target = self
    widget.state = store?.widget?.isVisible == true ? .on : .off
    menu.addItem(widget)
    if let current = desktops.current {
      let rename = NSMenuItem(title: "Rename \u{201C}\(current.name)\u{201D}...", action: #selector(rename), keyEquivalent: "")
      rename.target = self
      menu.addItem(rename)
      if current.label != nil {
        let clear = NSMenuItem(title: "Clear Name", action: #selector(clear), keyEquivalent: "")
        clear.target = self
        menu.addItem(clear)
      }
    }
  }

  @objc private func toggleWidget() { store?.widget?.toggle() }

  @objc private func switchTo(_ sender: NSMenuItem) {
    guard let n = sender.representedObject as? Int else { return }
    store?.switchDesktop(n)
  }

  @objc private func rename() {
    guard let current = desktops.current else { return }
    let alert = NSAlert()
    alert.messageText = "Rename \(current.name)"
    alert.addButton(withTitle: "Rename")
    alert.addButton(withTitle: "Cancel")
    let field = NSTextField(string: current.label ?? "")
    field.placeholderString = "Desktop \(current.number)"
    field.frame = NSRect(x: 0, y: 0, width: 240, height: 24)
    alert.accessoryView = field
    alert.window.initialFirstResponder = field
    NSApp.activate()
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    let text = field.stringValue
    store?.renameDesktop(current, to: text.trimmingCharacters(in: .whitespaces).isEmpty ? nil : text)
  }

  @objc private func clear() {
    guard let current = desktops.current else { return }
    store?.renameDesktop(current, to: nil)
  }
}
