import XCTest
@testable import KanbanCore

final class SpacesTests: XCTestCase {
  func testKeyCodes() {
    XCTAssertEqual(Spaces.keyCode(1), 18)
    XCTAssertEqual(Spaces.keyCode(5), 23)
    XCTAssertEqual(Spaces.keyCode(9), 25)
    XCTAssertNil(Spaces.keyCode(0))
    XCTAssertNil(Spaces.keyCode(10))
  }
}
