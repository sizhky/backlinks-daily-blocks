# Kanban Board (native macOS app)

SwiftUI app (macOS 26, Swift 6.2 tools, Swift 5 language mode) that shows the Obsidian kanban
board from the `backlinks-daily-blocks` plugin. It is a client: it never reads or writes vault
files for tasks. All task data and moves go through `obsidian eval` and the plugin's global `kb`.
It does not depend on `native/doing-tasks`.

## Map

```
Sources/KanbanCore/    pure logic, no UI, fully unit-tested
  Card.swift           Card, Column, Board.parse (kb output -> model), identifier, created
  Query.swift          query text -> QueryTerm; format; toggling (single-valued keys); expression -> QueryExpr (and/or/parens, Timeline filter)
  Catalog.swift        keys and values the filter field and palette complete (`Catalog.make`, `suggest`)
  Filter.swift         term matching, org scope, SavedFilter (a "view")
  Grouping.swift       group cards by project
  Title.swift          [[wikilinks]] / [text](url) -> segments
  Logbook.swift        done cards grouped by finish day (Logbook mode)
  Activity.swift       Sample, Span, SpanBuilder, ActivityRule, SwitchEngine
  Desktops.swift       DesktopSpace, Desktops.parse/resolve/cleanLabel (desktop names by Space UUID)
  DoingChange.swift    diff of live cards between two refreshes (widget toast)
  Hex.swift            #RRGGBB[AA] parse and format (widget colour setting)
  Timeline.swift       ActivityLog.parse/rows/totals/unionSeconds/stints/blocks/sessions/lanes, TimelineRow, DoingStint
                       DayLine logs in <vault>/.activity/: ActiveStretch (YYYYMMDD-active.jsonl, card was active),
                       BreakSpan (YYYYMMDD-breaks.jsonl, break key / cup); parseLines/splitByDay/activeParts
  Report.swift         ReportCard.parse, Report.attribute/series/tree, Allocation, ReportNode; Stretch, Report.states/desktops (Reports tab)
Sources/KanbanBoard/   SwiftUI app
  Obsidian.swift       the only file that talks to Obsidian (ObsidianClient)
  ActivityMonitor.swift 5 s sampler (app, AX title, browser URL, desktop) -> <vault>/.activity/YYYYMMDD.jsonl
  DesktopStore.swift   current Spaces (private CGS via dlsym) + names in <vault>/.activity/desktops.json
  DesktopMenu.swift    menu bar item: current desktop name, switch, Rename
  TrackerWidget.swift  always-on-top transparent widget: Doing cards + timer, desktop, app, title, URL; toast cover
  WidgetParts.swift    WidgetPart (per-element show/justification/size keys), WidgetAlign, WidgetPrefs
  TimelineWindow.swift Timeline window (Shift-Cmd-T, toolbar icon, menu bar): Day / Week calendar, per-second list, Reports
  ReportsView.swift    Reports tab: ReportsModel (range, group by projects/desktop/state, drill), tiles, stacked Swift Charts bars, org > project > card rows
  BoardStore.swift     single ObservableObject: data, selection, views, persistence
  BoardView.swift      header, filter chips, board, list, cards, rows; QueryField (filter + completion, also in Timeline)
  SidebarView / OrgRail / Inspector / CommandPalette / ViewEditor
  Menu.swift           custom Linear-style menus: MenuItem, MenuController, MenuHost, MenuTrigger, rightClickMenu
  SettingsView.swift   Settings window (Cmd-,); Density metrics; Tracking tab (desktop squares holding draggable project pills, mulling time)
  Style.swift          Palette, StatusGlyph, Pill, FlowLayout, Monogram, OrgIcon, renderTitle
Tests/KanbanCoreTests/ XCTest, millisecond-scale
```

## Behaviour

- Always commit. After each finished change: run `make test`, run `make run`, then commit without
  waiting to be asked. One commit per change; message is one plain line describing the change.
- Commit only `native/kanban-board`. Other paths in the repo hold the user's unrelated changes.
  Stage with `git add native/kanban-board` and commit with `-- native/kanban-board`.
  Never mention an LLM in a message and add no co-author trailer.
