// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "KanbanBoard",
  platforms: [.macOS(.v26)],
  targets: [
    .target(name: "KanbanCore"),
    .executableTarget(name: "KanbanBoard", dependencies: ["KanbanCore"]),
    .testTarget(name: "KanbanCoreTests", dependencies: ["KanbanCore"]),
  ],
  swiftLanguageModes: [.v5]
)
