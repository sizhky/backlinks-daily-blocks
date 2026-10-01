import AppKit
import Foundation
import KanbanCore

struct ObsidianError: LocalizedError {
  let errorDescription: String?
  init(_ message: String) { errorDescription = message }
}

/// Talks to the backlinks-daily-blocks plugin through `obsidian eval` (global `kb`).
struct ObsidianClient {
  static let executable = "/Applications/Obsidian.app/Contents/MacOS/obsidian"

  /// Live columns come from kb.active (all ages, paused included); done columns from kb.board (recent).
  /// Appends org and projects frontmatter to each row.
  static func boardScript(doneHours: Int) -> String {
    #"""
    (async()=>{
    const P=app.plugins.plugins["backlinks-daily-blocks"];
    const defs=String(P.settings.kanban.columns).split(/\r?\n|,/).map(s=>s.trim()).filter(Boolean).map(s=>{const n=s.split(/\s+@/)[0];return{name:n.replace(/=.$/,"").replace(/[~!]$/,""),term:/=.$/.test(n)}});
    const rows=s=>s.split("\n").map(l=>l.split("\t")).filter(c=>c.length>=4&&c[0]!=="@column");
    const act=rows(await kb.active({includePaused:true}));
    const brd=rows(await kb.board({hours:\#(doneHours),full:"Doing"}));
    const v=(f,k)=>{const x=f&&f[k];return x==null?"":[].concat(x).map(s=>String(s).replace(/^\[\[|\]\]$/g,"").split("|")[0]).join("|")};
    const out=[];
    for(const d of defs){out.push("@column\t"+d.name+"\t"+(d.term?"done":"live"));
    for(const c of (d.term?brd:act).filter(c=>c[0].toLowerCase()===d.name.toLowerCase())){
    const f=app.metadataCache.getCache(c[1].replace(/:\d+$/,""))?.frontmatter;
    out.push([c[0],c[1],c[2],c[3],v(f,"org"),v(f,"projects")].join("\t"));}}
    for(const r of kb.sweeps().split("\n").filter(Boolean))out.push("@sweep\t"+r);
    return out.join("\n")})()
    """#.replacingOccurrences(of: "\n", with: " ")
  }

  func board() async throws -> [Column] {
    let output = try await eval(Self.boardScript(doneHours: 24 * 14))
    let columns = Board.parse(output)
    if columns.isEmpty { throw ObsidianError(String(output.prefix(200))) }
    return columns
  }

  func move(_ card: Card, to column: String) async throws {
    _ = try await eval("kb.moveTask(\(try js(card.file)),\(card.line),\(try js(column)))")
  }

  /// Moves several cards in one call (kb.moveTasks, bottom-up per file).
  func move(_ cards: [Card], to column: String) async throws {
    _ = try await eval("kb.moveTasks(\(try js(cards.map(\.ref))),\(try js(column)))")
  }

  /// Bulk-moves these cards with the plugin's sweep (bottom-up, open-children guard).
  func sweep(_ cards: [Card], from: String, to: String) async throws {
    _ = try await eval("kb.sweep(\(try js(from)),\(try js(to)),\(try js(cards.map(\.ref))))")
  }

  /// Freeform prose under a task (kb.note), without the CLI's `=>` prefix.
  func note(_ card: Card) async throws -> String {
    let out = try await eval("kb.note(\(try js(card.ref)))").trimmingCharacters(in: .whitespacesAndNewlines)
    return (out.hasPrefix("=>") ? String(out.dropFirst(2)) : out).trimmingCharacters(in: .whitespacesAndNewlines)
  }

  func open(_ card: Card) async throws {
    _ = try await eval("kb.openTask(\(try js(card.file)),\(card.line))")
    NSRunningApplication.runningApplications(withBundleIdentifier: "md.obsidian").first?
      .activate(options: [.activateAllWindows])
  }

  private func js(_ s: some Encodable) throws -> String {
    String(decoding: try JSONEncoder().encode(s), as: UTF8.self)
  }

  private func eval(_ code: String) async throws -> String {
    try await run(["eval", "code=\(code)"])
  }

  private func run(_ arguments: [String]) async throws -> String {
    guard !NSRunningApplication.runningApplications(withBundleIdentifier: "md.obsidian").isEmpty else {
      throw ObsidianError("Obsidian is not running.")
    }
    return try await withCheckedThrowingContinuation { continuation in
      DispatchQueue.global().async {
        let process = Process(), out = Pipe(), err = Pipe()
        process.executableURL = URL(fileURLWithPath: Self.executable)
        process.arguments = arguments
        process.standardOutput = out
        process.standardError = err
        do { try process.run() } catch { continuation.resume(throwing: error); return }
        let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + 30, execute: timeout)
        let stdout = out.fileHandleForReading.readDataToEndOfFile()
        let stderr = err.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        timeout.cancel()
        if process.terminationStatus == 0 {
          continuation.resume(returning: String(decoding: stdout, as: UTF8.self))
        } else {
          let message = String(decoding: stderr, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
          continuation.resume(throwing: ObsidianError(message.isEmpty ? "obsidian eval failed." : message))
        }
      }
    }
  }
}