- Move the Kanban task to Done in the same step as the commit.
- Always relaunch. Every UI change ends with `make run` and a `pgrep -lx KanbanBoard` check, so
  the user never has to build.
- Act, do not ask, for choices with a conventional default. Ask only when missing information
  changes the path. Reuse existing code first, refactor second, add third.
- Do not claim a visual result you did not see. Say "not viewed" and name what to check.
- Never run destructive commands (`git reset --hard`, deleting user files, `defaults delete`)
  without asking. Never touch files outside `native/kanban-board` except the kb skill doc and tasks.
- Replies: h2 section headers, at most six short sentences, numbered lists capped at five items,
  end with one concrete next step. State what changed and what was not tested.
- Keep this file current: when a bug teaches a rule, add it under Gotchas or Invariants in the
  same commit as the fix.

## Workflow

- Build and relaunch: `make run`. `make watch` repeats it on file changes. `make test` runs unit tests.
- Put new logic in `KanbanCore` with a test first. The app target holds only views and I/O.
- The user tests the GUI by hand and reports back. Unit tests stay millisecond-scale.
- Track work as a task in the Kanban Doing column (`node kanban-cli/axi.mjs create ... --org Personal
  --project "Kanban App" --col Doing`). Create it before starting a new feature.
- "go turbo" lifts the ~50-line chunk limit. Without it, stop after about 50 lines and ask for a test.

## Data contract

- `ObsidianClient.boardScript` runs one `obsidian eval` that returns tab rows:
  `@column<TAB>Name<TAB>live|done`, then `col<TAB>file:line<TAB>body<TAB>age<TAB>orgs<TAB>projects`.
  Live columns come from `kb.active({includePaused:true})`; done columns from `kb.board`.
- `ObsidianClient.eval` never relies on the CLI awaiting a promise: on 2026-10-07 async evals (even a
  50 ms timer) returned empty output with exit 0 most of the time while sync evals always worked, which
  emptied the board. Each call is a sync eval that parks the result in `window.__kbr[id]`, then sync polls
  (40 ms) until `KBR:ok:`/`KBR:err:`. Errors from `kb` now surface instead of vanishing.
- The CLI prefixes output with `=> `. `Board.parse` must strip it and the space after it, or the
  first column is silently dropped (this happened; a test covers it).
- `Card.identifier` is `KEY-yyMMdd-HHmm[.NN]` from a daily-note file name (HHmm alone repeated across days);
  other notes get `KEY-XXXX[.NN]`, a 4-character base-36 FNV hash of the name. The list column is sized by a hidden widest id.
- The last two board-script fields are the task's 1-based ordinal among the note's checkbox list items
  (`metadataCache` `listItems`) and their count; every task gets `.NN` (zero-padded) when the count is above 1. `Card.identifier` uses it, never the line: every move inserts a
  `%% kb %%` line and shifted ids of tasks below (OW-1215.15 became .16).
- Field 15 (after `since`) is `%% kbactive N %%` seconds from `kb.activeTimes()`, parsed into `Card.activeSeconds`.
- After est and took (always two fields, empty without a guess) every row ends with `since`: the ISO time a
  live card entered its column (`kb.active({timestamps:true})`), parsed into `Card.since` for the widget timer.
- Done (`=x`) rows end with the ISO done time (`kb.board({timestamps:true})`), parsed into `Card.doneAt`.
  Logbook mode lists cards with `doneAt` from `store.visible`, so filters apply and the span is the 14-day done window.
- `ref` = `file:line` is the card id. Moves call `kb.moveTask(file, line, column)`.
- The board script ends with `@sweep<TAB>From<TAB>To` rows from `kb.sweeps()`. Each becomes a
  header button on From that calls `kb.sweep(from, to, refs)` with the column's visible cards only.
- Created time is parsed from the note file name `YYYYMMDD-HHmm`. There is no created field.
- Vault name for `obsidian://` links is `Vault` (`Style.swift`). Org logos:
  `~/Vault/40-49 Areas/43 Orgs/<Org>/Logo.<ext>`, folder name equals the org name.
