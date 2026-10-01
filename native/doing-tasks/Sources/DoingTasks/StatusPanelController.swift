import AppKit
import Combine
import QuartzCore
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
  private let settingsController = SettingsWindowController()
  private var countSubscription: AnyCancellable?
  private var currentCount = 0
  private var currentTaskIDs = Set<String>()
  private var unseenTaskIDs = Set<String>()
  private var isPulsing = false

  func install(store: TaskStore) {
    if let button = statusItem.button {
      button.image = NSImage(systemSymbolName: "checkmark.circle", accessibilityDescription: "Doing tasks")
      button.imagePosition = .imageLeading
      button.target = self
      button.action = #selector(toggle)
    }
    currentCount = store.tasks.count
    currentTaskIDs = Set(store.tasks.map(\.id))
    updateTitle()

    popover.behavior = .transient
    popover.animates = true
    popover.contentSize = NSSize(width: 420, height: 480)
    popover.contentViewController = NSHostingController(rootView: TaskListView(
      store: store,
      showSettings: { [weak self] in self?.settingsController.show(store: store) }
    ))

    countSubscription = store.$tasks.combineLatest(store.$hasRefreshed)
      .sink { [weak self] tasks, hasRefreshed in
        guard let self else { return }
        let count = tasks.count
        let taskIDs = Set(tasks.map(\.id))
        let added = hasRefreshed ? taskIDs.subtracting(self.currentTaskIDs) : []
        self.currentCount = count
        self.currentTaskIDs = taskIDs
        self.unseenTaskIDs.formUnion(added)
        self.unseenTaskIDs.formIntersection(taskIDs)
        self.updateTitle()
        if !added.isEmpty {
          self.bounce()
          self.pulse()
        }
        if self.unseenTaskIDs.isEmpty { self.stopPulse() }
      }
  }

  func show() {
    guard !popover.isShown, let button = statusItem.button else { return }
    unseenTaskIDs.removeAll()
    stopPulse()
    updateTitle()
    popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
    popover.contentViewController?.view.window?.makeKey()
  }

  private func updateTitle() {
    guard let button = statusItem.button else { return }
    let title = NSMutableAttributedString(string: "Doing: \(currentCount)")
    if !unseenTaskIDs.isEmpty {
      let color = isPulsing ? NSColor.labelColor : NSColor.systemOrange
      title.append(NSAttributedString(string: " (+\(unseenTaskIDs.count))", attributes: [.foregroundColor: color]))
    }
    button.attributedTitle = title
  }

  private func pulse() {
    guard let button = statusItem.button else { return }
    isPulsing = true
    updateTitle()
    button.contentTintColor = .labelColor
    button.wantsLayer = true
    button.layer?.cornerRadius = 5
    button.layer?.backgroundColor = NSColor.systemOrange.cgColor
    let animation = CABasicAnimation(keyPath: "backgroundColor")
    animation.fromValue = NSColor.systemOrange.withAlphaComponent(0.25).cgColor
    animation.toValue = NSColor.systemOrange.cgColor
    animation.duration = 1.1
    animation.autoreverses = true
    animation.repeatCount = .infinity
    button.layer?.add(animation, forKey: "bdb-doing-pulse")
  }

  private func bounce() {
    guard let button = statusItem.button else { return }
    button.wantsLayer = true
    let animation = CAKeyframeAnimation(keyPath: "transform.scale")
    animation.values = [1, 1.16, 0.97, 1]
    animation.keyTimes = [0, 0.35, 0.7, 1]
    animation.duration = 0.45
    button.layer?.add(animation, forKey: "bdb-doing-bounce")
  }

  private func stopPulse() {
    guard let button = statusItem.button else { return }
    isPulsing = false
    button.layer?.removeAnimation(forKey: "bdb-doing-pulse")
    button.layer?.backgroundColor = NSColor.clear.cgColor
    button.contentTintColor = nil
  }

  @objc private func toggle() {
    if popover.isShown {
      popover.performClose(nil)
    } else {
      show()
    }
  }
}
