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
    XCTAssertNil(out[0].ref)
    XCTAssertEqual(ActivityLog.stints("0930:1015\t45m\tFix API\t20261007-1045.md:7", day: day).first?.ref, "20261007-1045.md:7")
    XCTAssertEqual(ActivityLog.stints("0930:1015\t45m\tFix API\t20261007-1045.md:7\tKanban App", day: day).first?.project, "Kanban App")
    XCTAssertEqual(ActivityLog.stints("0930:1015\t45m\tFix API\t20261007-1045.md:7\t\t202610070930", day: day).first?.enter, "202610070930")
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

  func testImputeFillsShortGapsOnly() {
    let t = Date(timeIntervalSince1970: 0)
    func s(_ a: Double, _ b: Double) -> Span { Span(start: t + a, end: t + b, app: "A", bundle: "a", title: "") }
    let out = ActivityLog.impute([s(0, 300), s(320, 400), s(600, 700)])
    XCTAssertEqual(out[0].end, t + 320, "20 s gap carried forward")
    XCTAssertEqual(out[1].end, t + 400, "200 s gap is real absence")
  }

  func testStintsByDaySplitsChronicleSections() {
    let text = "=> \n== 20261005 ==\n0900:1000\t1h\tA\nTOTAL\t1h\t4%\n== 20261006 ==\n(none)\nTOTAL\t0m\t0%\n== total ==\nTOTAL\t1h\t2%"
    let out = ActivityLog.stintsByDay(text)
    XCTAssertEqual(out["20261005"]?.map(\.title), ["A"])
    XCTAssertEqual(out["20261006"]?.count, 0)
    XCTAssertNil(out["total"])
  }

  func testDraggedEdgeSnapsToMinutesAndKeepsOrder() {
    let t0 = Date(timeIntervalSince1970: 36000)
    let st = DoingStint(start: t0, end: t0.addingTimeInterval(3600), title: "a", open: false)
    let now = t0.addingTimeInterval(7200)
    XCTAssertEqual(st.dragged(.end, to: t0.addingTimeInterval(20), now: now), t0.addingTimeInterval(60))
    XCTAssertEqual(st.dragged(.start, to: t0.addingTimeInterval(5400), now: now), t0.addingTimeInterval(3540))
    XCTAssertEqual(st.dragged(.end, to: t0.addingTimeInterval(10800), now: now), now)
    XCTAssertEqual(st.dragged(.start, to: t0.addingTimeInterval(-89), now: now), t0.addingTimeInterval(-60))
    XCTAssertEqual(st.with(.end, at: now).end, now)
  }

  func testActiveStretchesSplitAtMidnightAndClipToTheirStint() {
    var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "UTC")!
    let t0 = Date(timeIntervalSince1970: 1_760_140_800)  // 2025-10-11 00:00 UTC
    func at(_ m: Double) -> Date { t0.addingTimeInterval(m * 60) }
    let night = ActiveStretch(ref: "a.md:1", title: "A", start: at(-10), end: at(10))
    XCTAssertEqual(ActivityLog.splitByDay(night, calendar: cal).map { [$0.start, $0.end] }, [[at(-10), at(0)], [at(0), at(10)]])
    let line: [ActiveStretch] = ActivityLog.parseLines(Data((night.jsonLine + "\nbad\n").utf8))
    XCTAssertEqual(line, [night])
    XCTAssertEqual(night.fileName, ActiveStretch.fileName(night.start))
    XCTAssertTrue(BreakSpan.fileName(t0).hasSuffix("-breaks.jsonl"))
    let stint = DoingStint(start: at(600), end: at(660), title: "A", open: false, ref: "a.md:3")
    let stretches = [ActiveStretch(ref: "a.md:1", title: "A", start: at(590), end: at(620)),
                     ActiveStretch(ref: "b.md:1", title: "B", start: at(625), end: at(630)),
                     ActiveStretch(ref: "a.md:3", title: "renamed", start: at(640), end: .distantFuture)]
    let parts = ActivityLog.activeParts(of: stint, in: stretches, now: at(650))
    XCTAssertEqual(parts.map { [$0.start, $0.end] }, [[at(600), at(620)], [at(640), at(650)]])
  }

  func testBreakShareClipsToTheDayAndCountsTheRunningBreak() {
    let t0 = Date(timeIntervalSince1970: 1_760_000_000)
    func at(_ m: Double) -> Date { t0.addingTimeInterval(m * 60) }
    let breaks = [BreakSpan(start: at(-10), end: at(10)), BreakSpan(start: at(60), end: .distantFuture)]
    XCTAssertEqual(ActivityLog.breakShare(breaks, from: at(0), now: at(120)), 70.0 / 120, accuracy: 1e-9)
    XCTAssertEqual(ActivityLog.breakShare([], from: at(0), now: at(0)), 0)
  }
}
