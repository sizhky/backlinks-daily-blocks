import XCTest
@testable import KanbanCore

final class SpacesTests: XCTestCase {
  func testURL() {
    XCTAssertEqual(Spaces.url(2)?.absoluteString, "btt://trigger_named/?trigger_name=desktop-2")
    XCTAssertNil(Spaces.url(0))
    XCTAssertNil(Spaces.url(10))
  }
}
