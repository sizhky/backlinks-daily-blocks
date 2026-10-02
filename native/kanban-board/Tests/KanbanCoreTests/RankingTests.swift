import XCTest
@testable import KanbanCore

final class RankingTests: XCTestCase {
  func card(_ ref: String, _ rank: Double?) -> Card {
    var c = Card(ref: ref, file: "f.md", line: 0, col: "Todo", title: ref, age: "1h", tags: [], orgs: [], projects: [])
    c.rank = rank
    return c
  }

  func testOrderedPutsRankedFirst() {
    XCTAssertEqual(Ranking.ordered([card("a", nil), card("b", 2), card("c", 1)]).map(\.ref), ["c", "b", "a"])
  }

  func testBetweenRanked() {
    let out = Ranking.place(["c"], before: "b", in: [card("a", 1), card("b", 2), card("c", nil)])
    XCTAssertEqual(out.map(\.ref), ["c"]); XCTAssertEqual(out[0].rank, 1.5)
  }

  func testBeforeFirstAndAtEnd() {
    XCTAssertEqual(Ranking.place(["b"], before: "a", in: [card("a", 1), card("b", 2)])[0].rank, 0)
    XCTAssertEqual(Ranking.place(["a"], before: nil, in: [card("a", 1), card("b", 2)])[0].rank, 3)
  }

  func testUnrankedAboveDropGetRanked() {
    let out = Ranking.place(["x"], before: "c", in: [card("a", 1), card("b", nil), card("c", nil)])
    XCTAssertEqual(out.map(\.ref), ["b", "x"])
    XCTAssertEqual(out.map(\.rank), [2, 3])
  }

  func testSeveralSpreadEvenly() {
    let out = Ranking.place(["x", "y"], before: "b", in: [card("a", 0), card("b", 3)])
    XCTAssertEqual(out.map(\.rank), [1, 2])
  }
}
