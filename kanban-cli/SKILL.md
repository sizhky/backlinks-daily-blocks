---
name: kanban-cli
description: Query and mutate the backlinks-daily-blocks kanban board from the shell via `obsidian eval`. Use when an LLM needs to read the user's task plate, see what was done on a date, get a day's move timeline, or move a task between columns without opening Obsidian.
---

# Kanban CLI

Plugin `backlinks-daily-blocks` exposes a JS api over the `obsidian eval` CLI.
On plugin load it sets `globalThis.kb = this.api`, so calls are short.

## Invocation

```
obsidian eval code='kb.METHOD(args)'
```

- CLI auto-awaits a returned promise — no `async` wrapper, no `JSON.stringify` needed.
- CLI prints the resolved value prefixed with `=> ` (its REPL marker, not from the code).
- After a rebuild (`npm run build`), the running plugin is stale. Reload once:
  ```
  obsidian eval code='(async()=>{await app.plugins.disablePlugin("backlinks-daily-blocks");await app.plugins.enablePlugin("backlinks-daily-blocks")})()'
  ```
  This also re-registers `globalThis.kb`.

## Methods

### `kb.active(opts?)` — live tasks ("on my plate")
Tasks in non-terminal, non-paused columns.
Returns a leading `\n` then tab-separated lines (token-lean, not JSON):
```
col<TAB>file:line<TAB>body<TAB>age
```
`age` is relative (`30m`, `7h`, `1d`). `opts`:
- `paths` — folder filter (string)
- `col` — only this column (case-insensitive)
- `tag` — substring match on tags or body
- `staleDays` — only tasks untouched ≥ N days
- `limit` — cap row count

Example: `kb.active({col:"Todo",limit:3})`

All read methods return a leading `\n` then tab-separated lines (token-lean, not JSON).

### `kb.getDone(date, opts?)` — what moved to a terminal column on a date
`date` = anything; non-digits stripped, first 8 digits used as `YYYYMMDD`.
Lines: `col<TAB>file:line<TAB>body<TAB>HH:MM`
`opts.col` — limit to one terminal column. `opts.paths` — folder filter.

### `kb.getReport(...)` — full move timeline, single day or range
Arg forms:
- `getReport(20260613)` — one day
- `getReport(20260613, {col:"Doing"})` — one day + opts
- `getReport(20260601, 20260607)` — explicit range (inclusive)
- `getReport(20260601, 20260607, {col:"Doing"})` — range + opts
- `getReport({days:7})` — last N days ending today (opts go in same object)

Multi-day output groups each day under a `== YYYYMMDD ==` header (`(none)` if empty).
Single day = bare lines, no header.

