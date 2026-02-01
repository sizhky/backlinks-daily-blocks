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
- Dev dependency on `obsidian@^1.5.0`; Node >= 16.

## Installation
Copy this folder into `.obsidian/plugins/backlinks-daily-blocks`, then enable it in Obsidian.

## Usage
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

## Side pane view
- Command: **Open Backlinks & Daily view** (also available via Command Palette).
- Opens a right-hand pane that follows the active note, showing backlinks and daily embeds with `includeCurrent: true`.


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
