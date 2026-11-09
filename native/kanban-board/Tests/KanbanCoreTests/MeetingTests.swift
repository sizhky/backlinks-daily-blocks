import XCTest
@testable import KanbanCore

final class MeetingTests: XCTestCase {
  let t0 = Date(timeIntervalSince1970: 1_800_000_000)
  func at(_ m: Double) -> Date { t0.addingTimeInterval(m * 60) }
  lazy var a = MeetingEvent(id: "A", title: "Standup", org: "PenguinAI", start: at(0), end: at(30), apps: [.teams])
  lazy var b = MeetingEvent(id: "B", title: "Review", org: "PenguinAI", start: at(30), end: at(60), apps: [.teams, .zoom])

  func testAppsComeFromLinksWithinTheCalendarsApps() {
    XCTAssertEqual(CallApp.linked([nil, "Join: https://teams.microsoft.com/l/meetup-join/x"]), [.teams])
    XCTAssertEqual(CallApp.linked(["Room 4", nil]), [])
    XCTAssertEqual(CallApp.apps(["https://meet.google.com/abc"], allowed: [.teams, .zoom]), [])
    XCTAssertEqual(CallApp.apps(["Room 4"], allowed: [.teams, .zoom]), [.teams, .zoom], "no link: any of the calendar's apps")
  }

  func testOnlyACallInTheEventsAppCounts() {
    var m = MeetingTracker()
    XCTAssertEqual(m.tick(now: at(1), calls: [.meet], events: [a]), [], "Meet call during a Teams meeting")
    XCTAssertEqual(m.tick(now: at(1), calls: [.teams], events: [a]), [.create(a)])
    m.record(a.key, file: "a.md", now: at(1))
    XCTAssertEqual(m.tick(now: at(2), calls: [.zoom], events: [a]), [], "a Zoom call does not hold a Teams meeting")
    XCTAssertEqual(m.tick(now: at(3.5), calls: [.zoom], events: [a]), [.finish(file: "a.md")])
  }

  func testNextIsRunningElseUpcoming() {
    XCTAssertEqual(MeetingEvent.next([b, a], now: at(10))?.key, a.key)
    XCTAssertEqual(MeetingEvent.next([b, a], now: at(30))?.key, b.key, "a ended at 30")
    XCTAssertNil(MeetingEvent.next([a, b], now: at(60)))
    XCTAssertEqual(a.when(at(-25)), "in 25m")
    XCTAssertEqual(a.when(at(-90)), "in 1h 30m")
    XCTAssertEqual(a.when(at(18)), "now · 12m left")
    XCTAssertEqual(a.when(at(30)), "ended")
  }

  func testPickUsesPaddedWindowAndLatestStart() {
    XCTAssertEqual(MeetingTracker.pick([a], now: at(-4))?.key, a.key, "call opened 4 min early")
    XCTAssertNil(MeetingTracker.pick([a], now: at(-6)))
    XCTAssertEqual(MeetingTracker.pick([a, b], now: at(31))?.key, b.key, "back-to-back picks the later one")
    XCTAssertEqual(MeetingTracker.pick([a], now: at(44))?.key, a.key, "overrun up to 15 min")
  }

  func testCallCreatesThenFinishesAfterGrace() {
    var m = MeetingTracker()
    XCTAssertEqual(m.tick(now: at(1), calls: [.teams], events: [a]), [.create(a)])
    m.record(a.key, file: "20270115-0800.md", now: at(1))
    XCTAssertEqual(m.tick(now: at(2), calls: [.teams], events: [a]), [])
    XCTAssertEqual(m.tick(now: at(10), calls: [], events: [a]), [], "silence starts the grace")
    XCTAssertEqual(m.tick(now: at(10.5), calls: [.teams], events: [a]), [], "a dropped call keeps the card")
    XCTAssertEqual(m.tick(now: at(20), calls: [], events: [a]), [])
    XCTAssertEqual(m.tick(now: at(21), calls: [], events: [a]), [.finish(file: "20270115-0800.md")])
    XCTAssertNil(m.current)
    XCTAssertEqual(m.tick(now: at(22), calls: [.teams], events: [a]), [.resume(file: "20270115-0800.md")], "rejoin reuses the card")
  }

  func testCallWithoutMeetingDoesNothingAndBackToBackSwitches() {
    var m = MeetingTracker()
    XCTAssertEqual(m.tick(now: at(-30), calls: [.teams], events: [a]), [])
    _ = m.tick(now: at(1), calls: [.teams], events: [a, b])
    m.record(a.key, file: "a.md", now: at(1))
    XCTAssertEqual(m.tick(now: at(31), calls: [.teams], events: [a, b]), [.finish(file: "a.md"), .create(b)])
  }

  func testRecordDropsOldMeetings() {
    var m = MeetingTracker()
    m.record(a.key, file: "a.md", now: at(1))
    m.record(b.key, file: "b.md", now: at(2 * 24 * 60))
    XCTAssertEqual(m.files, [b.key: "b.md"], "a started two days ago")
  }

  func testImpromptuSlackHuddleIsItsOwnCard() {
    var m = MeetingTracker()
    let org: [CallApp: String] = [.slack: "Divami"]
    XCTAssertEqual(m.tick(now: at(100), calls: [.slack], events: [a]), [], "no Slack org set: off")
    guard case .create(let h)? = m.tick(now: at(101), calls: [.slack], events: [a], impromptu: org).first else { return XCTFail() }
    XCTAssertEqual([h.title, h.org], ["Slack huddle", "Divami"]); XCTAssertEqual(h.apps, [.slack])
    m.record(h.key, file: "h.md", now: at(101))
    XCTAssertEqual(m.tick(now: at(110), calls: [.slack], events: [a], impromptu: org), [], "same huddle keeps its card")
    XCTAssertEqual(m.tick(now: at(111), calls: [], events: [a], impromptu: org), [])
    XCTAssertEqual(m.tick(now: at(112.5), calls: [], events: [a], impromptu: org), [.finish(file: "h.md")])
    guard case .create(let h2)? = m.tick(now: at(120), calls: [.slack], events: [a], impromptu: org).first else { return XCTFail() }
    XCTAssertNotEqual(h2.key, h.key, "a later huddle is a new card")
  }

  func testSlackLinkedEventBeatsImpromptu() {
    var m = MeetingTracker()
    let s = MeetingEvent(id: "S", title: "Sync", org: "Divami", start: at(0), end: at(30), apps: [.slack])
    XCTAssertEqual(CallApp.linked(["https://app.slack.com/huddle/T1/C2"]), [.slack])
    XCTAssertEqual(m.tick(now: at(1), calls: [.slack], events: [s], impromptu: [.slack: "Divami"]), [.create(s)])
  }
}
