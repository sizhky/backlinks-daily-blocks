import AppKit
import Foundation
import KanbanCore

/// Current desktops and their names. Reads Spaces through private CoreGraphics calls (looked up
/// at runtime, like yabai's query path) and keeps names in `<vault>/.activity/desktops.json`,
/// keyed by Space UUID. This store is the only writer of that file.
@MainActor
final class DesktopStore: ObservableObject {
  static let shared = DesktopStore()

  @Published private(set) var spaces: [DesktopSpace] = []
  @Published private(set) var current: DesktopSpace?

  private var labels: [String: String] = [:]
  private var file: URL?
  private var fileStamp: Date?

  func start(dir: URL) {
    guard file == nil else { return }
    file = dir.appendingPathComponent("desktops.json")
    NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.refresh() }
    }
    refresh()
  }

  /// Rereads Spaces, and the label file when it changed on disk.
  func refresh() {
    if let file {
      let stamp = (try? FileManager.default.attributesOfItem(atPath: file.path))?[.modificationDate] as? Date
      if stamp != fileStamp { fileStamp = stamp; labels = Desktops.labels(from: try? Data(contentsOf: file)) }
    }
    guard let (active, displays) = CGS.spaces() else { return }
    let fresh = Desktops.parse(displays: displays, labels: labels)
    if fresh != spaces { spaces = fresh }
    let now = fresh.first { $0.id == active }
    if now != current { current = now }
  }

  func resolve(_ ref: String?) -> DesktopSpace? { Desktops.resolve(ref, in: spaces) }

  /// Display name for a card's desktop reference; a stale name shows as written.
  func name(_ ref: String) -> String { resolve(ref)?.name ?? (Int(ref).map { "Desktop \($0)" } ?? ref) }

  /// Sets or clears (nil) a desktop's name. Returns false for an unsafe name.
  @discardableResult
  func rename(_ space: DesktopSpace, to name: String?) -> Bool {
    if let name {
      guard let clean = Desktops.cleanLabel(name) else { return false }
      labels[space.uuid] = clean
    } else {
      labels.removeValue(forKey: space.uuid)
    }
    if let file { try? Desktops.encode(labels).write(to: file, options: .atomic) }
    fileStamp = nil
    refresh()
    return true
  }
}

/// Private CoreGraphics Space queries, resolved with dlsym so a missing symbol gives nil, not a crash.
enum CGS {
  private typealias ConnectionFn = @convention(c) () -> Int32
  private typealias ActiveSpaceFn = @convention(c) (Int32) -> Int
  private typealias DisplaySpacesFn = @convention(c) (Int32) -> Unmanaged<CFArray>?
  private nonisolated(unsafe) static let lib = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_LAZY)
  private static func fn<T>(_ name: String, _: T.Type) -> T? { dlsym(lib, name).map { unsafeBitCast($0, to: T.self) } }

  /// Active space id and the per-display space lists.
  static func spaces() -> (Int, [[String: Any]])? {
    guard let conn = fn("CGSMainConnectionID", ConnectionFn.self), let active = fn("CGSGetActiveSpace", ActiveSpaceFn.self),
          let displays = fn("CGSCopyManagedDisplaySpaces", DisplaySpacesFn.self) else { return nil }
    let cid = conn()
    guard let list = displays(cid)?.takeRetainedValue() as? [[String: Any]] else { return nil }
    return (active(cid), list)
  }
}
