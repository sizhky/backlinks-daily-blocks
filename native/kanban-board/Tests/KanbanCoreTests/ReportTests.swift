import XCTest
@testable import KanbanCore

final class ReportTests: XCTestCase {
  var cal: Calendar = { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "UTC")!; return c }()
  let t0 = Date(timeIntervalSince1970: 1_800_000_000 - 1_800_000_000.truncatingRemainder(dividingBy: 3600))  // on the hour
  func at(_ min: Double) -> Date { t0.addingTimeInterval(min * 60) }
  func span(_ a: Double, _ b: Double, space: Int = 2, desktop: String? = nil, title: String = "x") -> Span {
    Span(start: at(a), end: at(b), app: "iTerm2", bundle: "com.googlecode.iterm2", title: title, space: space, desktop: desktop)
  }
  func card(_ ref: String, _ a: Double, _ b: Double, org: String = "Divami", project: [String] = ["P"], desktop: String? = nil) -> ReportCard {
    ReportCard(ref: ref, title: ref, orgs: [org], projects: project, desktop: desktop, stints: [DateInterval(start: at(a), end: at(b))])
  }
  func minutes(_ out: [Allocation], _ target: Allocation.Target, project: String? = nil) -> Double {
    out.filter { $0.target == target && (project == nil || $0.project == project) }.reduce(0) { $0 + $1.seconds } / 60
  }

  func testOneActiveCardTakesActiveTimeOnly() {
    let out = Report.attribute(spans: [span(0, 30)], cards: [card("a", 0, 60), card("b", 10, 60)], rules: [], calendar: cal)
    XCTAssertEqual(minutes(out, .card("a")), 10, "a alone until b enters Doing")
    XCTAssertEqual(minutes(out, .card("b")), 20, "the card that entered Doing last is active")
  }

  func testFocusPrefersOwnersThenNoAffinityThenLatest() {
    XCTAssertEqual(Focus.pick([(0, at(0), true), (1, at(30), true)]), 1)
    XCTAssertEqual(Focus.pick([(0, at(0), true), (1, at(30), nil)]), 0)
    XCTAssertEqual(Focus.pick([(0, at(0), false), (1, at(30), nil)]), 1)
    XCTAssertNil(Focus.pick([(0, at(0), false)]))
  }

  func testPinBeatsRulesOnItsDesktopOnly() {
    func card(_ ref: String, _ since: Double) -> Card {
      var c = Card(ref: ref, file: "f.md", line: 0, col: "Doing", title: ref, age: "1h", tags: [], orgs: [], projects: [])
      c.since = at(since)
      return c
    }
    let cards = [card("a", 0), card("b", 30)]
    let u1 = Sample(app: "X", bundle: "x", title: "", uuid: "U1"), u2 = Sample(app: "X", bundle: "x", title: "", uuid: "U2")
    let pin = FocusPin(id: "a", context: u1)
    XCTAssertEqual(Focus.active(cards, context: u1, rules: [])?.id, "b")
    XCTAssertEqual(Focus.active(cards, context: u1, rules: [], pin: pin)?.id, "a")
    XCTAssertEqual(Focus.active(cards, context: u2, rules: [], pin: pin)?.id, "b")
    XCTAssertNil(Focus.active(cards, context: nil, rules: [], pin: pin))
    XCTAssertEqual(Focus.active([card("b", 30)], context: u1, rules: [], pin: pin)?.id, "b")
  }

  func testActiveClockCreditsTicksCapsGapsAndRetractsIdle() {
    var c = ActiveClock()
    c.tick(now: at(0), active: "a")
    c.tick(now: at(0.1), active: "a")
    c.tick(now: at(0.2), active: "b")
    XCTAssertEqual(c.pending["a"] ?? 0, 12, accuracy: 0.01)
    c.tick(now: at(60), active: "b")
    XCTAssertEqual(c.pending["b"] ?? 0, 15, accuracy: 0.01, "a gap is capped at maxStep")
    var idle = ActiveClock()
    for s in stride(from: 0.0, through: 300, by: 6) { idle.tick(now: t0.addingTimeInterval(s), active: "a") }
    idle.tick(now: t0.addingTimeInterval(306), active: nil, awaySince: t0.addingTimeInterval(6))
    XCTAssertEqual(idle.pending["a"] ?? 0, 6, accuracy: 0.01, "time after the idle start is taken back")
    XCTAssertEqual(idle.take(), ["a": 6])
    XCTAssertEqual(idle.unwritten("a", now: t0.addingTimeInterval(400)), 0, accuracy: 0.01)
  }

  func testOwnerTakesTheSpanAndForeignContextIsUnattributed() {
    let cards = [card("a", 0, 60, desktop: "2"), card("b", 0, 60, desktop: "3")]
    let out = Report.attribute(spans: [span(0, 10, space: 2)], cards: cards, rules: [], calendar: cal)
    XCTAssertEqual(minutes(out, .card("a")), 10)
    XCTAssertEqual(minutes(out, .card("b")), 0)
    let away = Report.attribute(spans: [span(0, 10, space: 4)], cards: cards, rules: [], calendar: cal)
    XCTAssertEqual(minutes(away, .unattributed), 10)
  }

  func testProjectDesktopCreditsNoCardTime() {
    let rules = [ActivityRule(desktop: "PenguinAI", project: "Penguin")]
    let out = Report.attribute(spans: [span(0, 20, space: 5, desktop: "PenguinAI")], cards: [card("a", 30, 60, org: "Divami", project: ["Penguin"])],
                               rules: rules, calendar: cal)
    XCTAssertEqual(minutes(out, .noCard, project: "Penguin"), 20)
    XCTAssertEqual(out.first?.org, "Divami", "the project's org comes from its cards")
  }

  func testCardSplitsAcrossProjectsAndHours() {
    let out = Report.attribute(spans: [span(50, 70)], cards: [card("a", 0, 120, project: ["P", "Q"])], rules: [], calendar: cal)
    XCTAssertEqual(minutes(out, .card("a"), project: "P"), 10)
    XCTAssertEqual(minutes(out, .card("a"), project: "Q"), 10)
    XCTAssertEqual(Set(out.map(\.hour)).count, 2, "time is bucketed per hour")
  }

  func testCardDesktopBeatsProjectDesktopAndProjectBeatsOrg() {
    let rules = [ActivityRule(desktop: "3", project: "P"), ActivityRule(desktop: "4", org: "Divami")]
    XCTAssertEqual(SwitchEngine.owns(desktop: "2", orgs: ["Divami"], projects: ["P"], Sample(app: "a", bundle: "a", title: "", space: 3), rules), false)
    XCTAssertEqual(SwitchEngine.owns(desktop: nil, orgs: ["Divami"], projects: ["P"], Sample(app: "a", bundle: "a", title: "", space: 3), rules), true)
    XCTAssertEqual(SwitchEngine.owns(desktop: nil, orgs: ["Divami"], projects: ["P"], Sample(app: "a", bundle: "a", title: "", space: 4), rules), false)
    XCTAssertEqual(SwitchEngine.owns(desktop: nil, orgs: ["Divami"], projects: ["Q"], Sample(app: "a", bundle: "a", title: "", space: 4), rules), true)
  }

  func testCardDesktopFallsBackToProjectThenOrgPin() {
    var rules = DesktopPin.setting([], kind: .org, name: "O", desktop: "4")
    XCTAssertEqual(DesktopPin.desktop(own: nil, orgs: ["o"], projects: ["P"], rules), "4")
    rules = DesktopPin.setting(rules, kind: .project, name: "P", desktop: "3")
    XCTAssertEqual(DesktopPin.desktop(own: nil, orgs: ["O"], projects: ["p"], rules), "3")
    XCTAssertEqual(DesktopPin.desktop(own: "2", orgs: ["O"], projects: ["P"], rules), "2")
    XCTAssertNil(DesktopPin.desktop(own: nil, orgs: ["X"], projects: ["Y"], rules))
  }

  func testDesktopPinsRoundTripAndKeepOtherRules() {
    let url = ActivityRule(url: "jira", org: "Divami")
    var rules = DesktopPin.setting([url], kind: .project, name: "P", desktop: "2")
    rules = DesktopPin.setting(rules, kind: .project, name: "p", desktop: "PenguinAI")
    XCTAssertEqual(DesktopPin.pins(rules), [DesktopPin(kind: .project, name: "p", desktop: "PenguinAI")])
    XCTAssertEqual(DesktopPin.setting(rules, kind: .project, name: "P", desktop: nil), [url])
    XCTAssertEqual(ActivityRule.parse(ActivityRule.encode(rules)), rules)
  }

  func testParseReportCards() {
    let text = "=> \na.md:3\tFix\tDivami\tP|Q\t2\t1\t-\t600\t100-400,500-800\nb.md:1\tShip\t\t\t\t-\t900\t0\t"
    let cards = ReportCard.parse(text)
    XCTAssertEqual(cards.map(\.ref), ["a.md:3", "b.md:1"])
    XCTAssertEqual(cards[0].projects, ["P", "Q"])
    XCTAssertEqual(cards[0].adhoc, true)
    XCTAssertEqual(cards[0].stints.count, 2)
    XCTAssertTrue(cards[1].untracked)
    XCTAssertNil(cards[1].adhoc)
  }

  func testTreeRollsUpAndListsUntrackedCards() {
    let a = ReportCard(ref: "a", title: "A", orgs: ["Divami"], projects: ["P"], adhoc: true, stints: [DateInterval(start: at(0), end: at(60))])
    let b = ReportCard(ref: "b", title: "B", orgs: ["Divami"], projects: ["P"], doneAt: at(5), lifetime: 0)
    let out = Report.attribute(spans: [span(0, 30)], cards: [a, b], rules: [], calendar: cal)
      + [Allocation(hour: t0, org: "", project: "", target: .unattributed, seconds: 600)]
    let tree = Report.tree(out, cards: [a, b])
    XCTAssertEqual(tree.map(\.kind), [.org, .unattributed])
    XCTAssertEqual(tree[0].seconds, 1800)
    XCTAssertEqual(tree[0].adhoc, ["a"])
    XCTAssertEqual(tree[0].untracked, ["b"])
    XCTAssertEqual(tree[0].children[0].children.map(\.ref), ["a", "b"])
    let series = Report.series(out, org: nil) { $0 }
    XCTAssertEqual(series.map(\.unattributed).sorted { !$0 && $1 }, [false, true])
    XCTAssertEqual(Report.series(out, org: "divami") { $0 }.map(\.name), ["P"])
  }

  func testUnnamedSpansTakeTheCurrentDesktopName() {
    let cards = [card("a", 0, 60, desktop: "Trading")]
    let spans = [span(0, 20, space: 5)]
    XCTAssertEqual(minutes(Report.attribute(spans: spans, cards: cards, rules: [], calendar: cal), .card("a")), 0)
    XCTAssertEqual(minutes(Report.attribute(spans: spans, cards: cards, rules: [], labels: [5: "Trading"], calendar: cal), .card("a")), 20)
    // Desktops reordered: the span's UUID names it, and number 5 now belongs to another desktop.
    var moved = span(0, 20, space: 5)
    moved.uuid = "T"
    XCTAssertEqual(minutes(Report.attribute(spans: [moved], cards: cards, rules: [], labels: [5: "Infoshare"],
                                            names: ["T": "Trading"], calendar: cal), .card("a")), 20)
  }

  func testCardsWithDoingTimeButNoAttributionStayInTheTree() {
    let a = card("a", 0, 60, desktop: "3")
    let out = Report.attribute(spans: [span(0, 30, space: 2)], cards: [a], rules: [], calendar: cal)
    let leaf = Report.tree(out, cards: [a]).first { $0.kind == .org }?.children.first?.children.first
    XCTAssertEqual(leaf?.ref, "a")
    XCTAssertEqual(leaf?.seconds, 0)
    XCTAssertEqual(leaf?.doing, 3600)
  }
}