- A change to `kb` output needs `kanban-cli/SKILL.md` updated in the plugin root.

## Invariants

- Column order (`kanban.columnOrder`) and user-hidden columns (`kanban.hiddenColumns`) are by name.
  `store.visible` is already ordered. Only user-hidden columns render in `HiddenColumns` (right panel),
  each row a drop target; empty columns shrink in place to a 44 pt strip (`ColumnView.collapsed`, animated width); a drag over one only highlights the strip, and it widens after the drop; list mode skips hidden columns. Column options live in `ColumnMenu`.
- Never pair `onTapGesture(count: 2)` with a single tap: SwiftUI holds the single tap for the
  double-click interval and selection feels laggy. Use `.simultaneousGesture(TapGesture(count: 2))`.
- Drag frames go through `dragFrame` (`DragFrame`): the newest view for a key owns it. Refresh animates `columns`, so a
  rule-moved card briefly has a fading old view whose late `onDisappear` once erased the new frame and made the card undraggable.
- Multi-select is `store.picked` (refs). The card's top-right org icon is the toggle (check when picked).
  Dragging a picked card carries the whole pick. Several cards move in one `kb.moveTasks` or
  `kb.rankTasks` call, never parallel `moveTask` calls, because each move inserts a history line
  and shifts later line refs in the same file.
- Manual order: `%% kbrank N %%` under a task (plugin `RANK_RE`). `Ranking.place` computes fractional
  ranks from the shown order (unranked cards above the drop point get ranked too); `kb.rankTasks`
  writes them and moves cards into the column first. Every card drop goes through `store.place`.
- Card `id` is `file|title` (deduped `#n`), set in `Board.parse`; `ref` (file:line) shifts whenever a
  line is inserted above, so it must not be the view identity. Selection and moves still use `ref`.
- Writes bump `store.writeGen`; `refresh` drops results from before the latest write or during a drag.
  Without this the 6 s poll can land mid-write and snap an optimistic move back.
- Card drag is in-app, in `DragController` (no system drag-and-drop: AppKit owns its drag image and
  hover timing, so the card could not settle onto its slot and the ghost lagged 2-3 frames).
  One `DragGesture` on the board content starts a session when it begins on a registered card
  frame. `FloatingCard` draws the card at the cursor and alone observes `DragPointer` (mouse rate);
  columns observe only `session` and `slot`. Views record frames with `.dragFrame` into the
  unobserved `FrameRegistry`; hit testing reads it in the same event. `DragLayout.items` builds each
  column's rows: carried cards removed, one ghost the grabbed card's size (at its home on pickup,
  so nothing moves). Across columns the ghost sits at the end; in the home column or with Cmd
  held it follows the cursor (`Ranking.slot`). Gaps between columns keep the last slot. Drop
  animates the floating card onto the ghost frame, then `finish` places the cards and ends the
  session in one transaction with animations disabled.
- Do not add `.animation(_:value:)` to card stacks: it fights the explicit `DragController.spring`
  transactions and makes pickup and drop jump.
- Desktop names: macOS has none, so `DesktopStore` keeps them in `<vault>/.activity/desktops.json`
  keyed by Space UUID (Desktop 1 reports an empty UUID; `space-<id64>` stands in). `Card.desktop` is a
  String: a number 1-9 or a name, resolved with `store.desktops.resolve`. `renameDesktop` rewrites cards
  that used the old reference. Mission Control keeps showing "Desktop N": renaming those labels needs Dock
  injection (SIP off). A name tag floated over them was tried and removed at the user's request (looked wrong);
  do not bring back approximations of system UI.
- Desktop per card: `Card.desktop`, stored in the note as `%% kbdesktop N %%` (plugin `DESKTOP_RE`, written by
  `kb.setDesktop`, read as the last board-script column). Frontmatter `kbdesktop: N` is the per-note default; the task line beats it. The app keeps no desktop state of its own. Clicking the
  "Desktop N" pill calls `store.switchDesktop`: press the user's macOS "Switch to Desktop N" shortcut (read from
  `AppleSymbolicHotKeys` by `Spaces.shortcut`). Double-click a card or list row opens it in Obsidian (`store.open`). Needs Accessibility permission and the shortcut
  enabled in Keyboard Shortcuts > Mission Control (any combination). While BetterTouchTool runs, it presses Right Cmd+N
  instead (`Spaces.rightCommand`: right Command key down, digit with `NX_DEVICERCMDKEYMASK`, key up), the user's BTT binding.
