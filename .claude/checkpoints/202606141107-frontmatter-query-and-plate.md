# Checkpoint — frontmatter query + plate command

Date: 2026-06-14 11:07

## Goal
"Load my backlog for obsidian workflow" → extend kanban-cli with generic frontmatter
(Obsidian properties) discovery/query, then a packaged backlog command. Nothing hardcoded.

## Shipped (all in `src/api.js`, bundled to `main.js` via `npm run build`)
- `kb.props(opts?)` — discover frontmatter schema (key, note-count, sample values).
  - String shorthand: `kb.props("1w")` == `{since:"1w"}`.
  - Defaults to **task-bearing files only** (`tasks:true`); `{tasks:false}` = all notes.
- `kb.notes({where:{KEY:VAL}, ...})` — query notes by frontmatter. Keys caller-supplied.
  - Wikilink-normalized (`[[Page|Alias]]`→`Page`), array-any-match, case-insensitive,
    `contains` for substring.
- `kb.plate(project?, opts?)` — live tasks, optionally scoped to a project's notes.
  - Opts-first call supported: `kb.plate({col:"Backlog"})` = all backlog.
  - `kb.plate("Obsidian Workflow",{col:"Backlog"})` = that project's backlog.
- `kb.help()` — method list.

## Key decisions / fixes
- **Recency keyed off real signals, not mtime.** `since` = filename date (creation) OR
  `%% kb %%` task-move stamp within span. mtime ignored (sync/reindex bumps years-old
  notes — that was surfacing 2022/23 daily notes with unrendered `<% tp... %>` junk).
- **Paused-column bug fixed.** `active()` excluded paused cols (Backlog~) BEFORE the col
  filter, so `active({col:"Backlog"})` was always empty — I wrongly called Backlog "empty".
  Now an explicit `col` or `includePaused:true` keeps paused cols.
- `unwrap()` coerces Date→ISO and objects→JSON (no more `[object Object]`).

## Helpers added in api.js
`spanMs`, `hasTask` (via metadataCache listItems), `fileNameMs`, `activeWithin` (async,
reads content for kb stamps), `fmFiles` (now async), `fmVals`, `matchVal`, `unwrap`.

## Verified
- `kb.props("1w")` → projects/categories/org/tags, no templater junk.
- `kb.plate({col:"Backlog"})` → 3 items; `kb.plate("Obsidian Workflow",{col:"Backlog"})`
  → 1 item ("Talk about recurring tasks...") — matches the board screenshot.

## Synced
`kanban-cli/SKILL.md` documents props/notes/plate incl. opts-first and recency semantics.

## Open / next
- Original musing still unanswered: "recurring tasks — infinite pool of backlog?" (design Q).
- Vault has notes with unrendered `<% tp... %>` frontmatter (junk) — cleanup not done.
- Possible: `kb.props` content-read cost when `since` set scans every task file's lines.
