import AppKit
import Foundation
import ServiceManagement

@MainActor
final class TaskStore: ObservableObject {
  @Published private(set) var tasks: [DoingTask]
  @Published private(set) var sections: [TaskSection]
  @Published private(set) var recentHours: Int
  @Published private(set) var moving = Set<String>()
  @Published private(set) var isLoading = false
  @Published private(set) var isOffline = false
  @Published private(set) var hasRefreshed = false
  @Published private(set) var lastCompletedTask: DoingTask?
  @Published var errorMessage: String?
  @Published private(set) var launchesAtLogin = SMAppService.mainApp.status == .enabled

  private let cli = ObsidianCLI()
  private let cacheKey = "doing-tasks.cache"
  private let recentHoursKey = "doing-tasks.recent-hours"
  private var doneTaskIDs: Set<String>?
  private var refreshLoop: _Concurrency.Task<Void, Never>?
  private var undoClearTask: _Concurrency.Task<Void, Never>?

  init(startRefreshLoop: Bool = true) {
    let cached = Self.readCache(key: "doing-tasks.cache")
    tasks = cached
    sections = [TaskSection(name: "Doing", tasks: cached)]
    let savedHours = UserDefaults.standard.integer(forKey: "doing-tasks.recent-hours")
    recentHours = savedHours > 0 ? savedHours : 24
    if startRefreshLoop {
      refreshLoop = _Concurrency.Task { [weak self] in
        while !_Concurrency.Task.isCancelled {
          await self?.refresh()
          try? await _Concurrency.Task.sleep(for: .seconds(5))
        }
      }
    }
  }

  deinit {
    refreshLoop?.cancel()
    undoClearTask?.cancel()
  }

  func refresh() async {
    isLoading = true
    defer { isLoading = false }
    do {
      guard try await cli.isObsidianRunning() else {
        isOffline = true
        return
      }
      let freshSections = try await cli.fetchTaskSections(hours: recentHours)
      let done = try await cli.fetchDoneTaskIDs()
      observeDone(done)
      sections = freshSections
      tasks = freshSections.first { $0.id == "doing" }?.tasks ?? []
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
    await move(task, to: "Done")
    guard !tasks.contains(where: { $0.id == task.id }) else { return }
    lastCompletedTask = task
    undoClearTask?.cancel()
    undoClearTask = _Concurrency.Task { [weak self] in
      try? await _Concurrency.Task.sleep(for: .seconds(10))
      guard !_Concurrency.Task.isCancelled else { return }
      self?.lastCompletedTask = nil
    }
  }

  func undoComplete() async {
    guard let task = lastCompletedTask else { return }
    undoClearTask?.cancel()
    await move(task, to: "Doing")
    if tasks.contains(where: { $0.id == task.id }) { lastCompletedTask = nil }
  }

  func move(_ task: DoingTask, to column: String) async {
    moving.insert(task.id)
    defer { moving.remove(task.id) }
    do {
      try await cli.move(task, to: column)
      for index in sections.indices { sections[index].tasks.removeAll { $0.id == task.id } }
      if let index = sections.firstIndex(where: { $0.name.caseInsensitiveCompare(column) == .orderedSame }) {
        sections[index].tasks.append(task)
      }
      tasks = sections.first { $0.id == "doing" }?.tasks ?? []
      saveCache()
      if let done = try? await cli.fetchDoneTaskIDs() { observeDone(done, celebrate: false) }
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func task(id: String) -> DoingTask? {
    sections.lazy.flatMap(\.tasks).first { $0.id == id }
  }

  func open(_ task: DoingTask) async {
    do {
      try await cli.open(task)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func setRecentHours(_ hours: Int) {
    recentHours = min(168, max(1, hours))
    UserDefaults.standard.set(recentHours, forKey: recentHoursKey)
    _Concurrency.Task { await refresh() }
  }

  private func observeDone(_ current: Set<String>, celebrate: Bool = true) {
    defer { doneTaskIDs = current }
    guard celebrate, let previous = doneTaskIDs, !current.subtracting(previous).isEmpty else { return }
    launchConfetti()
  }

  private func launchConfetti() {
    guard let confetti = URL(string: "raycast://extensions/raycast/raycast/confetti") else { return }
    NSWorkspace.shared.open(confetti)
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
