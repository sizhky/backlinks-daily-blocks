import Darwin
import Foundation

public let hostsLockServiceName = "com.yeshwanth.hosts-menu-bar-passwordless-lock.lock-helper"
public let hostsHelperPath = "/Library/PrivilegedHelperTools/com.yeshwanth.hosts-menu-bar-passwordless-lock"
public let hostsDaemonPath = "/Library/LaunchDaemons/com.yeshwanth.hosts-menu-bar-passwordless-lock.plist"
public let hostsDaemonLabel = "com.yeshwanth.hosts-menu-bar-passwordless-lock"

@objc public protocol HostsLockProtocol {
  func lockHosts(withReply reply: @escaping (NSString?) -> Void)
}

public enum HostsFile {
  public static let path = "/etc/hosts"

  public static func hasActiveMappings() throws -> Bool {
    let lines = try String(contentsOfFile: path, encoding: .utf8).components(separatedBy: "\n")
    guard let marker = lines.firstIndex(where: { $0.contains("----") }) else { throw HostsError.missingSeparator }
    return lines.dropFirst(marker + 1).contains { isMapping($0) && !isCommented($0) }
  }

  public static func lock() throws { try update(commented: false) }
  public static func unlock() throws { try update(commented: true) }

  private static func update(commented: Bool) throws {
    let url = URL(fileURLWithPath: path)
    let original = try String(contentsOf: url, encoding: .utf8)
    var lines = original.components(separatedBy: "\n")
    guard let marker = lines.firstIndex(where: { $0.contains("----") }) else { throw HostsError.missingSeparator }
    let indexes = lines.indices.filter { $0 > marker && isMapping(lines[$0]) }
    guard !indexes.isEmpty else { throw HostsError.noMappings }
    if indexes.allSatisfy({ isCommented(lines[$0]) == commented }) { return }
    for index in indexes { lines[index] = setComment(lines[index], commented: commented) }
    let permissions = try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions]
    try Data(lines.joined(separator: "\n").utf8).write(to: url, options: .atomic)
    if let permissions { try FileManager.default.setAttributes([.posixPermissions: permissions], ofItemAtPath: path) }
    flushDNSCache()
  }

  private static func isMapping(_ line: String) -> Bool {
    let value = uncomment(line).trimmingCharacters(in: .whitespaces)
    let fields = value.split(whereSeparator: \.isWhitespace)
    guard fields.count > 1 else { return false }
    var v4 = in_addr(), v6 = in6_addr()
    return fields[0].withCString { inet_pton(AF_INET, $0, &v4) == 1 || inet_pton(AF_INET6, $0, &v6) == 1 }
  }

  private static func isCommented(_ line: String) -> Bool { line.drop(while: \.isWhitespace).hasPrefix("#") }

  private static func uncomment(_ line: String) -> String {
    let prefix = String(line.prefix(while: \.isWhitespace))
    var body = line.dropFirst(prefix.count)
    if body.hasPrefix("#") { body = body.dropFirst().drop(while: { $0 == " " || $0 == "\t" }) }
    return prefix + body
  }

  private static func setComment(_ line: String, commented: Bool) -> String {
    let prefix = String(line.prefix(while: \.isWhitespace))
    let body = String(line.dropFirst(prefix.count))
    if commented { return isCommented(line) ? line : prefix + "# " + body }
    return isCommented(line) ? uncomment(line) : line
  }

  private static func flushDNSCache() {
    for (path, args) in [("/usr/bin/dscacheutil", ["-flushcache"]), ("/usr/bin/killall", ["-HUP", "mDNSResponder"])] {
      let process = Process()
      process.executableURL = URL(fileURLWithPath: path)
      process.arguments = args
      do { try process.run(); process.waitUntilExit() } catch { continue }
    }
  }
}

public enum HostsError: Error {
  case missingSeparator
  case noMappings
}
