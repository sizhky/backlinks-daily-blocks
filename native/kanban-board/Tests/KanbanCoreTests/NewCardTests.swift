import Testing
@testable import KanbanCore

struct NewCardTests {
  static func card(_ org: String, _ project: String) -> Card {
    Card(ref: "\(project).md:1", file: "\(project).md", line: 1, col: "Backlog", title: "t", age: "1h", tags: [], orgs: [org], projects: [project])
  }
  let cards = [card("Divami", "US-Bank"), card("Divami", "Vyasa Docs"), card("Personal", "Vyasa"), card("Personal", "Kanban App")]

  @Test func workspaceInScopeAndProjectTerm() {
    let s = NewCard.scope(orgScope: ["Divami"], terms: Query.parse("project:us col:Doing"), cards: cards)
    #expect(s.org == "Divami" && s.project == "US-Bank")
  }

  @Test func projectAloneTakesItsOrg() {
    let s = NewCard.scope(orgScope: [], terms: Query.parse("project:\"Kanban App\""), cards: cards)
    #expect(s.org == "Personal" && s.project == "Kanban App")
  }

  @Test func exactNameBeatsSubstring() {
    #expect(NewCard.scope(orgScope: [], terms: Query.parse("p:vyasa"), cards: cards).project == "Vyasa")
  }

  @Test func ambiguousOrNegatedGivesNothing() {
    #expect(NewCard.scope(orgScope: ["Divami", "Personal"], terms: Query.parse("-org:Divami"), cards: cards) == (nil, nil))
    #expect(NewCard.scope(orgScope: [], terms: Query.parse("project:a"), cards: cards).project == nil)
    #expect(NewCard.scope(orgScope: [], terms: Query.parse("project:US-Bank,Vyasa"), cards: cards).project == nil)
  }

  @Test func orgTermWithoutScope() {
    #expect(NewCard.scope(orgScope: [], terms: Query.parse("org:pers"), cards: cards).org == "Personal")
  }
}
