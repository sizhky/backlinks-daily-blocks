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
}