- Menus are custom, never SwiftUI `Menu` or `.contextMenu`. Items are `MenuItem` values; card, column and view items live in
  `BoardStore.cardItems` / `columnItems` / `statusItems` / `desktopItems` so the inspector and the right-click menu share them.
  "Copy ID" (`store.copyID`, Shift-Cmd-C on the selected card) copies `Card.identifier`; clicking the ID (`CopyIDButton`: card, list row, inspector) does the same. Both show a `Toast` via `store.show` (one at a time, 1.6 s). Open with `MenuTrigger` (button) or `.rightClickMenu` (AppKit catcher that takes only right clicks). `MenuHost` draws panels
  in the `MenuController.space` space (root, inside zoom); window clicks are divided by `kanban.zoom`. Row height is fixed so
  panel height is computed, not measured. Keys are a local monitor: arrows, return, esc.
- Zoom (`kanban.zoom`, 0.7 to 1.6) scales the whole window content in `KanbanApp`. View > Zoom In uses
  key `+`, which needs Shift, so a hidden Cmd-= button does the same zoom in. Cmd-0 resets to 1.

- Workspace scope is separate from the query: `store.orgScope` (a list) filters first,
  `store.query` second. Empty = all workspaces; `""` (`Filter.noOrg`) in the list = cards with no org.
  Use `store.activeOrgs`, which drops orgs that no longer exist. Rail click selects one,
  command/shift-click toggles; `OrgPicker` (type, select, multiple) edits the list in the view
  editor and the header popover.
- Single-valued query keys (`project`, `org`, `col`) replace on click; `tag` adds. Use
  `Query.toggling`, not string appends.
- Each workspace selection keeps its own filter: `orgQueries` (`kanban.orgQueries`, keyed by `scopeKey`, order-free)
  is updated on every filter change and on switching away; switching back restores it. `apply(view)` sets orgs (only when the view has some; a view
  without orgs keeps the current workspace, it once reset to all workspaces), then query.
- A saved view stores `(query, orgs)`; legacy single `org` is read as a one-item list. Applying a view sets both.
- Add a new filter key in two places: `Filter.test` and `Catalog.make`. The catalog drives autocomplete in
  the filter field (Tab or Return accepts) and in cmd-K; `view:Name` applies the view.
- Sidebar Projects and Labels hide zero-count
  rows behind a "Show N empty" row. Cards show no ID (the inspector does); age and org sit on the
  title line, and the labels line renders only when the card has labels.
  When grouped, a single-org group shows its org on the `GroupHeader` (`CardGroup.orgs`) and its
  cards hide theirs; mixed-org groups keep the avatar per card. The board always groups by project; there is no toggle.
- `Monogram` shows `Card.initials` (first letter of up to three words) on a two-hue OKLCH gradient (`ProjectColor`)
  hashed from the name; every project tile is as wide as three letters and as tall as the
  adjacent text line (16 pt group header, 18 pt sidebar), shorter initials centred; no project = dashed outline.
  Sidebar rows share one leading slot (`SidebarRow.slot`, 28 pt) so names align; `Card.identifier` reuses `Card.initials` for multi-word names.
- Rail order is `store.orgOrder` (persisted) applied by `Ordering.arranged`; drag a tile onto another to move it.
  Cmd-1 selects all, Cmd-2 to Cmd-9 select the first eight orgs in rail order.
- Sidebar and chip counts come from `store.visible`, so they match the board.
- Optimistic moves update `columns` inside `withAnimation`, then call `kb`, then refresh.
- Refresh runs every 6 s. Do not add a second polling loop.

## Think Apple

Before building or wording any UI, ask what Apple would do and do that.

- Use the system's own control, behaviour, or SF Symbol before inventing one. Match macOS conventions
  for menus, popovers, sheets, focus rings, key equivalents, and context menus.
