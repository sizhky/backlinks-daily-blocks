import XCTest
@testable import KanbanCore

final class QueryTests: XCTestCase {
  func testKeyValueNegationQuotesAndText() {
    let terms = Query.parse(#"col:Doing -tag:#win project:"Obsidian Workflow" call"#)
    XCTAssertEqual(terms, [
      QueryTerm(key: "col", value: "Doing", negated: false),
      QueryTerm(key: "tag", value: "#win", negated: true),
      QueryTerm(key: "project", value: "Obsidian Workflow", negated: false),
      QueryTerm(key: nil, value: "call", negated: false),
    ])
  }

  func testLoneDashAndEmpty() {
    XCTAssertEqual(Query.parse(""), [])
    XCTAssertEqual(Query.parse("-"), [QueryTerm(key: nil, value: "-", negated: false)])
  }
}
