# Backlinks & Daily Blocks

Lightweight Obsidian plugin that renders two custom code blocks without Dataview:

- ```backlinks``` shows notes that link to the target note.
- ```daily``` shows all YYYYMMDD-HHmm notes for a given date (current note by default).

## Quick install (manual)
- Drop this folder into `.obsidian/plugins/backlinks-daily-blocks`.
- Ensure `manifest.json` and `main.js` sit at the root of that folder.
- Restart/Reload Obsidian and enable **Backlinks & Daily Blocks** in Settings → Community Plugins.

## Package metadata
- `package.json` declares `main: "main.js"`; version/name match the manifest.
- Dev dependencies on `obsidian@^1.5.0` and `esbuild`; Node >= 16.

## Development
- Source lives in `src/` (`core/` shared modules, `views/` Bases views, `blocks.js` code blocks).
- `npm run build` bundles `src/main.js` into `main.js` (the file Obsidian loads).
- `npm run dev` rebuilds on change.

## Installation
Copy this folder into `.obsidian/plugins/backlinks-daily-blocks`, then enable it in Obsidian.

## Settings
Settings → Backlinks & Daily Blocks: tabbed screen (Kanban / Backlinks / Daily / Views) sets block defaults; per-block config always wins.

## Usage
### Kanban
````
```kanban
paths: Work/
columns: Todo, Doing, Done=x, Cancelled=-
```
````
- Scans vault (or `paths` prefixes) for task lines at any depth, renders drag-drop board.
- Nested tasks are cards too: child card shows a faint parent breadcrumb; each card moves independently.
- Dropping on a terminal column is refused while the task has open (`[ ]`) sub-tasks.
- Parent cards show a rollup pill `closed/total` over all descendants; turns green when complete. Display only — parent state never auto-changes.
- History comment lines attach to their task by indent (one level deeper than the task line).
- Open columns: membership via `#kb/<column>` tag; untagged tasks land in first column.
- `Name=char` columns are terminal: drop sets `[char]`, strips `#kb` tag, stamps `YYYYMMDDHHmm`.
- Drag back out reopens: `[ ]`, stamp stripped, tag added.
- Click card footer (note name) to jump to the source line.
- `maxage: 7` (default) hides terminal cards stamped older than N days, or unstamped; `maxage: 0` shows all.
- Every move writes a hidden history line under the task (`    %% kb YYYYMMDDHHmm From > To %%`); invisible in reading view, travels with the task.
- `Name~` columns are idle (Backlog, Parked by default): time there counts in total but not work time.
- Task birth = note's `YYYYMMDD-HHmm` filename stamp; the journey starts there (gray backlog lead-in on the bar).
- Card shows two journey bars (segments ∝ time, column colors): full timeline incl. idle, and active-only beneath. Full text trail on hover.
- Open cards label current column + duration; terminal cards freeze the clock and label `16m work · 3d total`.
- Aging WIP: idle-column cards (except the first column) grow a left stripe — amber past 2 days, red past 7.
- Empty block = defaults: all paths, `Backlog~, Todo, Doing, Parked~, Done=x, Cancelled=-`, `maxage: 7`.
- `sweep:` routes, one per indented line below the key (commas also work); each puts a ⤳ button on its From column header that bulk-moves every card to the To column, history lines included. Default `Doing > Parked`. Terminal targets still respect the open-children guard.
  ```
  sweep:
    Doing > Parked
    Parked > Todo
  ```
- Column colors: built-in palette by name (backlog/todo/doing/parked/review/done/cancelled), cycle for unknown names; override with `colors:` + one `Name=color` per indented line (block or settings).

### Backlinks
````
```backlinks
# empty body defaults to current note
```
````

With options (YAML or JSON):
````
```backlinks
heading: Incoming links
sort: mtime        # ctime|mtime
limit: 10
truncate: 300
# target: 20260110-2012   # optional target note path/link
```
````

### Daily
````
```daily
# empty body uses current note's date or today
```
````

Options:
````
```daily
date: 20260115     # YYYYMMDD
order: asc         # asc|desc
size: 100%         # width/height for excalidraw embeds
limit: 5
truncate: 600      # character limit per note
includeCurrent: false
heading: Daily notes
```
````

Notes:
- YAML bodies are parsed; a plain string sets the date (for `daily`) or target (for `backlinks`).
- Content is trimmed of frontmatter and `%% more %%` markers and truncated per `truncate`.
- Excalidraw files ending with `.excalidraw.md` are embedded with the configured size.

## Bases view
- **Content Feed** view available in any Base (change view type from the toolbar).
- Renders full content of all filtered files (strips frontmatter, truncates at `%% more %%` unless `truncateLength` is 0).
- View settings: strip frontmatter, truncate length, show property beside title.
- Tasks inside rendered markdown are clickable; checkboxes sync back to the source file; internal links open via Obsidian navigation.
- Perfect for reading multiple notes as a vertical feed (daily rollups, project filters, etc.).

## Tasks aggregation view (Bases)
- View: **Tasks** (change view type in the Base toolbar).
- Groups tasks into Incomplete/Complete; defaults to include completed.
- Clicking a task’s checkbox writes back to the source line; link jumps to the exact line in the note.
- Internal links inside task text are rendered and clickable.

## Properties aggregation view (Bases)
- View: **Properties Aggregation**.
- Aggregates frontmatter properties across the filtered files, with icons per type.
- Click counts to expand source notes; link values render as internal links.