- The interface explains itself through structure and state, not through instructions on screen.
  Remove any label that explains how to use a control.
- Fewer words, sentence case, no jargon, no punctuation for effect. Name things by what the user
  sees, not by how the code works.
- Defaults are right for most people. Add a setting only when the default cannot be right.
- Every state is designed: empty, loading, error, hover, pressed, selected, disabled, dragging.
- Motion is short, springy, and explains a change (a card moving to a column). It never decorates.
- Respect accessibility: sufficient contrast, full keyboard use, VoiceOver labels via `.help` and
  `.accessibilityLabel` on icon-only buttons.
- When Linear's look and Apple's behaviour disagree, keep Linear's look and Apple's behaviour.

## Design rules (Linear clone, by request)

- Flat near-black. Window `#08090a`, main sheet `#0f1011`, 1 pt hairline borders, no shadows on content.
  Tokens live in `Palette`; do not hard-code colours in views.
- One accent (indigo). Colour marks state only: status glyphs, stale age (amber), selection, drop target.
- Glass (`glassEffect`) is only for floating controls (command palette, toast). Never on cards or columns,
  and never glass on glass.
- Type: SF Pro, 13 to 13.5 pt titles with slight negative tracking, 11 to 12 pt muted metadata,
  `monospacedDigit` for numbers, monospaced for ids.
- Align to edges: title left, age right, shared left edge across a row. Same-height items in a
  `FlowLayout` row (the chip-row misalignment came from mixed heights).
- Radii: 6 controls, 9 cards, 12 panels, capsule pills. Use the keyboard: arrows/jk select,
  return opens, space toggles peek, `/` filters, cmd-K commands.

## Copy

- UI text follows Apple style: sentence case, short, no em dashes, no instructions in placeholders
  ("Filter", "Name", "All workspaces", not "type to filter" or "e.g. ..."). Sentences end without a period
  in labels. Use an ellipsis only for commands that open a dialog ("New view...").
- Shortcut hints belong in tooltips (`.help`) and the command palette, not on screen.

- Activity capture (blueprint `.yeshwanth/blueprints/activity-tracking.md`): `ActivityMonitor` only
  records spans; it never moves cards. `BoardStore.switchTasks` runs `SwitchEngine` once per refresh:
  a card with a desktop, or whose project/org a rule in `<vault>/.activity/rules.json` names, parks
  120 s after the user goes away (idle, locked) and resumes 10 s after return to its context, only if the
  engine parked it. Another desktop or context keeps the card in Doing; `Focus` only makes it inactive. Moves
  are stamped at the moment the context changed (`kb.moveTasks(refs, col, {at})`). Engine state
  persists in `kanban.switches`. Sleep park: `BoardStore` notes `willSleep` (lid close; not screen lock or display
  sleep) and on `didWake` calls `kb.parkAll(at)` with that moment, so any sleep length parks. The plugin's 30 min
  heartbeat-gap park (`src/sleep.js`) stays as the fallback when the app is not running. Break key: `BreakHotKey` (Carbon
  `RegisterEventHotKey`, no Accessibility permission) runs `takeBreak` -> `kb.parkAll(now)` and remembers the parked ids (`kanban.breakParked`); pressed again while any of
  them is still in Parked, it moves those back to Doing instead; default F6 (fn+F6),
  stored as `kanban.breakKey`/`breakMods`/`breakLabel`, recorded in Settings > Tracking (`BreakShortcutRow`). Desktop number uses private CGS calls looked up with `dlsym`; nil on failure.

- Tracker widget toast: `BoardStore.refresh` diffs live cards against `lastLive` (the previous refresh),
  never against `columns`, because optimistic moves change `columns` first. One diff covers drags,
  switch rules, and the plugin's sleep auto-park. Widget settings live under `widget.*` defaults.

- Incognito windows are never logged: `Probe` asks Chrome, Arc, Brave and Edge for `mode of front window` and gets
  `kb:incognito` instead of a URL; `tick` then closes the open span and sets a context with the app but no title or URL.
  Safari has no scripting property for private windows, so its private windows are still logged.
  The one-line `tell ... to if ... then ... else` form is an AppleScript syntax error; the script is a `tell` block.
