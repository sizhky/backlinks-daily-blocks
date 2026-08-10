import AppKit
import SwiftUI

struct TaskListView: View {
  @ObservedObject var store: TaskStore

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
      Text("Doing").font(.headline)
      Text("\(store.tasks.count)").foregroundStyle(.secondary)
      Spacer()
      if store.isLoading { ProgressView().controlSize(.small) }
      Button { _Concurrency.Task { await store.refresh() } } label: {
        Image(systemName: "arrow.clockwise")
      }
      .buttonStyle(.plain)
      .help("Refresh")
    }
    .padding(14)
  }

  @ViewBuilder private var status: some View {
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
        if store.tasks.isEmpty {
          VStack(spacing: 10) {
            Image(systemName: "checkmark.circle")
              .font(.largeTitle)
              .foregroundStyle(.secondary)
            Text("No tasks in Doing").foregroundStyle(.secondary)
          }
            .frame(maxWidth: .infinity, minHeight: 300)
        }
        ForEach(store.tasks) { task in
          taskRow(task)
          Divider().padding(.leading, 38)
        }
      }
    }
  }

  private func taskRow(_ task: DoingTask) -> some View {
    Toggle(
      isOn: Binding(
        get: { false },
        set: { checked in
          if checked { _Concurrency.Task { await store.complete(task) } }
        }
      )
    ) {
      VStack(alignment: .leading, spacing: 3) {
        Text(task.body).lineLimit(2)
        Text("\(task.age) · \(task.file)")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      .padding(.vertical, 9)
    }
    .toggleStyle(.checkbox)
    .disabled(store.moving.contains(task.id))
    .padding(.horizontal, 14)
  }

  private var footer: some View {
    HStack {
      if let task = store.lastCompleted {
        Button("Undo “\(task.body)”") { _Concurrency.Task { await store.undo() } }
          .lineLimit(1)
      }
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
