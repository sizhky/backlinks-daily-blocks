import AppKit
import Combine
import SwiftUI

@MainActor
protocol PanelPresenting: AnyObject {
  func install(store: TaskStore)
  func show()
}

@MainActor
final class StatusPanelController: NSObject, PanelPresenting {
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let popover = NSPopover()
  private var countSubscription: AnyCancellable?
  private var currentCount = 0
  private var unseenCount = 0

  func install(store: TaskStore) {
    if let button = statusItem.button {
      button.target = self
      button.action = #selector(toggle)
    }
    currentCount = store.tasks.count
    updateTitle()

    popover.behavior = .transient
    popover.animates = true
    popover.contentSize = NSSize(width: 420, height: 480)
    popover.contentViewController = NSHostingController(rootView: TaskListView(store: store))

    countSubscription = store.$tasks.combineLatest(store.$hasRefreshed)
      .sink { [weak self] tasks, hasRefreshed in
        guard let self else { return }
        let count = tasks.count
        let increase = hasRefreshed ? max(0, count - self.currentCount) : 0
        self.currentCount = count
        self.unseenCount += increase
        self.updateTitle()
        if increase > 0 { self.pulse() }
      }
  }

  func show() {
    guard !popover.isShown, let button = statusItem.button else { return }
    unseenCount = 0
    updateTitle()
    popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
    popover.contentViewController?.view.window?.makeKey()
  }

  private func updateTitle() {
    guard let button = statusItem.button else { return }
    let title = NSMutableAttributedString(string: "Doing: \(currentCount)")
    if unseenCount > 0 {
      title.append(NSAttributedString(string: " (+\(unseenCount))", attributes: [.foregroundColor: NSColor.systemOrange]))
    }
    button.attributedTitle = title
  }

  private func pulse() {
    guard let button = statusItem.button else { return }
    button.alphaValue = 1
    NSAnimationContext.runAnimationGroup { context in
      context.duration = 0.18
      button.animator().alphaValue = 0.35
    } completionHandler: {
      _Concurrency.Task { @MainActor in
        NSAnimationContext.runAnimationGroup { context in
          context.duration = 0.22
          button.animator().alphaValue = 1
        }
      }
    }
  }

  @objc private func toggle() {
    if popover.isShown {
      popover.performClose(nil)
    } else {
      show()
    }
  }
}
