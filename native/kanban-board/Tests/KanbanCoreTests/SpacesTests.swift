import XCTest
@testable import KanbanCore

final class SpacesTests: XCTestCase {
  func hotkey(_ enabled: Int) -> [String: Any] {
    ["119": ["enabled": enabled, "value": ["parameters": [50, 19, 1_835_008], "type": "standard"]]]
  }

  func testShortcut() {
    let s = Spaces.shortcut(2, in: hotkey(1))
    XCTAssertEqual(s?.code, 19)
    XCTAssertEqual(s?.flags, 1_835_008)
  }

  func testMissingDisabledAndOutOfRange() {
    XCTAssertNil(Spaces.shortcut(2, in: hotkey(0)))
    XCTAssertNil(Spaces.shortcut(3, in: hotkey(1)))
    XCTAssertNil(Spaces.shortcut(0, in: hotkey(1)))
  }
}
