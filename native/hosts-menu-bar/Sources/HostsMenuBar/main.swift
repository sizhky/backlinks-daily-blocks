import AppKit
import Foundation
import HostsCore

@main
struct HostsMenuBar {
  @MainActor static func main() {
    let app = NSApplication.shared
    let delegate = MenuController()
    app.setActivationPolicy(.accessory)
    app.delegate = delegate
    app.run()
  }
}

@MainActor
final class MenuController: NSObject, NSApplicationDelegate, NSMenuDelegate {
  private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
  private var enabled = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    let menu = NSMenu()
    let toggle = NSMenuItem(title: "", action: #selector(toggleHosts), keyEquivalent: "")
    toggle.target = self
    menu.addItem(toggle)
    menu.addItem(.separator())
    if helperInstalled {
      let remove = NSMenuItem(title: "Remove password-free lock helper…", action: #selector(removeHelper), keyEquivalent: "")
      remove.target = self
      menu.addItem(remove)
    }
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Quit Hosts Menu Bar", action: #selector(quit), keyEquivalent: "q"))
    menu.items.last?.target = self
    menu.delegate = self
    item.menu = menu
    refresh()
  }

  func menuWillOpen(_ menu: NSMenu) { refresh() }

  private func refresh() {
    enabled = (try? HostsFile.hasActiveMappings()) ?? false
    item.button?.image = NSImage(systemSymbolName: enabled ? "lock.fill" : "lock.open", accessibilityDescription: enabled ? "Hosts block enabled" : "Hosts block disabled")
    item.menu?.items.first?.title = enabled ? "Unlock hosts block…" : lockMenuTitle
    item.button?.toolTip = enabled ? "Hosts block enabled" : "Hosts block disabled"
  }

  private var helperInstalled: Bool {
    FileManager.default.isExecutableFile(atPath: hostsHelperPath)
      && FileManager.default.fileExists(atPath: hostsDaemonPath)
  }

  private var lockMenuTitle: String { helperInstalled ? "Lock hosts block" : "Set up password-free locking…" }

  @objc private func toggleHosts() {
    if enabled { unlockHosts(); return }
    if helperInstalled { requestLock() } else { installHelper() }
  }

  private func installHelper() {
    let bundle = Bundle.main.bundleURL.path
    let helperSource = "\(bundle)/Contents/MacOS/HostsHelper"
    let plistSource = "\(bundle)/Contents/Library/LaunchDaemons/com.yeshwanth.hosts-menu-bar-passwordless-lock.lock-helper.plist"
    let commands = [
      "/bin/launchctl bootout system/\(hostsDaemonLabel) >/dev/null 2>&1 || true",
      "/usr/bin/install -d -o root -g wheel -m 755 /Library/PrivilegedHelperTools",
      "/usr/bin/install -o root -g wheel -m 755 \(shellQuote(helperSource)) \(shellQuote(hostsHelperPath))",
      "/usr/bin/install -o root -g wheel -m 644 \(shellQuote(plistSource)) \(shellQuote(hostsDaemonPath))",
      "/bin/launchctl bootstrap system \(shellQuote(hostsDaemonPath))",
    ].joined(separator: " && ")
    runWithAdministratorAccess(commands, prompt: "Install the lock helper once. Locking will then need no password.") {
      self.refresh()
    }
  }

  @objc private func removeHelper() {
    let commands = [
      "/bin/launchctl bootout system/\(hostsDaemonLabel) >/dev/null 2>&1 || true",
      "/bin/rm -f \(shellQuote(hostsDaemonPath)) \(shellQuote(hostsHelperPath))",
    ].joined(separator: " && ")
    runWithAdministratorAccess(commands, prompt: "Remove the password-free lock helper?") {
      self.refresh()
    }
  }

  private func requestLock() {
    let connection = NSXPCConnection(machServiceName: hostsLockServiceName, options: [.privileged])
    connection.remoteObjectInterface = NSXPCInterface(with: HostsLockProtocol.self)
    connection.invalidationHandler = { [weak self] in
      Task { @MainActor in self?.refresh() }
    }
    guard let proxy = connection.remoteObjectProxyWithErrorHandler({ [weak self] error in
      Task { @MainActor in self?.showFailure("Lock helper failed: \(error.localizedDescription)") }
    }) as? HostsLockProtocol else {
      showFailure("The lock helper is unavailable.")
      return
    }
    connection.resume()
    proxy.lockHosts { [weak self] error in
      let details = error.map { String($0) }
      Task { @MainActor in
        connection.invalidate()
        if let details { self?.showFailure("Lock failed: \(details)") }
        self?.refresh()
      }
    }
  }

  private func unlockHosts() {
    let shell = "\(shellQuote(hostsHelperPath)) --unlock"
    runWithAdministratorAccess(shell, prompt: "Enter your administrator password to unlock the hosts block.") {
      self.refresh()
    }
  }

  private func shellQuote(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
  }

  private func runWithAdministratorAccess(_ command: String, prompt: String, completion: @escaping () -> Void) {
    let escaped = command.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    let script = "do shell script \"\(escaped)\" with prompt \"\(prompt)\" with administrator privileges"
    let process = Process()
    let errors = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    process.arguments = ["-e", script]
    process.standardError = errors
    do {
      try process.run()
      process.waitUntilExit()
      let message = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
      if process.terminationStatus != 0 && !message.contains("User canceled") { showFailure(message) }
      completion()
    } catch { showFailure(error.localizedDescription) }
  }

  private func showFailure(_ details: String) {
    let alert = NSAlert()
    alert.messageText = "Hosts Menu Bar"
    alert.informativeText = details
    alert.runModal()
  }

  @objc private func quit() { NSApp.terminate(nil) }
}