- Timeline window reads the app's own `<vault>/.activity/YYYYMMDD.jsonl` (plus `ActivityMonitor.openSpan`
  for the live span) and Doing stints from `kb.chronicle(date)`. Doing totals use `ActivityLog.unionSeconds`:
  parallel Doing cards overlap, and a plain sum read 536h for one day. Today reloads every 5 s.
  The calendar's Doing column keeps genuinely parallel cards visible: `ActivityLog.lanes` gives each overlapping
  stint its own equal-width column with a 2 pt gap, so cards never overlap in x (a one-card-at-a-time
  "focus" line was tried and rejected: it hid real parallel work). Hover details use `hoverTip`/`HoverCard`
  (instant, follows the pointer), not `.help`, whose ~1 s delay felt unresponsive. The Reports chart uses the same
  `HoverCard` from a `chartOverlay`: the bar under the pointer, its total, then each series largest first.
  `CalendarDay` draws N days (`days`/`layouts`): Day = one day split Activity | Doing; Week = the 7 days of
  `Calendar.dateInterval(of: .weekOfYear)` (locale first weekday), each split 55/45, Doing from one
  `kb.chronicle(from, to)` parsed by `ActivityLog.stintsByDay`. Arrows step a day or a week.
  Double-click a Doing block opens its card: `kb.chronicle(..., {refs:true})` appends `file:line`
  (`DoingStint.ref`), opened with `ObsidianClient.open(ref:)`. Activity blocks have no note to open.
  The 5th field is the note's first project (`DoingStint.project`); Doing blocks take its `ProjectColor` light tint, indigo without one.
  The 6th field is the stint's entry stamp (`DoingStint.enter`), its key for `kb.editStint`. Hovering a Doing block shows grab bars
  on its start edge and, once closed, its end edge; dragging one (`DoingStint.dragged`: whole minutes, a minute from the other
  edge, never after now) writes `kb.editStint(ref, enter, {start|end})` on release, and the preview stays until the stints reload.
  Right-click a Doing block for Open in Obsidian / Delete Stint (running stints cannot be deleted). The Timeline window has its
  own `MenuController` and `MenuHost`; `onRightClick` hands the click to the view, which places the menu at its hover pointer
  (`show(atWindow:)` divides by the board's `kanban.zoom`, which the Timeline does not use).
  `TimelineModel.load` runs `ActivityLog.impute` once with `maxGap: ActivityMonitor.idleAfter` (300 s): a gap
  shorter than the idle threshold cannot be idle time (capture restarts, dropped sub-5 s visits), so the previous
  span carries forward; longer gaps stay empty and show as Away in the list (same threshold). 60 s left visible
  holes from app relaunches. The log
  file is never rewritten.
  The calendar is one viewport-sized `Canvas` culled to visible hours (`CalendarLayout` precomputed per data
  load); per-block SwiftUI views and a defaults write per scroll tick made zoom chug.
  Zoom (`timeline.hour`, `CalendarDay.zoomRange` 24 to 3600 pt per hour) goes through `TimelineModel.zoom`:
  Cmd + scroll sends the pointer as pivot, the +/- buttons the view centre; `CalendarDay.apply` keeps the time
  under the pivot fixed via `ScrollPosition` and the tracked content offset. Sub-hour gridlines appear at
  200 (15 min), 800 (5 min), and 2400 (1 min) pt per hour. Cmd + scroll zooms
  (`timeline.hour`, 24 to 480 pt per hour) through a local scrollWheel monitor on the Timeline window.

## Gotchas

- A Swift property's `didSet` does not run for assignments made inside `init`, so a value saved through
  `didSet` stays unsaved when it is set there. The work/break share once read 100% for that reason: its day base
  fell back to `workStart`, which moves at every break end. The base is now derived from today's first
  activity span, not saved.

- `make run` (pkill) and crashes skip `willTerminate`. State that must reach a log on quit is also saved in
  UserDefaults and written at the next launch: the running active stretch (`kanban.activeStretch`, ended at
  the saved `ActiveClock.last`) and the running break (`kanban.breakStart`).

- Values read in sorts or filters are computed once per card. `Card.created` parsed its file name with a
  `DateFormatter` on every read; the newest-first sort and the `created:` filter made that thousands of
  parses per render, and scrolling stalled (2026-10-11, measured with `sample` under injected scroll events).
- `BoardStore.refresh` (every 6 s) assigns `columns` only when the board changed; assigning an equal board
  still redrew every card.

- `NSRunningApplication.activate` is ignored while this app is not active (macOS cooperative activation), and a
  widget click never makes it active. `ObsidianClient.bringForward` uses `NSWorkspace.openApplication` with
  `activates`, which worked from a background process on 2026-10-11; an `obsidian://` URL did not.

- Board columns hold hundreds of cards (2026-10-11: Backlog 185, Done 180 over 14 days). Card stacks stay
  `LazyVStack`: an eager `VStack` built and measured every card on each store change, so drag and scroll stalled.
  Lazy columns measure only cards near the viewport; `Ranking.slot` skips unmeasured cards.
- SwiftUI drops a cancelled `DragGesture` without calling `onEnded`. `DragController.changed` treats a new
  `startLocation` as a new gesture and clears `ignoring` and any stale session; otherwise the next drag did nothing.

- Ghost frames are keyed by column (`FrameRegistry.ghosts`, through `dragFrame`). A ghost leaving a column fades out
  and keeps reporting its frame; with one shared slot the drop flew back to the home column first.
- Board shortcuts (`BoardView.board`) fire for any focused descendant, including the Inspector note editor. They return
  `.ignored` while an `NSTextView` is first responder; otherwise Return opened Obsidian mid-typing.
- `make run` can fail with launch error -600 if `open` races `pkill`; the Makefile sleeps 1 s.
- Scroll views clip overlays (the rail badge); give the content side padding.
- A bare `Color.clear.frame(width:)` in an HStack is flexible in height and steals space from a sibling
  ScrollView; give spacers an explicit height. `scrollTo` targets must be placed by layout, not `.offset`.
- Hidden title bar: the traffic lights sit over the org rail, which starts 52 pt down. Do not
  move content into the top-left 80x40 area.
- Keyboard shortcut buttons must be hidden with `opacity(0)` and a zero frame, all of them.
- Drag auto-scroll polls `NSEvent.pressedMouseButtons` at 60 fps; it is not a drop target, so it
  never blocks clicks. The zone is deliberately not drawn.
- Org rail tiles still use `.draggable("org:" + name)`; cards do not use system drag.
- Never give an `NSHostingView`/`NSHostingController` in a borderless panel `.preferredContentSize` (or the
  default sizing options): it resized the panel inside its own `windowDidLayout` and crashed the app
  with infinite recursion when Mission Control opened. Panels get fixed frames and `sizingOptions = []`.
- Dragging a borderless non-activating panel: `isMovableByWindowBackground` plus `mouseDownCanMoveWindow`
  did nothing on the SwiftUI hosting view. `DragHostingView` takes the hit and calls `window.performDrag(with:)`.
  The tracker widget is click-through (`ignoresMouseEvents`) until Fn (`.function`) is held with the pointer over it;
  global plus local `NSEvent` monitors (flagsChanged, mouseMoved, leftMouseUp) set `WidgetGrip.armed`.
  Fn-click on a task (`store.activate`) switches to its desktop (`store.desktop(card)`) when that is another one,
  then pins it. The sampler sees the new Space up to 5 s later, so the `FocusPin` also holds on the desktop it
  leaves until `arrive`; a pin bound only to the target was dropped by the next tick on the old desktop.
  Control held with the pointer over it fades the panel `alphaValue` to 0 over 0.25 s (peek at the text underneath).
  The panel is a square of the Size setting (`widget.width`), taller when the content needs it: parallel
  Doing cards each get a row with their own timer (none hidden), and `WidgetView` reports its natural
  height via `onHeight`; `TrackerWidget` resizes the panel on the next run loop (never during layout) and
  keeps the bottom edge fixed (content bottom-aligned; the widget grows upward). Armed area, highlight, toast, and window frame stay one rectangle.
  Each element (`WidgetPart`) has its own visibility, justification (`widget.<part>.align`), and font size
  (`widget.<part>.size`); font family and square size are global. Colour: task titles and timers take their card's
  project colour (light end of its `Monogram` gradient); everything else, and cards without a project, use the Text color setting.
  Position: `widget.origin` (bottom-left, saved on every move, used only when still on a screen); no frame autosave. Settings > Widget renders the real
  `WidgetView` (live data, own `WidgetGrip`) on a sample wallpaper; the Settings scene gets the store's
  environment objects in `KanbanApp`.
- The Dock's Mission Control AX group (`AXIdentifier == "mc"`) has no children on this macOS; the Keyboard
  Maestro path to "Desktop N" buttons is dead, and open Mission Control is one full-screen Dock window.

- Project desktops (Settings > Tracking: one square per desktop plus No desktop, drag project pills between them;
  inside a square pills group under collapsible orgs (first org of the first card naming the project, `tracking.collapsed`);
  each desktop square's name renames in place (double-click or pencil; empty resets) via `store.renameDesktop`;
  no hover tooltip, pills show the full name; the drag is the board's pattern, not system drag-and-drop (it dropped the image at the
  cursor and popped the pill in): `FloatingPill` follows `DragPointer`, the hovered square shows a ghost (its org group forced open),
  release animates onto `frames.ghost`, then `setDesktop` and the swap run unanimated; or right-click a sidebar project > Desktop; orgs are not offered, by request)
  go through `store.projectDesktop` / `store.setDesktop(_:project:)` and are `DesktopPin` rules `{project, desktop}` in
  `<vault>/.activity/rules.json`, written by `ActivityMonitor.saveRules`; other rules in the file are kept.
  `renameDesktop` rewrites pins on the old name as it does cards. A pin gives every card of that scope desktop affinity, so `Focus` and `SwitchEngine` treat them as owned by that desktop.
  Precedence lives in `ActivityRule.applying`: card `kbdesktop` beats project desktop beats org desktop.
  Cards show the pin: the card pill, list row and inspector read `store.desktop(card)` (`DesktopPin.desktop`), which falls
  back to the project pin, then the org pin, when the card has no `kbdesktop`. Nothing is written to notes; the card menu's None clears only the card's own value.
