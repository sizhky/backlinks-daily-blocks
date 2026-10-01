import KanbanCore
import SwiftUI

/// Type to search workspaces, return or click to add; backspace on empty text removes the last.
/// Nothing selected means all workspaces.
struct OrgPicker: View {
  @EnvironmentObject var store: BoardStore
  @Binding var selected: [String]
  @State private var text = ""
  @State private var highlight = 0
  @FocusState private var focused: Bool

  static func label(_ org: String) -> String { org == Filter.noOrg ? "No organization" : org }

  private var suggestions: [String] {
    let all = store.orgs.map(\.name) + [Filter.noOrg]
    let words = text.lowercased().split(separator: " ")
    return all.filter { org in
      !selected.contains(org) && words.allSatisfy { Self.label(org).lowercased().contains($0) }
    }
  }

  var body: some View {
    let options = suggestions
    VStack(alignment: .leading, spacing: 4) {
      FlowLayout(spacing: 6) {
        ForEach(selected, id: \.self) { org in chip(org) }
        TextField(selected.isEmpty ? "All workspaces" : "Add workspace", text: $text)
          .textFieldStyle(.plain).font(.system(size: 13)).focused($focused)
          .frame(minWidth: 120, idealWidth: 180, minHeight: 24)
          .onSubmit { add(options) }
          .onKeyPress(.downArrow) { highlight = min(options.count - 1, highlight + 1); return .handled }
          .onKeyPress(.upArrow) { highlight = max(0, highlight - 1); return .handled }
          .onKeyPress(.delete) {
            guard text.isEmpty, !selected.isEmpty else { return .ignored }
            selected.removeLast(); return .handled
          }
          .onChange(of: text) { highlight = 0 }
      }
      .padding(.horizontal, 8).padding(.vertical, 5)
      .background(Color.white.opacity(0.04), in: .rect(cornerRadius: 7))
      .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(focused ? Palette.indigo : Palette.hairline))
      if focused && !options.isEmpty {
        VStack(spacing: 1) {
          ForEach(Array(options.prefix(6).enumerated()), id: \.element) { i, org in
            HStack(spacing: 9) {
              icon(org)
              Text(Self.label(org)).font(.system(size: 13))
              Spacer()
              Text("\(store.doingCount(org: org))").font(.system(size: 11).monospacedDigit()).foregroundStyle(Palette.muted)
            }
            .padding(.horizontal, 8).frame(height: 28)
            .background(i == highlight ? Palette.active : .clear, in: .rect(cornerRadius: 6))
            .contentShape(Rectangle())
            .onTapGesture { selected.append(org); text = ""; focused = true }
          }
        }
        .padding(4)
        .background(Palette.card, in: .rect(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Palette.hairlineStrong))
      }
    }
  }

  private func add(_ options: [String]) {
    guard options.indices.contains(highlight) else { return }
    selected.append(options[highlight])
    text = ""
  }

  @ViewBuilder private func icon(_ org: String) -> some View {
    if org == Filter.noOrg { Image(systemName: "tray").font(.system(size: 11)).frame(width: 16) }
    else { OrgIcon(name: org, size: 16).clipShape(.circle) }
  }

  private func chip(_ org: String) -> some View {
    HStack(spacing: 6) {
      icon(org)
      Text(Self.label(org)).font(.system(size: 12.5, weight: .medium))
      Button { selected.removeAll { $0 == org } } label: { Image(systemName: "xmark").font(.system(size: 8, weight: .bold)) }
        .buttonStyle(.plain).foregroundStyle(Palette.muted)
    }
    .padding(.horizontal, 8).frame(height: 24)
    .background(Color.white.opacity(0.06), in: .capsule)
    .overlay(Capsule().strokeBorder(Palette.hairline))
  }
}
