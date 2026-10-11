import XCTest
@testable import KanbanCore

final class BoardTests: XCTestCase {
  let output = "=> \n@column\tBacklog\tlive\nBacklog\ta.md:3\tWrite spec #win #kb/backlog\t2d\tPersonal\tObsidian Workflow\n"
    + "@column\tDoing\tlive\nDoing\tb.md:0\tFix bug\t30m\t\t\n@column\tDone\tdone\nDone\tc.md:1\tShip it\t5h\tDivami\tArka|Other"

  func testParseColumnsCardsAndTags() {
    let cols = Board.parse(output)
    XCTAssertEqual(cols.map(\.name), ["Backlog", "Doing", "Done"])
    XCTAssertEqual(cols[2].done, true)
    let c = cols[0].cards[0]
    XCTAssertEqual([c.title, c.file, "\(c.line)"], ["Write spec", "a.md", "3"])
    XCTAssertEqual(c.tags, ["#win"])
    XCTAssertEqual(cols[2].cards[0].projects, ["Arka", "Other"])
    XCTAssertEqual(cols[1].cards[0].projects, [])
  }

  func testDesktopFieldKeepsNumberOrName() {
    let cols = Board.parse("@column\tDoing\tlive\nDoing\ta.md:1\tX\t1h\t\t\t\t3\nDoing\ta.md:2\tY\t1h\t\t\t\tPenguinAI\nDoing\ta.md:3\tZ\t1h\t\t\t\t")
    XCTAssertEqual(cols[0].cards.map(\.desktop), ["3", "PenguinAI", nil])
    XCTAssertEqual(cols[0].cards[0].moved(to: "Done").desktop, "3")
  }

  func testFirstColumnSurvivesCliPrefix() {
    XCTAssertEqual(Board.parse("=> @column\tBacklog\tlive\nBacklog\ta.md:1\tX\t1h\t\t").first?.cards.count, 1)
  }

  func testSweepRowsAttachToFromColumn() {
    let cols = Board.parse(output + "\n@sweep\tdoing\tParked\n@sweep\tDoing\tDone\n@sweep\tNope\tDone")
    XCTAssertEqual(cols[1].sweeps, ["Parked", "Done"])
    XCTAssertEqual(cols[1].cards.count, 1)
    XCTAssertEqual(cols[0].sweeps, [])
  }

  func testCardIdSurvivesLineShiftAndDedupes() {
    let a = Board.parse("@column\tX\tlive\nX\tn.md:3\tSame\t1h\nX\tn.md:5\tSame\t1h")[0].cards
    let b = Board.parse("@column\tX\tlive\nX\tn.md:4\tSame\t1h\nX\tn.md:7\tSame\t1h")[0].cards
    XCTAssertEqual(a.map(\.id), ["n.md|Same", "n.md|Same#1"])
    XCTAssertEqual(a.map(\.id), b.map(\.id))
    XCTAssertEqual(a[0].moved(to: "Y").id, a[0].id)
  }

