import Foundation

enum ObsidianCLIError: LocalizedError {
  case commandFailed(String)
  case timedOut

  var errorDescription: String? {
    switch self {
    case .commandFailed(let message): message
    case .timedOut: "Obsidian did not respond within 10 seconds."
    }
  }
}

actor ObsidianCLI {
  private let executable = "/Applications/Obsidian.app/Contents/MacOS/obsidian"

  func isObsidianRunning() throws -> Bool {
    do {
      _ = try run("/usr/bin/pgrep", arguments: ["-x", "Obsidian"])
      return true
    } catch {
      return false
    }
  }

  func fetchDoingTasks() throws -> [DoingTask] {
    let output = try evaluate("kb.active({col:\"Doing\"})")
    return Self.parseTasks(output)
  }

  func move(_ task: DoingTask, to column: String) throws {
    let file = try Self.javaScriptString(task.file)
    let target = try Self.javaScriptString(column)
    _ = try evaluate("kb.moveTask(\(file),\(task.line),\(target))")
  }

  static func parseTasks(_ output: String) -> [DoingTask] {
    let payload = output.range(of: "=>").map { String(output[$0.upperBound...]) } ?? output
    return payload.split(whereSeparator: \Character.isNewline).compactMap { row in
      let fields = row.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
      guard fields.count >= 4, let separator = fields[1].lastIndex(of: ":") else { return nil }
      let file = String(fields[1][..<separator])
      guard let line = Int(fields[1][fields[1].index(after: separator)...]) else { return nil }
      let body = fields[2].replacingOccurrences(
        of: #"\s+#kb/[^\s]+"#,
        with: "",
        options: .regularExpression
      ).trimmingCharacters(in: .whitespaces)
      return DoingTask(ref: fields[1], file: file, line: line, body: body, age: fields[3])
    }
  }

  static func javaScriptString(_ value: String) throws -> String {
    let data = try JSONEncoder().encode(value)
    return String(decoding: data, as: UTF8.self)
  }

  private func evaluate(_ code: String) throws -> String {
    try run(executable, arguments: ["eval", "code=\(code)"])
  }

  private func run(_ path: String, arguments: [String]) throws -> String {
    let process = Process()
    let output = Pipe()
    let errors = Pipe()
    process.executableURL = URL(fileURLWithPath: path)
    process.arguments = arguments
    process.standardOutput = output
    process.standardError = errors
    try process.run()

    let deadline = Date().addingTimeInterval(10)
    while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
    if process.isRunning {
      process.terminate()
      throw ObsidianCLIError.timedOut
    }

    let stdout = output.fileHandleForReading.readDataToEndOfFile()
    guard process.terminationStatus == 0 else {
      let stderr = errors.fileHandleForReading.readDataToEndOfFile()
      let message = String(decoding: stderr, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
      throw ObsidianCLIError.commandFailed(message.isEmpty ? "Command failed." : message)
    }
    return String(decoding: stdout, as: UTF8.self)
  }
}
