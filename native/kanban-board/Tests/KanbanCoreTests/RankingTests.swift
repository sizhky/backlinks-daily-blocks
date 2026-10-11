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

  func testUnrankedLatestCreatedFirst() {
    func at(_ file: String, _ line: Int, _ rank: Double? = nil) -> Card {
      var c = Card(ref: "\(file):\(line)", file: file, line: line, col: "Todo", title: "", age: "1h", tags: [], orgs: [], projects: [])
      c.rank = rank
      return c
    }
    let out = Ranking.ordered([at("20261010-0900.md", 3), at("Notes.md", 2), at("20261011-0800.md", 1),
                               at("20261009-0700.md", 5, 1), at("20261011-0800.md", 4)])
    XCTAssertEqual(out.map(\.ref), ["20261009-0700.md:5", "20261011-0800.md:4", "20261011-0800.md:1",
                                     "20261010-0900.md:3", "Notes.md:2"])
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

  func testSlotFromCursorHeight() {
    let mid = ["a": 10.0, "b": 30, "c": 50]
    func at(_ y: Double) -> String? { Ranking.slot(order: ["a", "b", "c"], dragging: ["b"], grabbed: "b", midY: mid, y: y) }
    XCTAssertEqual(at(5), "a")
    XCTAssertEqual(at(40), "b")
    XCTAssertNil(at(60))
    XCTAssertEqual(Ranking.slot(order: ["a", "b"], dragging: ["x"], grabbed: "x", midY: mid, y: 99), nil)
    XCTAssertEqual(Ranking.slot(order: ["a", "c"], dragging: ["c"], grabbed: "c", midY: mid, y: 99), "c")
  }

  /// A lazy column measures only the cards near the viewport.
  func testSlotSkipsUnmeasuredCards() {
    let mid = ["c": 30.0, "d": 50]
    func at(_ y: Double) -> String? { Ranking.slot(order: ["a", "b", "c", "d", "e"], dragging: [], grabbed: nil, midY: mid, y: y) }
    XCTAssertEqual(at(10), "c")
    XCTAssertEqual(at(40), "d")
    XCTAssertEqual(at(60), "e")
  }

  func testDragLayout() {
    func items(_ target: Bool, _ before: String?) -> [DragLayout.Item] {
      DragLayout.items(order: ["a", "b", "c"], carried: ["b"], target: target, before: before)
    }
    XCTAssertEqual(items(true, "b"), [.card("a"), .ghost, .card("c")])
    XCTAssertEqual(items(true, "a"), [.ghost, .card("a"), .card("c")])
    XCTAssertEqual(items(true, nil), [.card("a"), .card("c"), .ghost])
    XCTAssertEqual(items(true, "gone"), [.card("a"), .card("c"), .ghost])
    XCTAssertEqual(items(false, "a"), [.card("a"), .card("c")])
  }
}
