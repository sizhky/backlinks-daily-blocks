import XCTest
@testable import KanbanCore

final class MenuNavTests: XCTestCase {
  func testSkipsDisabledAndWraps() {
    let rows = [true, false, true]
    XCTAssertEqual(MenuNav.step(rows, from: 0, by: 1), 2)
    XCTAssertEqual(MenuNav.step(rows, from: 2, by: 1), 0)
    XCTAssertEqual(MenuNav.step(rows, from: 0, by: -1), 2)
  }

  func testStartsAtEnds() {
    let rows = [false, true, true, false]
    XCTAssertEqual(MenuNav.step(rows, from: nil, by: 1), 1)
    XCTAssertEqual(MenuNav.step(rows, from: nil, by: -1), 2)
  }

  func testNothingEnabled() {
    XCTAssertNil(MenuNav.step([false, false], from: nil, by: 1))
    XCTAssertNil(MenuNav.step([], from: nil, by: 1))
  }
}
