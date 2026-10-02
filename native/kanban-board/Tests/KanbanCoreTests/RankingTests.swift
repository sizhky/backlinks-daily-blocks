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

  func testSlotFromCursorHeight() {
    let mid = ["a": 10.0, "b": 30, "c": 50]
    func at(_ y: Double) -> String? { Ranking.slot(order: ["a", "b", "c"], dragging: ["b"], grabbed: "b", midY: mid, y: y) }
    XCTAssertEqual(at(5), "a")
    XCTAssertEqual(at(40), "b")
    XCTAssertNil(at(60))
    XCTAssertEqual(Ranking.slot(order: ["a", "b"], dragging: ["x"], grabbed: "x", midY: mid, y: 99), nil)
    XCTAssertEqual(Ranking.slot(order: ["a", "c"], dragging: ["c"], grabbed: "c", midY: mid, y: 99), "c")
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
