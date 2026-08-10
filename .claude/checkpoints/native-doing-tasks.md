---
thread: native-doing-tasks
project: backlinks-daily-blocks
summary: Native and Raycast menu-bar clients for Obsidian Doing tasks; native visibility marker awaits manual validation
---

## Goal
Keep Doing tasks visible outside Obsidian and let Yeshwanth complete them from the menu bar.

## Context
- The Obsidian plugin owns task data and exposes it through `kb.active()` and `kb.moveTask()`.
- The native app is installed at `~/Applications/Doing Tasks.app`.
- The project kanban card is `20260810-0846.md:6` and stays in Doing until Yeshwanth tests the UI.

## Decisions
- Native macOS is the active client for the new-task visibility marker.
- Opening the panel is the acknowledgement that clears the marker.
- The first successful refresh establishes the launch baseline.

## Open
- Manual UI check: confirm the orange pulse and persistent `(+N)` marker.
- Raycast publish check: replace the package author with the registered Raycast username.

## Next
Launch the installed app, add a task to Doing, wait for refresh, then open the panel and confirm the marker clears.

## Resume
We built menu-bar clients for Doing tasks and installed the native app. Yeshwanth asked for stronger visibility when the task count increases. The code and automated tests are complete; manual UI validation is next. Keep the kanban task in Doing until he confirms.

## Working Set

### Files
- `native/doing-tasks/Sources/DoingTasks/StatusPanelController.swift` — status title, marker, panel acknowledgement, and pulse.
- `native/doing-tasks/Sources/DoingTasks/TaskStore.swift` — refresh baseline and task state.
- `raycast/doing-tasks/src/doing-tasks.tsx` — Raycast menu-bar client.

### Discoveries
- `TaskStore.refresh()` is the authoritative successful-refresh boundary.
- `StatusPanelController.show()` is the single panel-open path.

### Artifacts
- Installed `~/Applications/Doing Tasks.app` with `make install`.
