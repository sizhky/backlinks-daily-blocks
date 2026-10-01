import Foundation

struct DoingTask: Codable, Identifiable, Equatable, Sendable {
  let ref: String
  let file: String
  let line: Int
  let body: String
  let age: String

  var id: String { ref }
  var emojis: [String] {
    body.filter { character in
      character.unicodeScalars.contains { scalar in
        scalar.properties.isEmojiPresentation || scalar.value == 0xFE0F
      }
    }.map(String.init)
  }
}

struct TaskSection: Identifiable, Equatable, Sendable {
  let name: String
  var tasks: [DoingTask]

  var id: String { name.lowercased() }
}
