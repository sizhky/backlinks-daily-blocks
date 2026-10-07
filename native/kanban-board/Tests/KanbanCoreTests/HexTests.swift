import XCTest
@testable import KanbanCore

final class HexTests: XCTestCase {
  func testParseAndFormatRoundTrip() {
    let c = Hex.rgba("#FF8000")
    XCTAssertEqual(c?.r, 1); XCTAssertEqual(c?.b, 0); XCTAssertEqual(c?.a, 1)
    XCTAssertEqual(Hex.rgba("00000080")?.a ?? 0, 128.0 / 255, accuracy: 0.001)
    XCTAssertNil(Hex.rgba("red"))
    XCTAssertEqual(Hex.string(r: 1, g: 128.0 / 255, b: 0), "#FF8000")
    XCTAssertEqual(Hex.string(r: 0, g: 0, b: 0, a: 0.5), "#00000080")
  }
}
