import Foundation

/// The org and project a card created from the board takes from the current view.
public enum NewCard {
  /// Org: the one workspace in scope, else one plain `org:` term; project: one plain `project:` term.
  /// A term value resolves to a board name: exact match first, else the only name that contains it.
  /// A project without an org takes the org when every card with that project shares one.
  /// ```
  /// scope(orgScope: ["Divami"], terms: parse("project:us"), cards) -> ("Divami", "US-Bank")
  /// scope(orgScope: [], terms: parse("project:US-Bank"), cards)    -> ("Divami", "US-Bank")
  /// scope(orgScope: ["A", "B"], terms: parse("-org:A"), cards)     -> (nil, nil)
  /// ```
  public static func scope(orgScope: [String], terms: [QueryTerm], cards: [Card]) -> (org: String?, project: String?) {
    let orgs = Set(cards.flatMap(\.orgs)).sorted(), projects = Set(cards.flatMap(\.projects)).sorted()
    let scoped = orgScope.filter { $0 != Filter.noOrg }
    var org = scoped.count == 1 && orgScope.count == 1 ? resolve(scoped[0], in: orgs) : nil
    if org == nil, orgScope.isEmpty { org = term(["org", "o"], terms).flatMap { resolve($0, in: orgs) } }
    let project = term(["project", "proj", "p"], terms).flatMap { resolve($0, in: projects) }
    if org == nil, orgScope.isEmpty, let project {
      let owners = Set(cards.filter { $0.projects.contains(project) }.flatMap(\.orgs))
      if owners.count == 1 { org = owners.first }
    }
    return (org, project)
  }

  /// The value of the only term with one of `keys`, when it is not negated and names one value.
  static func term(_ keys: [String], _ terms: [QueryTerm]) -> String? {
    let found = terms.filter { $0.key.map(keys.contains) ?? false }
    guard found.count == 1, let t = found.first, !t.negated, !t.value.contains(","), !t.value.isEmpty else { return nil }
    return t.value
  }

  static func resolve(_ value: String, in names: [String]) -> String? {
    if let exact = names.first(where: { $0.caseInsensitiveCompare(value) == .orderedSame }) { return exact }
    let inside = names.filter { $0.lowercased().contains(value.lowercased()) }
    return inside.count == 1 ? inside[0] : nil
  }
}
