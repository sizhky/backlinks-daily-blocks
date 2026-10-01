import Testing
@testable import DoingTasks

@Suite("Obsidian CLI")
struct ObsidianCLITests {
  @Test("parses active task output")
  func parseTasks() {
    let output = """
      =>
      Doing\t20260810-0818.md:6\tBuild native closer #kb/doing\t3m
      """
    #expect(
      ObsidianCLI.parseTasks(output) == [
        DoingTask(
          ref: "20260810-0818.md:6",
          file: "20260810-0818.md",
          line: 6,
          body: "Build native closer",
          age: "3m"
        )
      ]
    )
  }

  @Test("escapes task paths for eval")
  func escapeJavaScript() throws {
    #expect(try ObsidianCLI.javaScriptString("a\"b.md") == "\"a\\\"b.md\"")
  }

  @Test("parses Done task references")
  func parseDoneTaskIDs() {
    let output = "=>\nDone\t20260810-0818.md:6\tBuild native closer\t09:12\n"
    #expect(ObsidianCLI.parseDoneTaskIDs(output) == Set(["20260810-0818.md:6"]))
  }

  @Test("parses configured task sections including empty sections")
  func parseSections() {
    let output = """
      =>
      @column\tBacklog
      Backlog\t20260810-1006.md:7\tReview Buzz #kb/backlog\t2h
      @column\tDoing
      @column\tParked
      """
    #expect(ObsidianCLI.parseSections(output) == [
      TaskSection(name: "Backlog", tasks: [
        DoingTask(ref: "20260810-1006.md:7", file: "20260810-1006.md", line: 7, body: "Review Buzz", age: "2h")
      ]),
      TaskSection(name: "Doing", tasks: []),
      TaskSection(name: "Parked", tasks: []),
    ])
  }

  @Test("extracts every emoji from a task title")
  func taskEmojis() {
    let task = DoingTask(ref: "a.md:0", file: "a.md", line: 0, body: "Ship 🚀 then celebrate ✅", age: "1m")
    #expect(task.emojis == ["🚀", "✅"])
  }
}
