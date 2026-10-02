import XCTest
@testable import KanbanCore

final class SpacesTests: XCTestCase {
  func testURL() {
    XCTAssertEqual(Spaces.url(2)?.absoluteString, "btt://trigger_action/?json=%7B%22BTTPredefinedActionType%22%3A208%7D")
    XCTAssertNil(Spaces.url(0))
    XCTAssertNil(Spaces.url(10))
  }
}
