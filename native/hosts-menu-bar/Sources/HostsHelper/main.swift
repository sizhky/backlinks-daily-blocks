import Foundation
import HostsCore

final class HostsLockService: NSObject, HostsLockProtocol {
  func lockHosts(withReply reply: @escaping (NSString?) -> Void) {
    do { try HostsFile.lock(); reply(nil) }
    catch { reply(String(describing: error) as NSString) }
  }
}

final class ListenerDelegate: NSObject, NSXPCListenerDelegate {
  func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
    connection.exportedInterface = NSXPCInterface(with: HostsLockProtocol.self)
    connection.exportedObject = HostsLockService()
    connection.resume()
    return true
  }
}

@main
struct HostsHelper {
  static func main() {
    if CommandLine.arguments.contains("--unlock") {
      do { try HostsFile.unlock(); exit(EXIT_SUCCESS) }
      catch { fputs("Hosts Helper: \(error)\n", stderr); exit(EXIT_FAILURE) }
    }
    guard CommandLine.arguments.count == 1 else { exit(EXIT_FAILURE) }
    let delegate = ListenerDelegate()
    let listener = NSXPCListener(machServiceName: hostsLockServiceName)
    listener.delegate = delegate
    listener.resume()
    dispatchMain()
  }
}
