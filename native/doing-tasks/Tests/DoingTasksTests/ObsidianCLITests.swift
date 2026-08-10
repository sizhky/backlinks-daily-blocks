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
}
