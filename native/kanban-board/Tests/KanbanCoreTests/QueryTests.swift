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

  func testTogglingReplacesSameKeyAndClearsRepeat() {
    XCTAssertEqual(Query.toggling("project:Vyasa tag:x", term: "project:Drishti"), "tag:x project:Drishti")
    XCTAssertEqual(Query.toggling("proj:Vyasa", term: "project:vyasa"), "")
    XCTAssertEqual(Query.toggling("-project:Old", term: "project:\"A B\""), "-project:Old project:\"A B\"")
  }
}

final class TitleTests: XCTestCase {
  func testWikilinksAliasesAndMarkdownLinks() {
    XCTAssertEqual(Title.segments("See [[Plan#Goals|goals]] and [[A/B C]] [x](https://e.com)", vault: "V"), [
      .text("See "),
      .link(label: "goals", url: "obsidian://open?vault=V&file=Plan%23Goals"),
      .text(" and "),
      .link(label: "B C", url: "obsidian://open?vault=V&file=A%2FB%20C"),
      .text(" "),
      .link(label: "x", url: "https://e.com"),
    ])
    XCTAssertEqual(Title.segments("plain", vault: "V"), [.text("plain")])
  }
}
