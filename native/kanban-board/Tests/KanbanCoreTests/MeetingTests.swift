import XCTest
@testable import KanbanCore

final class MeetingTests: XCTestCase {
  let t0 = Date(timeIntervalSince1970: 1_800_000_000)
  func at(_ m: Double) -> Date { t0.addingTimeInterval(m * 60) }
  lazy var a = MeetingEvent(id: "A", title: "Standup", org: "PenguinAI", start: at(0), end: at(30))
  lazy var b = MeetingEvent(id: "B", title: "Review", org: "PenguinAI", start: at(30), end: at(60))

  func testIsTeamsReadsLinkInAnyField() {
    XCTAssertTrue(MeetingEvent.isTeams([nil, "Join: https://teams.microsoft.com/l/meetup-join/x"]))
    XCTAssertFalse(MeetingEvent.isTeams(["Room 4", nil]))
  }

  func testPickUsesPaddedWindowAndLatestStart() {
    XCTAssertEqual(MeetingTracker.pick([a], now: at(-4))?.key, a.key, "call opened 4 min early")
    XCTAssertNil(MeetingTracker.pick([a], now: at(-6)))
    XCTAssertEqual(MeetingTracker.pick([a, b], now: at(31))?.key, b.key, "back-to-back picks the later one")
    XCTAssertEqual(MeetingTracker.pick([a], now: at(44))?.key, a.key, "overrun up to 15 min")
  }

  func testCallCreatesThenFinishesAfterGrace() {
    var m = MeetingTracker()
    XCTAssertEqual(m.tick(now: at(1), inCall: true, events: [a]), [.create(a)])
    m.record(a.key, file: "20270115-0800.md", now: at(1))
    XCTAssertEqual(m.tick(now: at(2), inCall: true, events: [a]), [])
    XCTAssertEqual(m.tick(now: at(10), inCall: false, events: [a]), [], "silence starts the grace")
    XCTAssertEqual(m.tick(now: at(10.5), inCall: true, events: [a]), [], "a dropped call keeps the card")
    XCTAssertEqual(m.tick(now: at(20), inCall: false, events: [a]), [])
    XCTAssertEqual(m.tick(now: at(21), inCall: false, events: [a]), [.finish(file: "20270115-0800.md")])
    XCTAssertNil(m.current)
    XCTAssertEqual(m.tick(now: at(22), inCall: true, events: [a]), [.resume(file: "20270115-0800.md")], "rejoin reuses the card")
  }

  func testCallWithoutMeetingDoesNothingAndBackToBackSwitches() {
    var m = MeetingTracker()
    XCTAssertEqual(m.tick(now: at(-30), inCall: true, events: [a]), [])
    _ = m.tick(now: at(1), inCall: true, events: [a, b])
    m.record(a.key, file: "a.md", now: at(1))
    XCTAssertEqual(m.tick(now: at(31), inCall: true, events: [a, b]), [.finish(file: "a.md"), .create(b)])
  }

  func testRecordDropsOldMeetings() {
    var m = MeetingTracker()
    m.record(a.key, file: "a.md", now: at(1))
    m.record(b.key, file: "b.md", now: at(2 * 24 * 60))
    XCTAssertEqual(m.files, [b.key: "b.md"], "a started two days ago")
  }
}