  func testIdentifier() {
    let rows = "@column\tX\tlive\nX\t20260613-1844.md:0\tA\t1h\t\tObsidian Workflow\t\t\t1\t1"
      + "\nX\t20260613-0946.md:9\tB\t1h\t\tVyasa\t\t\t3\t3\nX\t20260613-0946.md:12\tC\t1h\t\tVyasa\t\t\t3\t3"
      + "\nX\t20260613-0946.md:0\tD\t1h\t\tVyasa\t\t\t1\t3"
    let cards = Board.parse(rows)[0].cards
    // Line 9 and line 12 are the same 3rd task before and after a move stamp is inserted above it.
    XCTAssertEqual(cards.map(\.identifier), ["OW-260613-1844", "VYA-260613-0946.03", "VYA-260613-0946.03", "VYA-260613-0946.01"])
    let other = Board.parse("@column\tX\tlive\nX\t20260704 - Plan of Action.md:3\tA\t1h\t\tTask\t\t\t1\t2")[0].cards[0]
    XCTAssertNotNil(other.identifier.wholeMatch(of: #/TAS-[0-9A-Z]{4}\.01/#), other.identifier)
    XCTAssertEqual(Board.parse("@column\tX\tlive\nX\tw.excalidraw.md:0\tA\t1h")[0].cards[0].identifier.count, 8)
    XCTAssertEqual(Board.parse("@column\tX\tlive\nX\t20260613-1844.excalidraw.md:0\tA\t1h")[0].cards[0].identifier, "TAS-260613-1844")
    XCTAssertEqual(["Horizontal Training Pipeline", "Obsidian Workflow", "Vyasa", "sift-tech ai x", "??"].map(Card.initials),
                   ["HTP", "OW", "V", "STA", ""])
  }

  func apply(_ q: String) -> [String] {
    Filter.apply(Board.parse(output), Query.parse(q)).flatMap(\.cards).map(\.title)
  }

  func testFilters() {
    XCTAssertEqual(apply("col:doing"), ["Fix bug"])
    XCTAssertEqual(apply("-col:done,doing"), ["Write spec"])
    XCTAssertEqual(apply("tag:win"), ["Write spec"])
    XCTAssertEqual(apply("project:arka"), ["Ship it"])
    XCTAssertEqual(apply("no:project"), ["Fix bug"])
    XCTAssertEqual(apply("stale:1d"), ["Write spec"])
    XCTAssertEqual(apply("age:<1h"), ["Fix bug"])
    XCTAssertEqual(apply("ship"), ["Ship it"])
    XCTAssertEqual(apply(""), ["Write spec", "Fix bug", "Ship it"])
  }
}

final class GroupingTests: XCTestCase {
  func testByProjectOrdersBySizeThenLoose() {
    let rows = "@column\tX\tlive\nX\ta.md:1\tA\t1h\t\tZed\nX\ta.md:2\tB\t1h\t\tArka\nX\ta.md:3\tC\t1h\t\t\nX\ta.md:4\tD\t1h\t\tArka"
    let groups = Grouping.byProject(Board.parse(rows)[0].cards)
    XCTAssertEqual(groups.map(\.name), ["Arka", "Zed", nil])
    XCTAssertEqual(groups[0].cards.map(\.title), ["B", "D"])
  }

  func testGroupOrgsAreDistinctFirstOrgsInCardOrder() {
    let rows = "@column\tX\tlive\nX\ta.md:1\tA\t1h\tDivami|Levo\tP\nX\ta.md:2\tB\t1h\tDivami\tP\nX\ta.md:3\tC\t1h\t\tP\nX\ta.md:4\tD\t1h\tLevo\tQ"
    let groups = Grouping.byProject(Board.parse(rows)[0].cards)
    XCTAssertEqual(groups.map(\.orgs), [["Divami"], ["Levo"]])
  }
}

final class ScopeTests: XCTestCase {
  func testScopeByOrgsIsExactAndMulti() {
    let rows = "@column\tX\tlive\nX\ta.md:1\tA\t1h\tPersonal\t\nX\ta.md:2\tB\t1h\tPersonal Extra\t\nX\ta.md:3\tC\t1h\t\t\nX\ta.md:4\tD\t1h\tDivami\t"
    let cols = Board.parse(rows)
    func titles(_ orgs: [String]) -> [String] { Filter.scope(cols, orgs: orgs).flatMap(\.cards).map(\.title) }
    XCTAssertEqual(titles(["personal"]), ["A"])
    XCTAssertEqual(titles(["Personal", "Divami"]), ["A", "D"])
    XCTAssertEqual(titles([Filter.noOrg, "Divami"]), ["C", "D"])
    XCTAssertEqual(titles([]), ["A", "B", "C", "D"])
  }

  func testSavedFilterReadsLegacyOrgField() throws {
    let json = #"{"id":"5B0C1D2E-0000-4000-8000-000000000001","name":"N","query":"q","org":"Divami"}"#
    XCTAssertEqual(try JSONDecoder().decode(SavedFilter.self, from: Data(json.utf8)).orgs, ["Divami"])
  }
}

final class CreatedTests: XCTestCase {
  func testCreatedFilters() {
    let rows = "@column\tX\tlive\nX\t20260613-0900.md:0\tToday\t1h\t\t\nX\t20260612-2300.md:0\tYesterday\t1h\t\t\nX\t20260601-1000.md:0\tOld\t1h\t\t"
    var c = DateComponents(); c.year = 2026; c.month = 6; c.day = 13; c.hour = 18
    let now = Calendar.current.date(from: c)!
    func titles(_ q: String) -> [String] {
      Filter.apply(Board.parse(rows), Query.parse(q), now: now).flatMap(\.cards).map(\.title)
    }
    XCTAssertEqual(titles("created:today"), ["Today"])
    XCTAssertEqual(titles("created:yesterday"), ["Yesterday"])
    XCTAssertEqual(titles("created:<2d"), ["Today", "Yesterday"])
    XCTAssertEqual(titles("created:>7d"), ["Old"])
    XCTAssertEqual(titles("created:2026-06-01"), ["Old"])
    XCTAssertEqual(titles("-created:today"), ["Yesterday", "Old"])
  }

  func testLogbookGroupsDoneCardsByDayNewestFirst() {
    let rows = "@column\tDone\tdone\nDone\ta.md:1\tA\t1d\t\t\t\t\t\t\t2026-10-02T17:25:00.000Z"
      + "\nDone\tb.md:1\tB\t1h\t\t\t\t\t\t\t2026-10-03T12:21:00.000Z\nDone\tc.md:1\tC\t1h\t\t\t\t\t\t\t2026-10-03T09:00:00.000Z"
      + "\nDone\td.md:1\tCancelled one\t1h"
    var utc = Calendar(identifier: .gregorian); utc.timeZone = TimeZone(identifier: "UTC")!
    let days = Logbook.days(Board.parse(rows)[0].cards, calendar: utc)
    XCTAssertEqual(days.map { $0.cards.map(\.title) }, [["B", "C"], ["A"]])
  }


  func testCommaValuesMeanOrAndDifferentTermsMeanAnd() {
    func card(_ col: String, _ project: String) -> Card {
      Card(ref: "a.md:1", file: "a.md", line: 1, col: col, title: "t", age: "1h", tags: [], orgs: [], projects: [project])
    }
    let q = Query.parse("project:Vyasa,Drishti col:Doing,Backlog")
    XCTAssertTrue(Filter.matches(card("Doing", "Vyasa"), q))
    XCTAssertTrue(Filter.matches(card("Backlog", "Drishti"), q))
    XCTAssertFalse(Filter.matches(card("Done", "Vyasa"), q))
    XCTAssertFalse(Filter.matches(card("Doing", "Other"), q))
    XCTAssertTrue(Filter.matches(card("Doing", "Other"), Query.parse("-project:Vyasa,Drishti")))
  }

  func testEstimateMinutesAndLabel() {
    XCTAssertEqual(["90", "45m", "2h", "1h30m", "1h 30m", "soon", "0", ""].map(Age.minutes), [90, 45, 120, 90, 90, nil, nil, nil])
    XCTAssertEqual([45, 120, 90].map { Age.label(minutes: $0) }, ["45m", "2h", "1h 30m"])
  }

  func testCardReadsEstimateAndTookFields() {
    let rows = "@column\tDone\tdone\nDone\ta.md:1\tA\t1h\t\t\t\t\t\t\t2026-10-03T12:21:00.000Z\t60\t85"
    let card = Board.parse(rows)[0].cards[0]
    XCTAssertEqual([card.est, card.took], [60, 85])
  }

  func testSpanUsesSecondsUnderAMinute() {
    XCTAssertEqual(Age.span(seconds: 42), "42s")
    XCTAssertEqual(Age.span(seconds: 600), "10m")
    XCTAssertEqual(Age.span(seconds: 3900), "1h 5m")
    XCTAssertEqual(Age.span(seconds: 97200), "1d 3h")
  }

  func testColumnSecondsAddOpenStintInCurrentColumn() {
    let since = Card.iso.string(from: Date(timeIntervalSince1970: 1000))
    var f = Array(repeating: "", count: 16)
    (f[0], f[1], f[2], f[3], f[13], f[15]) = ("Doing", "a.md:0", "Task", "1m", since, "Doing=1800|Parked=600")
    let c = Card(fields: f)!
    XCTAssertEqual(c.seconds(in: "doing", at: Date(timeIntervalSince1970: 1600)), 2400)
    XCTAssertEqual(c.seconds(in: "Parked", at: Date(timeIntervalSince1970: 1600)), 600)
    XCTAssertEqual(c.moved(to: "Parked").columnSeconds["Doing"].map { $0 >= 1800 }, true)
  }
}
