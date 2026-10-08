import AppKit
import KanbanCore
import SwiftUI

/// Where a drag lands: before card `before` (a ref), or at the end of `column` when nil.
struct DragSlot: Equatable {
  var column: String
  var before: String?
}

/// Frames in the board coordinate space, written by views as they lay out. Not observed, so
/// measuring never redraws anything. Cards are keyed by `Card.id`, which survives line shifts.
final class FrameRegistry {
  var columns: [String: CGRect] = [:]
  var cards: [String: CGRect] = [:]
  var ghost: CGRect?
  /// Board ghosts by column. A ghost leaving a column fades out and keeps reporting its frame,
  /// so one shared slot sent drops back to the home column; the drop reads the slot column's own.
  var ghosts: [String: CGRect] = [:]
  /// The view that last appeared for each key; only it may write or clear that key.
  var owners: [AnyKeyPath: [String: UUID]] = [:]
}

/// Cursor-rate state; only the floating card observes it.
@MainActor
final class DragPointer: ObservableObject {
  @Published var origin: CGPoint = .zero
}

/// One column's rows during (or outside) a drag: a card, or the ghost when `card` is nil.
struct DragRow: Identifiable {
  let id: String
  let card: Card?
}

/// In-app card drag. A board-level DragGesture moves a floating copy of the card at mouse rate,
/// and hit testing reads `frames` in the same event, so the ghost moves in the frame the cursor
/// does. Drop animates the floating card onto the ghost, then swaps in the real card with no
/// animation. Across columns the ghost sits at the end; within the home column, or with Cmd
/// held, it follows the cursor height.
@MainActor
final class DragController: ObservableObject {
  struct Session {
    let refs: [String]
    let card: Card
    let home: String
    let grab: CGSize
    let size: CGSize
    let origin: CGPoint
  }

  static let space = "board"
  static let spring = Animation.spring(duration: 0.24, bounce: 0.1)

  @Published private(set) var session: Session?
  @Published private(set) var slot: DragSlot?
  let pointer = DragPointer()
  let frames = FrameRegistry()
  weak var store: BoardStore?
  private var location: CGPoint = .zero
  private var ignoring = false
  private var settling = false
  private var monitor: Any?

  func changed(_ value: DragGesture.Value) {
    guard !settling else { return }
    if session == nil {
      guard !ignoring else { return }
      guard begin(at: value.startLocation) else { ignoring = true; return }
    }
    location = value.location
    if let s = session { pointer.origin = CGPoint(x: location.x - s.grab.width, y: location.y - s.grab.height) }
    retarget()
  }

  func ended() {
    ignoring = false
    guard session != nil, !settling else { return }
    settling = true
    guard let column = slot?.column, let dest = frames.ghosts[column]?.origin else { return finish() }
    withAnimation(Self.spring, completionCriteria: .logicallyComplete) { pointer.origin = dest } completion: { self.finish() }
  }

  /// Recomputes the slot from the last cursor position: on move, Cmd change, and autoscroll.
  func retarget() {
    guard let s = session, !settling, let store, let next = hit(location, s, store), next != slot else { return }
    withAnimation(Self.spring) { slot = next }
  }

  /// The column's rows with carried cards removed and the ghost where the slot is.
  func rows(_ column: Column, _ store: BoardStore) -> [DragRow] {
    let cards = store.ordered(column)
    guard let s = session else { return cards.map { DragRow(id: $0.id, card: $0) } }
    let byRef = Dictionary(cards.map { ($0.ref, $0) }, uniquingKeysWith: { a, _ in a })
    let items = DragLayout.items(order: cards.map(\.ref), carried: Set(s.refs),
                                 target: slot?.column == column.name, before: slot?.before)
    return items.compactMap { item in
      switch item {
      case .ghost: return DragRow(id: "ghost", card: nil)
      case .card(let ref): return byRef[ref].map { DragRow(id: $0.id, card: $0) }
      }
    }
  }