- Reports tab (`timeline.mode` = `reports`): `kb.reportCards(from, to, {mull})` gives cards with stints;
  `Report.attribute` splits each active minute (day logs, `impute` at the idle threshold): owners of the
  context (`SwitchEngine.owns`) split it, else cards with no affinity, else a matching rule's scope gets
  "No card" time, else Unattributed. A card's share splits equally across its org x project pairs.
  Ad hoc uses `reports.mull` minutes (Settings > Tracking). Attribution runs off the main actor.
  Spans carry the Space `uuid`; `Report.attribute(names:)` names an unnamed span from the current label of that UUID.
  Spans older than the `uuid` field fall back to the current name of their number (`labels:`), which is wrong once
  desktops are reordered: Trading moved from 5 to 4 and its card got 5 s of 80 min (2026-10-07). Every card with Doing
  time in the range stays in the breakdown, with "N in Doing" beside its attributed time when they differ.
- One active task (`Focus.pick`): among Doing cards, owners of the current context win, else cards with no
  affinity, ties to the latest into Doing; away = none. The widget shows that card as the hero with its active
  time running, its time in Doing over every stint (`Card.seconds(in:)`) as a dimmed caption under it at 0.4 of
  the timer size (`WidgetView.clockStack`), and the other Doing cards as dimmed paused rows at 0.85 of the title
  size with the same stacked pair (caption 0.75 of the row number, running). One number per line: an inline
  `23:14 (45:11)` pair on every row read as clutter (2026-10-09). Reports use the same pick per moment.
  `ActiveClock` (persisted in `kanban.activeClock`) credits ticks (refresh and every context change, capped at
  15 s), takes back time after the idle start when going away, and `BoardStore.flushActive` writes whole seconds
  with `kb.addActive` on a switch and every 300 s. The board adds flushed seconds locally so the timer never dips.
