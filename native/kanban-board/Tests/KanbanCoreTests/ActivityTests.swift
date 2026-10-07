import XCTest
@testable import KanbanCore

final class ActivityTests: XCTestCase {
  let t0 = Date(timeIntervalSince1970: 1_800_000_000)
  func at(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }
  let term = Sample(app: "iTerm2", bundle: "com.googlecode.iterm2", title: "penguin:api", space: 2)
  let mail = Sample(app: "Mail", bundle: "com.apple.mail", title: "Inbox", space: 3)

  func card(_ col: String, desktop: Int? = nil, project: String = "PenguinAI") -> Card {
    var c = Card(ref: "a.md:3", file: "a.md", line: 3, col: col, title: "Fix API", age: "1h", tags: [], orgs: [], projects: [project])
    c.desktop = desktop
    c.id = "a.md|Fix API"
    return c
  }

  func testSpanBuilderMergesEqualSamplesAndDropsShortSpans() {
    var b = SpanBuilder()
    XCTAssertNil(b.add(term, at: at(0)))
    XCTAssertNil(b.add(term, at: at(5)))
    let closed = b.add(mail, at: at(60))
    XCTAssertEqual(closed?.app, "iTerm2")
    XCTAssertEqual(closed?.end, at(60))
    XCTAssertNil(b.add(term, at: at(63)), "a 3 second Mail span is dropped")
  }

  func testSpanJSONLine() {
    let s = Span(start: at(0), end: at(60), app: "Safari", bundle: "com.apple.Safari", title: "Docs", url: "https://x.io/a", space: nil)
    XCTAssertTrue(s.jsonLine.contains(#""url":"https://x.io/a""#))
    XCTAssertFalse(s.jsonLine.contains("space"))
  }

  func testRuleNeedsEveryCondition() {
    XCTAssertTrue(ActivityRule(title: "PENGUIN", project: "PenguinAI").matches(term))
    XCTAssertFalse(ActivityRule(app: "com.apple.mail", title: "penguin", project: "PenguinAI").matches(term))
    XCTAssertFalse(ActivityRule(project: "PenguinAI").matches(term), "a rule with no condition matches nothing")
    XCTAssertEqual(ActivityRule.parse(Data(#"[{"project":"P","url":"jira"}]"#.utf8)).count, 1)
    XCTAssertEqual(ActivityRule.parse(Data("nope".utf8)), [])
  }

  func testLeavingTheDesktopParksAfterTheDelayStampedAtDeparture() {
    var e = SwitchEngine()
    XCTAssertEqual(e.step(now: at(0), context: term, contextSince: at(0), cards: [card("Doing", desktop: 2)], rules: []), [])
    XCTAssertEqual(e.step(now: at(100), context: mail, contextSince: at(30), cards: [card("Doing", desktop: 2)], rules: []), [], "90 s away is below the 120 s delay")
    let moves = e.step(now: at(160), context: mail, contextSince: at(30), cards: [card("Doing", desktop: 2)], rules: [])
    XCTAssertEqual(moves, [SwitchMove(ref: "a.md:3", title: "Fix API", column: "Parked", at: at(30))])
    XCTAssertEqual(e.step(now: at(170), context: mail, contextSince: at(30), cards: [card("Doing", desktop: 2)], rules: []), [], "one move per flip")
  }

  func testReturningResumesOnlyCardsTheEngineParked() {
    var e = SwitchEngine()
    _ = e.step(now: at(0), context: mail, contextSince: at(0), cards: [card("Doing", desktop: 2)], rules: [])
    _ = e.step(now: at(200), context: mail, contextSince: at(0), cards: [card("Doing", desktop: 2)], rules: [])
    XCTAssertEqual(e.step(now: at(305), context: term, contextSince: at(300), cards: [card("Parked", desktop: 2)], rules: []), [])
    XCTAssertEqual(e.step(now: at(311), context: term, contextSince: at(300), cards: [card("Parked", desktop: 2)], rules: []),
                   [SwitchMove(ref: "a.md:3", title: "Fix API", column: "Doing", at: at(300))])

    var fresh = SwitchEngine()
    _ = fresh.step(now: at(0), context: mail, contextSince: at(0), cards: [card("Parked", desktop: 2)], rules: [])
    XCTAssertEqual(fresh.step(now: at(30), context: term, contextSince: at(15), cards: [card("Parked", desktop: 2)], rules: []), [],
                   "a card parked by hand stays parked")
  }

  func testRulesGiveAffinityByProjectAndAwayParks() {
    var e = SwitchEngine()
    let rules = [ActivityRule(title: "penguin", project: "PenguinAI")]
    _ = e.step(now: at(0), context: term, contextSince: at(0), cards: [card("Doing")], rules: rules)
    let moves = e.step(now: at(400), context: nil, contextSince: at(200), cards: [card("Doing")], rules: rules)
    XCTAssertEqual(moves.first?.at, at(200), "away parks at the start of the idle time")
    XCTAssertEqual(e.step(now: at(500), context: nil, contextSince: at(200), cards: [card("Doing", project: "Other")], rules: rules), [],
                   "no desktop and no rule: never touched")
  }

  func testDesktopNumberCountsUserDesktopsAcrossDisplays() {
    let displays: [[String: Any]] = [
      ["Spaces": [["id64": 5, "type": 0], ["id64": 9, "type": 4], ["id64": 7, "type": 0]]],
      ["Spaces": [["id64": 11, "type": 0]]],
    ]
    XCTAssertEqual(Spaces.desktopNumber(active: 7, displays: displays), 2)
    XCTAssertEqual(Spaces.desktopNumber(active: 11, displays: displays), 3)
    XCTAssertNil(Spaces.desktopNumber(active: 9, displays: displays))
  }
}
