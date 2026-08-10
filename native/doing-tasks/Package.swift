// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "DoingTasks",
  platforms: [.macOS(.v13)],
  products: [.executable(name: "DoingTasks", targets: ["DoingTasks"])],
  targets: [
    .executableTarget(name: "DoingTasks"),
    .testTarget(name: "DoingTasksTests", dependencies: ["DoingTasks"]),
  ]
)
