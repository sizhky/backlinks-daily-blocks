# Backlinks & Daily Blocks

Lightweight Obsidian plugin that renders two custom code blocks without Dataview:

- ```backlinks``` shows notes that link to the target note.
- ```daily``` shows all YYYYMMDD-HHmm notes for a given date (current note by default).

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
- Renders full content of all filtered files (strips frontmatter, truncates at `%% more %%`).
- Configure via view settings: toggle frontmatter stripping and set truncate length.
- Perfect for reading multiple notes as a vertical feed (like aggregated daily notes or filtered project notes).
