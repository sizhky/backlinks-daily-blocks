import AppKit
import SwiftUI

struct TaskListView: View {
  @ObservedObject var store: TaskStore
  let showSettings: () -> Void
  @State private var collapsed = Set<String>()
  @State private var hoveredTaskID: String?
  private static let collapsedKey = "doing-tasks.collapsed-sections"

  init(store: TaskStore, showSettings: @escaping () -> Void = {}) {
    self.store = store
    self.showSettings = showSettings
    let saved = UserDefaults.standard.stringArray(forKey: Self.collapsedKey) ?? []
    _collapsed = State(initialValue: Set(saved).subtracting(["doing"]))
  }

  var body: some View {
    VStack(spacing: 0) {
      header
      Divider()
      status
      taskList
      Divider()
      footer
    }
    .frame(width: 420, height: 480)
  }

  private var header: some View {
    HStack {
      Text("Tasks").font(.headline)
      Spacer()
      if store.isLoading { ProgressView().controlSize(.small) }
      Button("Collapse All") {
        setCollapsed(Set(store.sections.filter { $0.id != "doing" }.map(\.id)))
      }
      .buttonStyle(.plain)
      .font(.caption)
      Button { _Concurrency.Task { await store.refresh() } } label: {
        Image(systemName: "arrow.clockwise")
      }
      .buttonStyle(.plain)
      .help("Refresh")
      Button(action: showSettings) { Image(systemName: "gearshape") }
        .buttonStyle(.plain)
        .help("Settings")
    }
    .padding(14)
  }

  @ViewBuilder private var status: some View {
    if store.lastCompletedTask != nil {
      HStack {
        Text("Task marked done").foregroundStyle(.secondary)
        Spacer()
        Button("Undo") { _Concurrency.Task { await store.undoComplete() } }
          .buttonStyle(.plain)
          .foregroundStyle(.tint)
      }
      .font(.caption)
      .padding(.horizontal, 14)
      .padding(.vertical, 8)
    }
    if store.isOffline {
      Text("Obsidian is closed · showing saved tasks")
        .font(.caption)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }
    if let message = store.errorMessage {
      Text(message)
        .font(.caption)
        .foregroundStyle(.red)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }
  }

  private var taskList: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        ForEach(orderedSections) { section in sectionView(section) }
      }
    }
  }

  private var orderedSections: [TaskSection] {
    let doing = store.sections.filter { $0.id == "doing" }
    return doing + store.sections.filter { $0.id != "doing" }
  }

  private func sectionView(_ section: TaskSection) -> some View {
    VStack(spacing: 0) {
      sectionHeader(section)
      if !collapsed.contains(section.id) {
        if section.tasks.isEmpty {
          Text("Drag a task here")
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, minHeight: 46)
        }
        ForEach(section.tasks) { task in
          taskRow(task, in: section)
            .draggable(task.id)
          Divider().padding(.leading, 38)
        }
      }
    }
    .dropDestination(for: String.self) { references, _ in
      guard let task = references.lazy.compactMap({ store.task(id: $0) }).first else { return false }
      _Concurrency.Task { await store.move(task, to: section.name) }
      return true
    }
  }

  @ViewBuilder private func sectionHeader(_ section: TaskSection) -> some View {
    if section.id == "doing" {
      sectionHeaderContent(section, collapsible: false)
    } else {
      Button {
        var next = collapsed
        if next.contains(section.id) { next.remove(section.id) }
        else { next.insert(section.id) }
        setCollapsed(next)
      } label: {
        sectionHeaderContent(section, collapsible: true)
      }
      .buttonStyle(.plain)
    }
  }

  private func setCollapsed(_ sections: Set<String>) {
    collapsed = sections.subtracting(["doing"])
    UserDefaults.standard.set(Array(collapsed).sorted(), forKey: Self.collapsedKey)
  }

  private func sectionHeaderContent(_ section: TaskSection, collapsible: Bool) -> some View {
    HStack {
      if collapsible {
        Image(systemName: collapsed.contains(section.id) ? "chevron.right" : "chevron.down")
          .font(.caption2)
      }
      Text(section.name).font(.caption).fontWeight(.semibold)
      Text("\(section.tasks.count)").font(.caption).foregroundStyle(.secondary)
      let sectionEmojiText = section.tasks.flatMap(\.emojis).joined()
      if !sectionEmojiText.isEmpty { Text(sectionEmojiText).font(.caption) }
      Spacer()
      if section.id != "doing" {
        Text("\(store.recentHours)h").font(.caption2).foregroundStyle(.secondary)
      }
    }
    .contentShape(Rectangle())
    .frame(maxWidth: .infinity)
    .padding(.horizontal, 14)
    .padding(.vertical, 8)
    .background(.quaternary)
  }

  @ViewBuilder private func taskRow(_ task: DoingTask, in section: TaskSection) -> some View {
    Group {
      if section.id == "doing" { doingRow(task) }
      else { draggableRow(task) }
    }
    .onHover { hovering in
      if hovering { hoveredTaskID = task.id }
      else if hoveredTaskID == task.id { hoveredTaskID = nil }
    }
  }

  private func doingRow(_ task: DoingTask) -> some View {
    HStack(spacing: 10) {
      Button { _Concurrency.Task { await store.complete(task) } } label: {
        Image(systemName: "square").frame(width: 18)
      }
      .buttonStyle(.plain)
      .help("Complete task")
      .disabled(store.moving.contains(task.id))
      taskButton(task)
      Spacer()
      if hoveredTaskID == task.id { copyTitleButton(task) }
    }
    .contentShape(Rectangle())
    .padding(.horizontal, 14)
  }

  private func draggableRow(_ task: DoingTask) -> some View {
    HStack(spacing: 10) {
      Image(systemName: "line.3.horizontal")
        .foregroundStyle(.secondary)
        .frame(width: 18)
      taskButton(task)
      Spacer()
      if hoveredTaskID == task.id { copyTitleButton(task) }
    }
    .contentShape(Rectangle())
    .padding(.horizontal, 14)
  }

  private func taskButton(_ task: DoingTask) -> some View {
    Button { _Concurrency.Task { await store.open(task) } } label: {
      taskLabel(task).frame(maxWidth: .infinity, alignment: .leading)
    }
    .buttonStyle(.plain)
  }

  private func taskLabel(_ task: DoingTask) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(task.body).lineLimit(2)
      Text("\(task.age) · \(task.file)")
        .font(.caption)
        .foregroundStyle(.secondary)
    }
    .padding(.vertical, 9)
  }

  private func copyTitleButton(_ task: DoingTask) -> some View {
    Button {
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(task.body, forType: .string)
    } label: {
      Image(systemName: "doc.on.doc")
    }
    .buttonStyle(.plain)
    .help("Copy title")
    .accessibilityLabel("Copy title")
  }

  private var footer: some View {
    HStack {
      Spacer()
      Toggle(
        "Launch at Login",
        isOn: Binding(
          get: { store.launchesAtLogin },
          set: { store.setLaunchAtLogin($0) }
        )
      )
      .toggleStyle(.switch)
      .controlSize(.small)
      Button("Quit") { NSApplication.shared.terminate(nil) }
    }
    .padding(12)
  }
}
