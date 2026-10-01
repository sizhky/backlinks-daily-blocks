// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "HostsMenuBar",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "HostsMenuBar", targets: ["HostsMenuBar"]),
    .executable(name: "HostsHelper", targets: ["HostsHelper"]),
  ],
  targets: [
    .target(name: "HostsCore"),
    .executableTarget(name: "HostsMenuBar", dependencies: ["HostsCore"]),
    .executableTarget(name: "HostsHelper", dependencies: ["HostsCore"]),
  ]
)
