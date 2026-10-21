import XCTest
@testable import KanbanCore

final class CycleTests: XCTestCase {
  var cal: Calendar = { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "UTC")!; return c }()
  func at(_ day: Int, _ h: Int, _ m: Int = 0) -> Date { cal.date(from: DateComponents(year: 2026, month: 10, day: day, hour: h, minute: m))! }
  func card(_ ref: String, _ stints: [(Date, Date)], adhoc: Bool = false, done: Date? = nil) -> ReportCard {
    ReportCard(ref: ref, title: ref, adhoc: adhoc, doneAt: done, lifetime: 1, stints: stints.map { DateInterval(start: $0.0, end: $0.1) })
  }

  func testNightBuildStaysInOneCycle() {
    XCTAssertEqual(Cycle.start(of: at(20, 1, 30), calendar: cal), at(19, 2))
    XCTAssertEqual(Cycle.start(of: at(20, 2), calendar: cal), at(20, 2))
    XCTAssertEqual(Cycle.cycles(from: at(18, 12), to: at(20, 12), calendar: cal).map(\.start), [at(18, 2), at(19, 2), at(20, 2)])
  }

  func testParallelCardsCountWallTimeAndAdhocOverlapGoesToPlanned() {
    let cycles = Cycle.cycles(from: at(19, 12), to: at(19, 12), calendar: cal)
    let out = Cycle.stats(cards: [card("20261019-0900.md:1", [(at(19, 10), at(19, 11))]),
                                  card("20261019-0901.md:1", [(at(19, 10, 30), at(19, 11, 30))], adhoc: true)], cycles: cycles)
    XCTAssertEqual(out[0].planned, 3600)
    XCTAssertEqual(out[0].adhoc, 1800)
  }

  func testScopeSplitsAddedFromCarriedInAndTracksDoneAndCarriedOut() {
    let cycles = Cycle.cycles(from: at(19, 12), to: at(19, 12), calendar: cal)
    let old = card("20261015-0900.md:1", [(at(19, 10), at(19, 11))])
    let fresh = card("20261019-0930.md:1", [(at(19, 12), at(19, 13))], done: at(19, 13))
    let s = Cycle.stats(cards: [old, fresh], cycles: cycles)[0]
    XCTAssertEqual([s.scope, s.carriedIn, s.added, s.done, s.carriedOut], [2, 1, 1, 1, 1])
  }

  func testCarriedCountsCyclesAnOpenCardWasTouched() {
    let cycles = Cycle.cycles(from: at(17, 12), to: at(20, 12), calendar: cal)
    let stuck = card("a.md:1", cycles.map { ($0.start.addingTimeInterval(3600), $0.start.addingTimeInterval(7200)) })
    let shipped = card("b.md:1", cycles.prefix(3).map { ($0.start.addingTimeInterval(3600), $0.start.addingTimeInterval(7200)) },
                       done: cycles[2].start.addingTimeInterval(7200))
    let out = Cycle.carried(cards: [shipped, stuck], cycles: cycles)
    XCTAssertEqual(out.map(\.count), [4, 2])
    XCTAssertEqual(out.first?.card.ref, "a.md:1")
  }
}
