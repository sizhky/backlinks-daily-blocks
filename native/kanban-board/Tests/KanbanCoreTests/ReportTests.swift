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
    XCTAssertEqual(Focus.active(cards, context: u2, rules: [], pin: pin, call: "a")?.id, "a", "a call card wins on any desktop")
    XCTAssertEqual(Focus.active([card("b", 30)], context: u1, rules: [], call: "a")?.id, "b", "a call card out of Doing does not")

    var moving = FocusPin(id: "a", context: u1, to: "U2")
    XCTAssertEqual(Focus.active(cards, context: u1, rules: [], pin: moving)?.id, "a")
    moving.arrive(u2)
    XCTAssertEqual(Focus.active(cards, context: u2, rules: [], pin: moving)?.id, "a")
    XCTAssertEqual(Focus.active(cards, context: u1, rules: [], pin: moving)?.id, "b")
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

  func testActiveClockWaitsBeforeAnotherCardTakesOver() {
    let t = { [t0] (s: Double) in t0.addingTimeInterval(s) }
    var back = ActiveClock()
    back.tick(now: t(0), active: "a")
    for s in stride(from: 6.0, through: 30, by: 6) { back.tick(now: t(s), active: s < 30 ? "b" : "a") }
    XCTAssertEqual(back.current, "a", "a return within the wait keeps the card")
    XCTAssertEqual(back.pending["a"] ?? 0, 30, accuracy: 0.01)
    XCTAssertNil(back.next)
    var held = ActiveClock()
    held.tick(now: t(0), active: "a")
    held.tick(now: t(6), active: "a")
    for s in stride(from: 12.0, through: 72, by: 6) { held.tick(now: t(s), active: "b") }
    XCTAssertEqual(held.current, "b")
    XCTAssertEqual(held.since, t(12), "the switch is backdated to the wait's start")
    XCTAssertEqual(held.pending["a"] ?? 0, 12, accuracy: 0.01)
    XCTAssertEqual(held.pending["b"] ?? 0, 60, accuracy: 0.01)
    var pinned = ActiveClock()
    pinned.tick(now: t(0), active: "a")
    pinned.tick(now: t(6), active: "b", settle: 0)
    XCTAssertEqual(pinned.current, "b")
  }

  func testShortVisitElsewhereKeepsTheCardInReports() {
    let cards = [card("a", 0, 60, desktop: "2"), card("b", 0, 60, desktop: "3")]
    let back = Report.attribute(spans: [span(0, 10, space: 2), span(10, 10.5, space: 3), span(10.5, 15, space: 2)], cards: cards, rules: [], calendar: cal)
    XCTAssertEqual(minutes(back, .card("a")), 15, accuracy: 0.01)
    XCTAssertEqual(minutes(back, .card("b")), 0, accuracy: 0.01)
    let nowhere = Report.attribute(spans: [span(0, 10, space: 2), span(10, 10.5, space: 4), span(10.5, 15, space: 2)], cards: cards, rules: [], calendar: cal)
    XCTAssertEqual(minutes(nowhere, .card("a")), 15, accuracy: 0.01, "a short look at a desktop with no card keeps the card")
    let held = Report.attribute(spans: [span(0, 10, space: 2), span(10, 12, space: 3)], cards: cards, rules: [], calendar: cal)
    XCTAssertEqual(minutes(held, .card("b")), 2, accuracy: 0.01)
    let gap = Report.attribute(spans: [span(0, 10, space: 2), span(20, 20.5, space: 3)], cards: cards, rules: [], calendar: cal)
    XCTAssertEqual(minutes(gap, .card("b")), 0.5, accuracy: 0.01, "after a gap (away) the switch is at once")
  }

  func testActiveClockWaitsOnADesktopWithNoCard() {
    let t = { [t0] (s: Double) in t0.addingTimeInterval(s) }
    var c = ActiveClock()
    c.tick(now: t(0), active: "a")
    c.tick(now: t(12), active: nil)
    XCTAssertEqual(c.current, "a", "no card here waits too")
    for s in stride(from: 18.0, through: 72, by: 6) { c.tick(now: t(s), active: nil) }
    XCTAssertNil(c.current)
    XCTAssertEqual(c.pending["a"] ?? 0, 12, accuracy: 0.01)
    var away = ActiveClock()
    away.tick(now: t(0), active: "a")
    away.tick(now: t(6), active: nil, awaySince: t(6))
    XCTAssertNil(away.current, "going away switches at once")
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
    XCTAssertEqual(series.map(\.unattributed), [false, true])
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

  func testStatesSplitTheDayIntoWorkingIdleAndBreak() {
    let out = Report.states(spans: [span(0, 30), span(50, 60)], breaks: [BreakSpan(start: at(30), end: at(40))],
                            end: at(60), idleAfter: 300)
    func total(_ name: String) -> Double { out.filter { $0.name == name }.reduce(0) { $0 + $1.end.timeIntervalSince($1.start) } / 60 }
    XCTAssertEqual(total(Report.working), 40)
    XCTAssertEqual(total(Report.idle), 10)
    XCTAssertEqual(total(Report.onBreak), 10)
    XCTAssertEqual(Report.states(spans: [], breaks: [], end: at(60), idleAfter: 300), [])
  }

  func testDesktopStretchesTakeTheBestName() {
    var none = span(0, 1); none.space = nil
    let out = Report.desktops([span(0, 1, desktop: "PenguinAI"), span(0, 1, space: 2), span(0, 1, space: 3), none], labels: [2: "Mail"])
    XCTAssertEqual(out.map(\.name), ["PenguinAI", "Mail", "Desktop 3", "No desktop"])
  }

  func testStretchSeriesCutsAtHourEdges() {
    let rows = Report.series([Stretch(name: "Idle", start: at(50), end: at(70))], calendar: cal) { $0 }
    XCTAssertEqual(rows.map(\.bucket), [t0, at(60)])
    XCTAssertEqual(rows.map(\.seconds), [600, 600])
  }

  func testDesktopSlotsFollowDesktopOrderThenName() {
    let slots = Report.desktopSlots(["Mail", "Old", "Desktop 3"], order: ["Desktop 1", "Mail", "Desktop 3"])
    XCTAssertEqual(slots["Mail"], 1)
    XCTAssertEqual(slots["Desktop 3"], 2)
    XCTAssertEqual(slots["Old"], 3)
    XCTAssertEqual(Report.desktopSlots(["X"], order: (1...10).map { "Desktop \($0)" })["X"], 0)
  }

  func testTreeSplitsIdleOutOfDoing() {
    let t0 = Date(timeIntervalSince1970: 1_760_000_000)
    let a = ReportCard(ref: "a.md:1", title: "A", orgs: ["O"], stints: [DateInterval(start: t0, duration: 3600)])
    let leaf = Report.tree([], cards: [a], idle: [(t0.addingTimeInterval(600), t0.addingTimeInterval(1200))])
      .first?.children.first?.children.first
    XCTAssertEqual(leaf?.doing ?? 0, 3600, accuracy: 1e-6)
    XCTAssertEqual(leaf?.idle ?? 0, 600, accuracy: 1e-6)
  }
}
