import Foundation
import ServiceManagement

@MainActor
final class TaskStore: ObservableObject {
  @Published private(set) var tasks: [DoingTask]
  @Published private(set) var moving = Set<String>()
  @Published private(set) var isLoading = false
  @Published private(set) var isOffline = false
  @Published private(set) var hasRefreshed = false
  @Published var errorMessage: String?
  @Published private(set) var lastCompleted: DoingTask?
  @Published private(set) var launchesAtLogin = SMAppService.mainApp.status == .enabled

  private let cli = ObsidianCLI()
  private let cacheKey = "doing-tasks.cache"
  private var refreshLoop: _Concurrency.Task<Void, Never>?

  init(startRefreshLoop: Bool = true) {
    tasks = Self.readCache(key: cacheKey)
    if startRefreshLoop {
      refreshLoop = _Concurrency.Task { [weak self] in
        while !_Concurrency.Task.isCancelled {
          await self?.refresh()
          try? await _Concurrency.Task.sleep(for: .seconds(60))
        }
      }
    }
  }

  deinit { refreshLoop?.cancel() }

  func refresh() async {
    isLoading = true
    defer { isLoading = false }
    do {
      guard try await cli.isObsidianRunning() else {
        isOffline = true
        return
      }
      let fresh = try await cli.fetchDoingTasks()
      tasks = fresh
      saveCache()
      hasRefreshed = true
      isOffline = false
      errorMessage = nil
    } catch {
      isOffline = true
      errorMessage = error.localizedDescription
    }
  }

  func complete(_ task: DoingTask) async {
    moving.insert(task.id)
    defer { moving.remove(task.id) }
    do {
      try await cli.move(task, to: "Done")
      tasks.removeAll { $0.id == task.id }
      lastCompleted = task
      saveCache()
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func undo() async {
    guard let task = lastCompleted else { return }
    do {
      try await cli.move(task, to: "Doing")
      lastCompleted = nil
      await refresh()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func setLaunchAtLogin(_ enabled: Bool) {
    do {
      if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
      launchesAtLogin = SMAppService.mainApp.status == .enabled
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func saveCache() {
    guard let data = try? JSONEncoder().encode(tasks) else { return }
    UserDefaults.standard.set(data, forKey: cacheKey)
  }

  private static func readCache(key: String) -> [DoingTask] {
    guard let data = UserDefaults.standard.data(forKey: key) else { return [] }
    return (try? JSONDecoder().decode([DoingTask].self, from: data)) ?? []
  }
}
