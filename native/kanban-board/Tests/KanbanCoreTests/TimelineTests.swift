import XCTest
@testable import KanbanCore

final class TimelineTests: XCTestCase {
  func testParseSkipsBadLinesAndSorts() {
    let text = """
    {"app":"B","bundle":"b","end":"2026-10-07T10:06:00Z","start":"2026-10-07T10:05:00Z","title":"t"}
    {"app":"A","bundle":"a","end":"2026-10-07T10:05:00Z","start":"2026-10-07T10:00:00Z","title":"t","space":2,"desktop":"Personal"}
    {"app":"C","bund
    """
    let spans = ActivityLog.parse(Data(text.utf8))
    XCTAssertEqual(spans.map(\.app), ["A", "B"])
    XCTAssertEqual(spans[0].desktop, "Personal")
  }

  func testRowsInsertAwayForLongGapsOnly() {
    let t = Date(timeIntervalSince1970: 0)
    func s(_ a: Double, _ b: Double) -> Span { Span(start: t + a, end: t + b, app: "A", bundle: "a", title: "") }
    let rows = ActivityLog.rows([s(0, 300), s(330, 400), s(520, 600)])
    XCTAssertEqual(rows.count, 4)
    XCTAssertEqual(rows[2], .away(start: t + 400, end: t + 520))
    XCTAssertEqual(ActivityLog.totals([s(0, 300), s(330, 400)]).first?.seconds, 370)
  }

  func testStintsParseChronicleRows() {
    let day = Calendar.current.startOfDay(for: Date(timeIntervalSince1970: 1_800_000_000))
    let out = ActivityLog.stints("=> \n0930:1015\t45m\tFix API\n1100:1138~\t38m\tReview\nTOTAL\t1h23m\t5% elapsed", day: day)
    XCTAssertEqual(out.map(\.title), ["Fix API", "Review"])
    XCTAssertEqual(out[0].end.timeIntervalSince(out[0].start), 45 * 60)
    XCTAssertTrue(out[1].open)
  }

  func testUnionSecondsMergesOverlaps() {
    let t = Date(timeIntervalSince1970: 0)
    XCTAssertEqual(ActivityLog.unionSeconds([(t, t + 10), (t + 5, t + 20), (t + 30, t + 40)]), 30)
  }

  func testBlocksMergeSameAppWithinGap() {
    let t = Date(timeIntervalSince1970: 0)
    func s(_ app: String, _ a: Double, _ b: Double, _ title: String = "") -> Span { Span(start: t + a, end: t + b, app: app, bundle: app, title: title) }
    let out = ActivityLog.blocks([s("Arc", 0, 300, "Docs"), s("Arc", 300, 540, "YouTube"), s("Mail", 540, 600), s("Arc", 700, 760)])
    XCTAssertEqual(out.map(\.app), ["Arc", "Mail", "Arc"])
    XCTAssertEqual(out[0].end, t + 540)
    XCTAssertEqual(out[0].title, "Docs")
    XCTAssertEqual(out[0].spans, 2)
  }

  func testSessionsJoinContinuousBlocksAndPickTheMostUsedApp() {
    let t = Date(timeIntervalSince1970: 0)
    func b(_ app: String, _ a: Double, _ e: Double) -> ActivityBlock { ActivityBlock(start: t + a, end: t + e, app: app, bundle: app, title: app + " w", spans: 1) }
    let out = ActivityLog.sessions([b("Arc", 0, 600), b("Mail", 600, 720), b("Arc", 720, 780), b("Arc", 1800, 1860)])
    XCTAssertEqual(out.count, 2)
    XCTAssertEqual(out[0].app, "Arc")
    XCTAssertEqual(out[0].apps, 2)
    XCTAssertEqual(out[0].end, t + 780)
  }

  func testLanesPlaceOverlapsSideBySide() {
    let t = Date(timeIntervalSince1970: 0)
    let r = ActivityLog.lanes([(t, t + 10), (t + 5, t + 15), (t + 20, t + 30), (t + 12, t + 18)])
    XCTAssertEqual(r.lane, [0, 1, 0, 0])
    XCTAssertEqual(r.of, [2, 2, 1, 2])
  }
}
