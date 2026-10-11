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

final class CatalogTests: XCTestCase {
  let catalog = Catalog.make(columns: ["Doing", "Done"], projects: ["Obsidian Workflow", "Vyasa"], tags: ["#win"], views: ["Stale 7d+"])

  func testKeyPrefixesAndAliases() {
    XCTAssertEqual(catalog.suggest("vi").map(\.term), ["view:"])
    XCTAssertEqual(catalog.suggest("crea").map(\.term), ["created:"])
    XCTAssertEqual(catalog.suggest("p").map(\.term), ["project:"])
    XCTAssertEqual(catalog.suggest("-no").map(\.term), ["-no:"])
    XCTAssertEqual(catalog.suggest("").map(\.term), [])
    XCTAssertEqual(catalog.suggest("zzz").map(\.term), [])
  }

  func testValuesPrefixThenContainsAndExactDropped() {
    XCTAssertEqual(catalog.suggest("created:to").map(\.term), ["created:today"])
    XCTAssertEqual(catalog.suggest("c:ye").map(\.term), ["c:yesterday"])
    XCTAssertEqual(catalog.suggest("-col:do").map(\.term), ["-col:Doing", "-col:Done"])
    XCTAssertEqual(catalog.suggest("tag:w").map(\.term), ["tag:#win"])
    XCTAssertEqual(catalog.suggest("created:today").map(\.term), [])
    XCTAssertEqual(catalog.suggest("nope:x").map(\.term), [])
  }

  func testQuotedValuesAndReplacing() {
    let s = catalog.suggest(#"col:Doing project:"obs"#)
    XCTAssertEqual(s.map(\.term), [#"project:"Obsidian Workflow""#])
    XCTAssertEqual(Catalog.replacing(#"col:Doing project:"obs"#, with: s[0]), #"col:Doing project:"Obsidian Workflow" "#)
    XCTAssertEqual(Catalog.replacing("call vi", with: catalog.suggest("call vi")[0]), "call view:")
  }
}

final class OrderingTests: XCTestCase {
  func testArrangedKeepsSavedThenNew() {
    XCTAssertEqual(Ordering.arranged(["a", "b", "c"], saved: ["c", "x", "a"]), ["c", "a", "b"])
  }

  func testMovingDownAndUp() {
    XCTAssertEqual(Ordering.moving(["a", "b", "c"], "a", onto: "c"), ["b", "c", "a"])
    XCTAssertEqual(Ordering.moving(["a", "b", "c"], "c", onto: "a"), ["c", "a", "b"])
    XCTAssertEqual(Ordering.moving(["a", "b"], "a", onto: "zz"), ["a", "b"])
  }

  func testExpressionAndOrParentheses() {
    let e = Query.expression("(org:Divami desktop:2) or project:Vyasa,Arka")
    let holds = { (facts: [String: String]) in { (t: QueryTerm) in facts[t.key ?? ""]?.lowercased() == t.value.lowercased() } }
    XCTAssertEqual(e?.eval(holds(["org": "Divami", "desktop": "2"])), true)
    XCTAssertEqual(e?.eval(holds(["org": "Divami", "desktop": "1"])), false)
    XCTAssertEqual(e?.eval(holds(["project": "Arka"])), true)
    XCTAssertEqual(Query.expression("org:A and -project:B")?.eval(holds(["org": "A", "project": "B"])), false)
    XCTAssertEqual(Query.expression("org:A or org:B project:C")?.eval(holds(["org": "B"])), false)
    XCTAssertNil(Query.expression("  "))
    XCTAssertEqual(Query.expression("org:A)")?.eval(holds(["org": "A"])), true)
  }

  func testTimelineCatalogCompletesInsideParentheses() {
    let c = Catalog.timeline(projects: ["Vyasa"], orgs: ["Divami"], desktops: ["Personal", "2"])
    XCTAssertEqual(c.suggest("(org:Div").map(\.term), ["(org:Divami"])
    XCTAssertEqual(c.suggest("de").map(\.term), ["desktop:"])
    XCTAssertEqual(c.suggest("org:A or (-desktop:Pers").map(\.term), ["(-desktop:Personal"])
  }
}
