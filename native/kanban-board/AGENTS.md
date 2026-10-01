# Kanban Board (native macOS app)

SwiftUI app (macOS 26, Swift 6.2 tools, Swift 5 language mode) that shows the Obsidian kanban
board from the `backlinks-daily-blocks` plugin. It is a client: it never reads or writes vault
files for tasks. All task data and moves go through `obsidian eval` and the plugin's global `kb`.
It does not depend on `native/doing-tasks`.

## Map

```
Sources/KanbanCore/    pure logic, no UI, fully unit-tested
  Card.swift           Card, Column, Board.parse (kb output -> model), identifier, created
  Query.swift          query text -> QueryTerm; format; toggling (single-valued keys)
  Catalog.swift        keys and values the filter field and palette complete (`Catalog.make`, `suggest`)
  Filter.swift         term matching, org scope, SavedFilter (a "view")
  Grouping.swift       group cards by project
  Title.swift          [[wikilinks]] / [text](url) -> segments
Sources/KanbanBoard/   SwiftUI app
  Obsidian.swift       the only file that talks to Obsidian (ObsidianClient)
  BoardStore.swift     single ObservableObject: data, selection, views, persistence
  BoardView.swift      header, filter chips, board, list, cards, rows
  SidebarView / OrgRail / Inspector / CommandPalette / ViewEditor
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
  --project "Obsidian Workflow" --col Doing`). Create it before starting a new feature.
- "go turbo" lifts the ~50-line chunk limit. Without it, stop after about 50 lines and ask for a test.

## Data contract

- `ObsidianClient.boardScript` runs one `obsidian eval` that returns tab rows:
  `@column<TAB>Name<TAB>live|done`, then `col<TAB>file:line<TAB>body<TAB>age<TAB>orgs<TAB>projects`.
  Live columns come from `kb.active({includePaused:true})`; done columns from `kb.board`.
- The CLI prefixes output with `=> `. `Board.parse` must strip it and the space after it, or the
  first column is silently dropped (this happened; a test covers it).
- `ref` = `file:line` is the card id. Moves call `kb.moveTask(file, line, column)`.
- Created time is parsed from the note file name `YYYYMMDD-HHmm`. There is no created field.
- Vault name for `obsidian://` links is `Vault` (`Style.swift`). Org logos:
  `~/Vault/40-49 Areas/43 Orgs/<Org>/Logo.<ext>`, folder name equals the org name.
- A change to `kb` output needs `kanban-cli/SKILL.md` updated in the plugin root.

## Invariants

- Workspace scope is separate from the query: `store.orgScope` (a list) filters first,
  `store.query` second. Empty = all workspaces; `""` (`Filter.noOrg`) in the list = cards with no org.
  Use `store.activeOrgs`, which drops orgs that no longer exist. Rail click selects one,
  command/shift-click toggles; `OrgPicker` (type, select, multiple) edits the list in the view
  editor and the header popover.
- Single-valued query keys (`project`, `org`, `col`) replace on click; `tag` adds. Use
  `Query.toggling`, not string appends.
- A saved view stores `(query, orgs)`; legacy single `org` is read as a one-item list. Applying a view sets both.
- Add a new filter key in two places: `Filter.test` and `Catalog.make`. The catalog drives autocomplete in
  the filter field (Tab or Return accepts) and in cmd-K; `view:Name` applies the view.
- Board columns with no visible cards render as `CollapsedColumn` strips right after the last
  filled column, inside the horizontal scroller; they stay drop targets. Sidebar Projects and Labels hide zero-count
  rows behind a "Show N empty" row. Cards show no ID (the inspector does); age and org sit on the
  title line, and the project/labels line renders only when it has content.
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
- Glass (`glassEffect`) is only for floating controls (command palette). Never on cards or columns,
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

## Gotchas

- `make run` can fail with launch error -600 if `open` races `pkill`; the Makefile sleeps 1 s.
- Scroll views clip overlays (the rail badge); give the content side padding.
- Hidden title bar: the traffic lights sit over the org rail, which starts 52 pt down. Do not
  move content into the top-left 80x40 area.
- Keyboard shortcut buttons must be hidden with `opacity(0)` and a zero frame, all of them.
- Drag auto-scroll polls `NSEvent.pressedMouseButtons` at 60 fps; it is not a drop target, so it
  never blocks clicks. The zone is deliberately not drawn.
- `.draggable(String)` carries the card `ref`; columns accept `String` drops.
