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
  /// Appends org and projects frontmatter to each row, then the task's 1-based ordinal among the
  /// note's checkbox list items (metadata cache) and their count, which `Card.identifier` uses; done (`=x`) rows carry the ISO done time,
  /// then est and took (always two fields), then the ISO time a live card entered its column (`Card.since`).
  static func boardScript(doneHours: Int) -> String {
    #"""
    (async()=>{
    const P=app.plugins.plugins["backlinks-daily-blocks"];
    const defs=String(P.settings.kanban.columns).split(/\r?\n|,/).map(s=>s.trim()).filter(Boolean).map(s=>{const n=s.split(/\s+@/)[0];return{name:n.replace(/=.$/,"").replace(/[~!]$/,""),term:/=.$/.test(n),x:/=x$/.test(n)}});
    const rows=s=>s.split("\n").map(l=>l.split("\t")).filter(c=>c.length>=4&&c[0]!=="@column");
    const act=rows(await kb.active({includePaused:true,timestamps:true,rank:true,desktop:true})).map(c=>[c[0],c[1],c[2],c[3],c[5],c[6],c[4]]);
    const est=new Map(String(await kb.estimates()).split("\n").filter(Boolean).map(l=>{const p=l.split("\t");return[p[0],p.slice(1)]}));
    const brd=rows(await kb.board({hours:\#(doneHours),full:"Doing",timestamps:true}));
    const v=(f,k)=>{const x=f&&f[k];return x==null?"":[].concat(x).map(s=>String(s).replace(/^\[\[|\]\]$/g,"").split("|")[0]).join("|")};
    const out=[];
    for(const d of defs){out.push("@column\t"+d.name+"\t"+(d.term?"done":"live"));
    for(const c of (d.term?brd:act).filter(c=>c[0].toLowerCase()===d.name.toLowerCase())){
    const m=app.metadataCache.getCache(c[1].replace(/:\d+$/,"")),f=m?.frontmatter,ln=+c[1].split(":").pop();
    const ts=(m?.listItems||[]).filter(i=>i.task!==undefined),n=ts.findIndex(i=>i.position.start.line===ln)+1;
    out.push([c[0],c[1],c[2],c[3],v(f,"org"),v(f,"projects"),d.term?"":(c[4]||""),d.term?"":(c[5]||""),n||"",n?ts.length:"",d.x?(c[4]||""):""].concat(est.get(c[1])||["",""],[d.term?"":(c[6]||"")]).join("\t"));}}
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

  /// Moves refs with the history stamp backdated to `at` (kb.moveTasks); the plugin skips a
  /// card that moved after `at`.
  func move(refs: [String], to column: String, at: Date) async throws {
    let iso = ISO8601DateFormatter().string(from: at)
    _ = try await eval("kb.moveTasks(\(try js(refs)),\(try js(column)),{at:\(try js(iso))})")
  }

  /// Doing stints of one day (`kb.chronicle`), rows `HHMM:HHMM[~]<TAB>dur<TAB>title`.
  func chronicle(_ day: Date) async throws -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyyMMdd"
    return try await eval("kb.chronicle(\(f.string(from: day)))")
  }

  /// Absolute path of the vault folder (desktop adapter `basePath`).
  func vaultPath() async throws -> String {
    let out = try await eval("app.vault.adapter.basePath").trimmingCharacters(in: .whitespacesAndNewlines)
    let path = (out.hasPrefix("=>") ? String(out.dropFirst(2)) : out).trimmingCharacters(in: .whitespaces)
    guard path.hasPrefix("/") else { throw ObsidianError("No vault path: " + String(path.prefix(120))) }
    return path
  }

  /// Stores the card's time guess in minutes (kb.setEstimate).
  func setEstimate(_ card: Card, minutes: Int) async throws {
    _ = try await eval("kb.setEstimate(\(try js(card.ref)),\(minutes))")
  }

  /// Sets (a desktop name or 1 to 9) or clears (nil) the card's desktop line (kb.setDesktop).
  func setDesktop(_ card: Card, _ ref: String?) async throws {
    _ = try await eval("kb.setDesktop(\(try js(card.ref)),\(try ref.map { try js($0) } ?? "null"))")
  }

  /// Writes manual ranks (kb.rankTasks); cards not in `column` move there first.
  func rank(_ pairs: [(ref: String, rank: Double)], in column: String) async throws {
    let list = try pairs.map { "[\(try js($0.ref)),\($0.rank)]" }.joined(separator: ",")
    _ = try await eval("kb.rankTasks([\(list)],\(try js(column)))")
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

  /// Runs `code` in Obsidian and returns its value as the CLI prints it (`=> value`).
  /// The CLI does not reliably wait for promises: async results often came back as empty output
  /// with exit 0 (even a 50 ms timer), while synchronous evals always worked. So every call is two
  /// synchronous evals: start the code and park its result in `window.__kbr[id]`, then poll for it.
  private func eval(_ code: String) async throws -> String {
    let id = UUID().uuidString
    let start = "(()=>{const S=(window.__kbr=window.__kbr||{});S['\(id)']=null;"
      + "Promise.resolve().then(()=>(\(code))).then(v=>{S['\(id)']={ok:v==null?'':String(v)}},"
      + "e=>{S['\(id)']={err:String(e&&e.stack||e)}});return 'started'})()"
    _ = try await run(["eval", "code=\(start)"])
    let fetch = "(()=>{const S=window.__kbr||{},r=S['\(id)'];if(r==null)return '\(Self.pending)';delete S['\(id)'];"
      + "return r.err!=null?'\(Self.failed)'+r.err:'\(Self.done)'+r.ok})()"
    let deadline = Date().addingTimeInterval(30)
    while Date() < deadline {
      let raw = try await run(["eval", "code=\(fetch)"])
      let out = raw.hasPrefix("=> ") ? String(raw.dropFirst(3)) : raw
      if out.hasPrefix(Self.done) {
        var value = String(out.dropFirst(Self.done.count))
        if value.hasSuffix("\n") { value.removeLast() }
        return "=> " + value
      }
      if out.hasPrefix(Self.failed) { throw ObsidianError(String(out.dropFirst(Self.failed.count)).trimmingCharacters(in: .whitespacesAndNewlines)) }
      try await Task.sleep(for: .milliseconds(40))
    }
    throw ObsidianError("Obsidian did not answer within 30 s")
  }

  private static let pending = "KBR:pending", done = "KBR:ok:", failed = "KBR:err:"

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