Per-day lines: `file:line<TAB>body<TAB>HH:MM from>to  HH:MM from>to ...`
(`from` of `·` = task's first appearance, no prior column.)
`opts.col` — only tasks that entered that column that day; the 3rd field then becomes
per-stint segments + total: `(HH:MM->HH:MM :: dur), (...) = total`. A `~` on a
segment's end time means it was still in the column at end of day (segment closed at 23:59).
`opts.paths` — folder filter.

**`fm` opt (active / getDone / getReport):** pass `fm:"projects,org"` to append those
frontmatter keys to each row as a trailing `\tkey=a|b; key2=c` field (missing value = `·`).
Saves grepping note frontmatter by hand. E.g. `kb.getDone(20260614,{fm:"projects,org"})`.

### `kb.chronicle(...)` — day chronicle of what sat in Doing
Arg forms mirror `getReport`: `chronicle(date)` | `chronicle(date, opts)` |
`chronicle(from,to)` | `chronicle({days:N, ...opts})`.
Default column is `Doing`; override with `opts.col`.
Single-day lines: `HHMM:HHMM[~]<TAB>dur<TAB>body`
Example:
```
0000:0820	8h20m	Sleep
1400:1435	35m	eat
1445:1600	1h15m	sleep
```
`~` means the stint is still open now.

### `kb.summary(...)` — done counts grouped by a frontmatter key
Rolls up terminal-column moves ("done") over a date range, grouped by `by` (default
`projects`). The one command behind "what did I ship, by project". Arg forms mirror
`getReport`: `summary(date)` | `summary(from,to)` | `summary({days:N, ...opts})`.
`opts`: `by` (fm key), `col` (terminal-col filter), `paths`, `sample` (max sample bodies
per group, default 3). Output: a `# done by <key> — <span> — N cards` header then
`groupVal<TAB>count<TAB>sample, bodies`, sorted by count desc. Cards with no value for
`by` pool under `(none)`; multi-valued cards count once per value.
Example: `kb.summary({days:3, by:"projects"})`.

### `kb.props(opts?)` — discover frontmatter schema (no hardcoded keys)
Scans every note's frontmatter (Obsidian properties) and reports what exists.
Use this FIRST to learn a vault's vocabulary before querying.
Lines: `key<TAB>noteCount<TAB>sample, distinct, values`
Bare-string shorthand: `kb.props("1w")` == `kb.props({since:"1w"})`.
`opts`: `paths` (comma-sep prefix filter), `sample` (max distinct values per key, default 8),
`since` (recency filter: `1d`,`3d`,`1w`,`2m`,`1y`; units `h/d/w/m/y`. "Recent" = filename
date (creation) OR a `%% kb %%` task-move stamp within the span — file mtime is ignored, since
sync/reindex bumps it on years-old notes),
`tasks` (default **true** — only files containing a checkbox task; pass `tasks:false` to scan all notes).

### `kb.notes(opts)` — query notes by frontmatter properties
Keys are caller-supplied; nothing is baked in. A note matches when EVERY `where`
key matches. Array-valued props match if ANY element matches. Wikilinks are
normalized (`[[Page|Alias]]` → `Page`), comparison case-insensitive.
Lines: `file<TAB>key=val|val; key=val`
`opts`:
- `where` — `{ KEY: VAL, ... }` match map (required)
- `paths` — comma-sep folder prefixes
- `limit` — cap row count
- `contains` — substring match instead of exact
- `since` — recency filter (same span syntax as `props`)
- `tasks` — `true` to restrict to files containing a checkbox task (default false here)

Example (active projects for a topic): `kb.notes({where:{projects:"Obsidian Workflow"},limit:10})`

### `kb.plate(project?, opts?)` — live tasks, optionally scoped to a project
Active tasks (including the paused Backlog). With a `project` string, limits to notes
whose frontmatter `prop` matches it. This is the "load my backlog [for <project>]" command.
`project` is optional — omit it (or pass opts as the first arg) for all projects.
Lines: same as `active` — `col<TAB>file:line<TAB>body<TAB>age`
`opts`:
- `prop` — frontmatter key to match on (default `projects`)
- `col` — limit to one column (e.g. `"Backlog"`)
- `paths`, `since`, `limit`, `contains` — as in `notes`

Examples:
- all backlog: `kb.plate({col:"Backlog"})`
- whole plate for a project: `kb.plate("Obsidian Workflow")`
- one project's backlog: `kb.plate("Obsidian Workflow",{col:"Backlog"})`

### `kb.moveTask(filePath, line, toCol)` — move a task to a column
`toCol` matched case-insensitively against column names. Throws on unknown file/col.
Returns `ok file:line -> Col` on success.

### `kb.habits(opts?)` — habit stats, one line per habit card
Habits are stopwatch cards (board `columns: Idle~, Doing!`) in files whose frontmatter
carries `metric` (`sum`=hours/day, `count`=sessions/day) or `kbcolor`. A span =
`Idle>Doing … Doing>Idle`; stats are derived from those move stamps.
Lines: `name<TAB>state(idle|DOING)<TAB>today<TAB>7d avg<TAB>streak`
`name` = the task body (one file may hold several habits). `opts.paths` — folder filter.

### `kb.toggle(name, opts?)` — start/stop a habit (the button/LLM primitive)
Flips the habit's card `Idle <-> Doing`: idle→Doing starts the clock, Doing→idle closes
the span. Lets an LLM or a UI button log work without opening the board.
`name` = the habit's task body (case-insensitive); throws if no match or if ambiguous
(two cards share the name — scope with `opts.paths`). Returns `ok <name>: From -> To`.

## Columns

Default config: `Backlog~, Todo, Doing!, Parked~, Done=x, Cancelled=-`
- `~` = paused, `!` = active marker, `=x`/`=-` = terminal states.
- `active()` excludes terminal + paused; `getDone()` covers terminal only.

## Source

`src/api.js` (`buildApi`). Rebuild bundles into `main.js` via `npm run build`.
Keep this skill in sync when api methods or output shapes change.