  private func begin(at p: CGPoint) -> Bool {
    guard let store, let (id, rect) = frames.cards.first(where: { $0.value.contains(p) }).map({ ($0.key, $0.value) }),
          let card = store.columns.lazy.flatMap(\.cards).first(where: { $0.id == id }) else { return false }
    let refs = store.picked.contains(card.ref) ? store.shownRefs.filter(store.picked.contains) : [card.ref]
    session = Session(refs: refs, card: card, home: card.col, grab: CGSize(width: p.x - rect.minX, height: p.y - rect.minY),
                      size: rect.size, origin: rect.origin)
    pointer.origin = rect.origin
    slot = DragSlot(column: card.col, before: card.ref)
    store.dragActive = true
    monitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
      self?.retarget()
      return event
    }
    return true
  }

  /// Ghost position in `column` at height `y`: the end across columns, the cursor height at home
  /// or with Cmd. Nil outside every column, which keeps the last slot (gaps between columns).
  private func hit(_ p: CGPoint, _ s: Session, _ store: BoardStore) -> DragSlot? {
    guard let name = frames.columns.first(where: { $0.value.contains(p) })?.key,
          let column = store.visible.first(where: { $0.name == name }) else { return nil }
    guard name == s.home || NSEvent.modifierFlags.contains(.command) else { return DragSlot(column: name, before: nil) }
    let cards = store.ordered(column)
    var mid: [String: Double] = [:]
    for c in cards { if let f = frames.cards[c.id] { mid[c.ref] = f.midY } }
    return DragSlot(column: name, before: Ranking.slot(order: cards.map(\.ref), dragging: Set(s.refs),
                                                       grabbed: s.card.ref, midY: mid, y: p.y))
  }

  /// Writes the move and swaps the ghost for the real card in one frame with no animation.
  private func finish() {
    if let s = session, let slot, let store, let column = store.visible.first(where: { $0.name == slot.column }) {
      // A carried ref as `before` is the grabbed card's home: land before the next card that stays.
      let order = store.ordered(column).map(\.ref)
      var before = slot.before
      if let b = before, s.refs.contains(b) {
        before = order.firstIndex(of: b).flatMap { i in order[i...].first { !s.refs.contains($0) } }
      }
      let unchanged = s.refs == [s.card.ref] && slot.column == s.home && slot.before == s.card.ref
      var t = Transaction()
      t.disablesAnimations = true
      withTransaction(t) {
        if !unchanged { store.place(s.refs, before: before, in: column) }
        session = nil
        self.slot = nil
      }
    } else {
      session = nil
      slot = nil
    }
    store?.dragActive = false
    settling = false
    if let monitor { NSEvent.removeMonitor(monitor) }
    monitor = nil
  }
}

extension View {
  /// Records this view's frame in the board space under `key` (`Card.id` or a column name).
  func dragFrame(_ key: String, in table: ReferenceWritableKeyPath<FrameRegistry, [String: CGRect]>,
                 _ frames: FrameRegistry) -> some View {
    modifier(DragFrame(key: key, table: table, frames: frames))
  }
}

/// A card moved by an animated refresh has two views for one key: the old one fading out and the new
/// one. The old view's late `onDisappear` used to clear the new view's frame, so the card could not be
/// dragged. The newest view owns the key; writes and clears from any other view are ignored.
private struct DragFrame: ViewModifier {
  let key: String
  let table: ReferenceWritableKeyPath<FrameRegistry, [String: CGRect]>
  let frames: FrameRegistry
  @State private var token = UUID()
  @State private var last: CGRect?

  private var owns: Bool { frames.owners[table]?[key] == token }

  func body(content: Content) -> some View {
    content
      .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(DragController.space)) } action: { rect in
        last = rect
        if owns || frames.owners[table]?[key] == nil { frames[keyPath: table][key] = rect }
      }
      .onAppear {
        frames.owners[table, default: [:]][key] = token
        if let last { frames[keyPath: table][key] = last }
      }
      .onDisappear {
        guard owns else { return }
        frames.owners[table]?[key] = nil
        frames[keyPath: table][key] = nil
      }
  }
}

/// The card under the cursor while dragging, drawn by the app at mouse rate.
struct FloatingCard: View {
  @EnvironmentObject var store: BoardStore
  @EnvironmentObject var drag: DragController
  @ObservedObject var pointer: DragPointer

  var body: some View {
    if let s = drag.session {
      Group {
        if store.mode == .board { IssueCard(card: s.card) } else { IssueRow(card: s.card) }
      }
      .frame(width: s.size.width, height: s.size.height)
      .overlay(alignment: .topTrailing) {
        if s.refs.count > 1 {
          Text("\(s.refs.count)").font(.system(size: 11, weight: .semibold).monospacedDigit()).foregroundStyle(.white)
            .padding(.horizontal, 6).padding(.vertical, 2).background(Palette.indigo, in: .capsule).offset(x: 6, y: -6)
        }
      }
      .shadow(color: .black.opacity(0.45), radius: 12, y: 6)
      .offset(x: pointer.origin.x, y: pointer.origin.y)
      .allowsHitTesting(false)
    }
  }
}
