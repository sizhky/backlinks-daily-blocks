import Combine
import SwiftUI

/// Justification of one widget element.
enum WidgetAlign: String, CaseIterable, Identifiable {
  case leading, center, trailing
  var id: String { rawValue }
  var label: String { switch self { case .leading: "Left"; case .center: "Center"; case .trailing: "Right" } }
  var symbol: String { switch self { case .leading: "text.alignleft"; case .center: "text.aligncenter"; case .trailing: "text.alignright" } }
  var text: TextAlignment { switch self { case .leading: .leading; case .center: .center; case .trailing: .trailing } }
  var frame: Alignment { switch self { case .leading: .leading; case .center: .center; case .trailing: .trailing } }
  var horizontal: HorizontalAlignment { switch self { case .leading: .leading; case .center: .center; case .trailing: .trailing } }
}

/// The widget's elements, top to bottom. Each has its own visibility, justification, and font size
/// under `widget.<part>.*`; visibility keeps the original `widget.*` keys so earlier choices survive.
enum WidgetPart: String, CaseIterable, Identifiable {
  case desktop, timer, title, app, window, url
  var id: String { rawValue }

  var label: String {
    switch self {
    case .desktop: "Desktop"
    case .timer: "Time in Doing"
    case .title: "Task"
    case .app: "App"
    case .window: "Window title"
    case .url: "Browser address"
    }
  }

  var showKey: String {
    switch self {
    case .desktop: WidgetKey.desktop
    case .timer: WidgetKey.timer
    case .title: WidgetKey.task
    case .app: WidgetKey.app
    case .window: WidgetKey.title
    case .url: WidgetKey.url
    }
  }
  var alignKey: String { "widget.\(rawValue).align" }
  var sizeKey: String { "widget.\(rawValue).size" }

  /// Apple small-widget scale: one hero number, a body line, quieter captions.
  var defaultSize: Double {
    switch self {
    case .desktop: 10
    case .timer: 34
    case .title: 13
    case .app: 10.5
    case .window: 10
    case .url: 9
    }
  }
  var weight: Font.Weight {
    switch self {
    case .timer, .title, .desktop, .app: .semibold
    case .window, .url: .regular
    }
  }
  var defaultShown: Bool { self != .url }
  var sizeRange: ClosedRange<Double> { self == .timer ? 14...72 : 7...24 }

  static func registerDefaults() {
    var d: [String: Any] = [:]
    for p in allCases {
      d[p.showKey] = p.defaultShown
      d[p.alignKey] = WidgetAlign.center.rawValue
      d[p.sizeKey] = p.defaultSize
    }
    UserDefaults.standard.register(defaults: d)
  }
}

/// Live view of the per-element settings; republishes on any defaults change.
@MainActor
final class WidgetPrefs: ObservableObject {
  static let shared = WidgetPrefs()
  private var observer: NSObjectProtocol?

  private init() {
    WidgetPart.registerDefaults()
    observer = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.objectWillChange.send() }
    }
  }

  func shown(_ p: WidgetPart) -> Bool { UserDefaults.standard.bool(forKey: p.showKey) }
  func align(_ p: WidgetPart) -> WidgetAlign { WidgetAlign(rawValue: UserDefaults.standard.string(forKey: p.alignKey) ?? "") ?? .center }
  func size(_ p: WidgetPart) -> Double { UserDefaults.standard.double(forKey: p.sizeKey) }

  func showBinding(_ p: WidgetPart) -> Binding<Bool> {
    Binding(get: { self.shown(p) }, set: { UserDefaults.standard.set($0, forKey: p.showKey) })
  }
  func alignBinding(_ p: WidgetPart) -> Binding<WidgetAlign> {
    Binding(get: { self.align(p) }, set: { UserDefaults.standard.set($0.rawValue, forKey: p.alignKey) })
  }
  func sizeBinding(_ p: WidgetPart) -> Binding<Double> {
    Binding(get: { self.size(p) }, set: { UserDefaults.standard.set($0, forKey: p.sizeKey) })
  }
}
