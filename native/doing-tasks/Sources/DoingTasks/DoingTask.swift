import Foundation

struct DoingTask: Codable, Identifiable, Equatable, Sendable {
  let ref: String
  let file: String
  let line: Int
  let body: String
  let age: String

  var id: String { ref }
}
