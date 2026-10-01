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

  func testFirstColumnSurvivesCliPrefix() {
    XCTAssertEqual(Board.parse("=> @column\tBacklog\tlive\nBacklog\ta.md:1\tX\t1h\t\t").first?.cards.count, 1)
  }

  func testIdentifier() {
    let rows = "@column\tX\tlive\nX\t20260613-1844.md:0\tA\t1h\t\tObsidian Workflow\nX\t20260613-0946.md:3\tB\t1h\t\tVyasa"
    let cards = Board.parse(rows)[0].cards
    XCTAssertEqual(cards.map(\.identifier), ["OW-1844", "VYA-0946.3"])
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
}
