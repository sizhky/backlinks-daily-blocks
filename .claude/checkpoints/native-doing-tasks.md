---
thread: native-doing-tasks
project: backlinks-daily-blocks
summary: Config-driven native task sections and recent-hours settings are installed for validation
---

## Goal
Keep Doing tasks visible outside Obsidian and let Yeshwanth complete them from the menu bar.

## Context
- The Obsidian plugin owns task data and exposes it through `kb.active()` and `kb.moveTask()`.
- The native app is installed at `~/Applications/Doing Tasks.app`.
- The current kanban card is `20260810-1049.md:8` in Doing.

## Decisions
- Opening the panel is the acknowledgement that clears the marker.
- An orange pill pulses behind the full status label until opening the panel clears the unseen count.
- The unseen count tracks task IDs and shrinks when an unseen task leaves Doing.
- Any newly observed `Doing → Done` transition launches Raycast Confetti, including moves from Obsidian or CLI.
- Moves made inside the native menu skip Raycast Confetti, so its transient popover stays open.
- The panel follows the Obsidian column config, including empty and terminal columns.
- Doing is always first, expanded, and unfiltered; other sections persist collapse state across restarts.
- Non-Doing sections are collapsible and time-filtered; headers show all task-title emojis.
- All task rows drag between sections through `kb.moveTask()`.
- A native Settings window controls the 1–168 hour filter; default is 24.
- Task-title clicks open the exact source line and activate Obsidian; only the square completes Doing tasks.
- Checkbox and hamburger controls use the same 18-point leading column.
- Task rows show Copy title at the right edge on hover; the footer Undo control is removed.

## Next
Yeshwanth validates task navigation, row-title copy, collapse, drag/drop, and settings.

## Resume
The installed panel follows Obsidian's columns with Doing first, persisted collapse state, emojis, drag/drop, and time settings. Task-title navigation now opens the exact line and activates Obsidian through AppKit. Native tests and the foreground trace pass. Keep the kanban task in Doing until Yeshwanth validates the UI.

## Working Set

### Files
- `native/doing-tasks/Sources/DoingTasks/StatusPanelController.swift` — status title, marker, panel acknowledgement, and pulse.
- `native/doing-tasks/Sources/DoingTasks/TaskStore.swift` — refresh baseline and task state.
- `native/doing-tasks/Sources/DoingTasks/TaskListView.swift` — sections and drag behavior.
- `native/doing-tasks/Sources/DoingTasks/SettingsWindowController.swift` — recent-hours setting.

### Discoveries
- `TaskStore.refresh()` is the authoritative successful-refresh boundary.
- Opening Raycast Confetti during a local move takes focus from the transient popup and closes it.
- `moveCard()` now infers an omitted source column from checkbox state or the task's `#kb/` tag.
- `kb.board({hours:24,full:"Doing"})` returns configured columns and scoped tasks.
- Filename recency only accepts the documented leading daily-note timestamp.

### Artifacts
- Installed `~/Applications/Doing Tasks.app` with `make install`.
- Native refresh interval is 5 seconds during pulse debugging.
