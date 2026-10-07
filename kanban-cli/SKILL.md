---
name: kanban-cli
description: Query and mutate the backlinks-daily-blocks kanban board from the shell via `obsidian eval`. Use when an LLM needs to read the user's task plate, see what was done on a date, get a day's move timeline, create a task, or move a task between columns without opening Obsidian.
metadata:
  version: "0.3.0"
---

# Kanban CLI

Plugin `backlinks-daily-blocks` exposes a JS api over the `obsidian eval` CLI.
On plugin load it sets `globalThis.kb = this.api`, so calls are short.

## AXI CLI (preferred for agents)

`kanban-cli/axi.mjs` wraps the `kb` api as an AXI-compliant CLI: gh-style
subcommands + flags, TOON output on stdout, structured errors, exit codes
(0 ok / 1 error / 2 usage). It shells out to `obsidian eval` under the hood,
so the plugin must be loaded. Prefer this over raw `kb.*` eval calls.

```
node kanban-cli/axi.mjs                       # content-first dashboard (active tasks + next steps)
node kanban-cli/axi.mjs list --col Todo --limit 5
node kanban-cli/axi.mjs plate "Obsidian Workflow" --col Backlog
node kanban-cli/axi.mjs view 20260616-0946.md:0 [--full]
node kanban-cli/axi.mjs move 20260616-0946.md:0 Done
node kanban-cli/axi.mjs scopes --query InfoshareSystems
node kanban-cli/axi.mjs create "Reply to Srinivas" --org InfoshareSystems --project AAA
node kanban-cli/axi.mjs done 20260620 [--col Done]
node kanban-cli/axi.mjs report 20260620      # single date = TOON; --days N / from to = grouped raw
node kanban-cli/axi.mjs chronicle 20260620   # time stints in Doing (or --col)
node kanban-cli/axi.mjs summary --days 3 --by projects
node kanban-cli/axi.mjs props 1w             # discover frontmatter schema
node kanban-cli/axi.mjs notes --where projects="Obsidian Workflow" --limit 10
node kanban-cli/axi.mjs habits
node kanban-cli/axi.mjs toggle Cook
```

- No args = dashboard. Any subcommand takes `--help` for its flags + examples.
- Output is TOON (`tasks[N]{col,ref,body,age}:` etc.), ~40% leaner than JSON.
- `ref` is the `file:line` token echoed in list rows; pass it straight to `view`/`move`.
- Errors print `error: …` / `help: …` on stdout — read and act, don't re-run blindly.
- The `kb.*` methods below remain the source of truth; the CLI is a thin TSV→TOON skin.

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
`age` is relative (`30m`, `7h`, `1d`). With `opts.timestamps: true`, each row
adds the exact ISO move timestamp after `age`. Other `opts`:
- `paths` — folder filter (string)
- `col` — only this column (case-insensitive)
- `tag` — substring match on tags or body
- `staleDays` — only tasks untouched ≥ N days
- `since` — only tasks created or last moved within a span such as `24h` or `1d`
- `limit` — cap row count
- `timestamps` — append the exact timestamp used to calculate `age`

Example: `kb.active({col:"Todo",limit:3})`

All read methods return a leading `\n` then tab-separated lines (token-lean, not JSON).

### `kb.getDone(date, opts?)` — what moved to a terminal column on a date
`date` = anything; non-digits stripped, first 8 digits used as `YYYYMMDD`.
Lines: `col<TAB>file:line<TAB>body<TAB>HH:MM`
`opts.col` — limit to one terminal column. `opts.paths` — folder filter.

### `kb.note(arg, line?)` — freeform notes attached to one task
The prose body that lives under a task: every line between the task line and the
**next task line** (any indent), with the metadata block (tag line, `%% kbcolor %%`,
`%% kb %%`, `%% ei %%`) stripped out. This is how a task carries notes naturally —
write prose under it, fetch on demand without opening the file.
`arg` = `"file:line"` (the exact `file:line` the other reads emit) or `(filePath, line)`.
Returns the trimmed prose (leading `\n` like other reads), `""` when there are none.
Throws if the file is missing or the line isn't a task.
Example: `kb.note("20260616-0946.md:0")`

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
TOTAL	10h10m	42% elapsed
```
`~` means the stint is still open now.
Chronicle appends `TOTAL<TAB>tracked<TAB>P% elapsed`.
For today, `% elapsed` uses midnight -> now. For completed days, full day.
`opts.refs: true` appends `<TAB>file:line` to each stint row (the Kanban Board Timeline opens cards from it).

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

### `kb.board(opts?)` — configured columns for native clients
Returns every configured column in order, including empty and terminal columns.
Each column starts with `@column<TAB>Name`; task rows use the `active()` shape.
`opts.hours` filters every column except `opts.full` (default `Doing`); default is 24.
`opts.timestamps: true` appends the ISO time of the last move after `age` (the done time for terminal columns).
Example: `kb.board({hours:24,full:"Doing"})`

### `kb.moveTask(filePath, line, toCol)` — move a task to a column
`toCol` matched case-insensitively against column names. Throws on unknown file/col.
Returns `ok file:line -> Col` on success.

### `kb.moveTasks(refs, toCol, opts?)` — move several tasks to a column
`refs` is an array of `file:line`. Same-file refs move bottom-up so line numbers stay valid.
No open-children guard (same as `moveTask`). Returns `ok <moved>`.
`opts.at` (ISO time) backdates the history stamp; a card whose latest move is after `at` is skipped. The Kanban Board app uses it for activity switch rules.

### `kb.planned(...)` — planned vs unplanned time in Doing

Arg forms mirror `getReport` (`20261007`, `from,to`, `{days:7}`). Planned = before its first Doing entry the card spent at
least `opts.mull` minutes (default 60) in Backlog and Todo, counted from the note's `YYYYMMDD-HHmm` name. Otherwise it is ad hoc.
First line: both totals with percentages. Then `planned|unplanned<TAB>dur<TAB>file:line<TAB>body`, longest first.

### `kb.reportCards(from, to, opts?)` — Reports input for the Kanban Board app

Every card with a Doing stint in the range or a terminal move in the range. `opts.mull` = mulling minutes (default 60).
Rows: `file:line<TAB>title<TAB>orgs a|b<TAB>projects a|b<TAB>desktop<TAB>adhoc 1|0|-<TAB>done epoch s|-<TAB>lifetime Doing s<TAB>start-end,...`
(stints clipped to the range, epoch seconds). Untracked = done in range with lifetime 0. The app splits stint time by activity.

### `kb.activity(date?)` — captured Mac activity vs Doing for one day

Reads `<vault>/.activity/YYYYMMDD.jsonl`, written by the Kanban Board app. First line: active, doing, doing without activity, activity outside doing. Then `app<TAB>dur<TAB>top window title`. The same day renders in a note with a ```` ```activity ```` block (`date: YYYYMMDD` optional; default is the note's file-name date).

Sleep auto-park: the plugin keeps a 60 s heartbeat on desktop. After a gap above 30 minutes it moves Doing cards to Parked (habit cards to Idle), stamped at the last tick before the gap.

### `kb.rankTasks(pairs, toCol?)` — manual card order
`pairs` is `[[file:line, rank], ...]`. Writes a `%% kbrank N %%` line under each task (lower
first; unranked cards sort after ranked ones in every column). With `toCol`, cards in another
column move there first. Same-file refs go bottom-up. Returns `ok <n>`.
`kb.active({rank:true})` appends each row's rank (empty when unranked) after `age`.

### `kb.setDesktop(ref, d)` — macOS desktop of a card

`d` is a desktop number 1-9 or a desktop name; `null` clears. Writes `%% kbdesktop <d> %%` under the task; frontmatter `kbdesktop: <d>` is the note default. Names come from the Kanban Board app's label store (`<vault>/.activity/desktops.json`, keyed by Space UUID), so a named card follows its desktop when desktops are reordered. Renaming a desktop in the app rewrites cards that used the old name. `active({desktop:true})` lists the reference as written.

### `kb.setEstimate(ref, min)` and `kb.estimates(opts?)` — time guess vs time in Doing
`ref` = `file:line`. `min` (minutes) writes `%% kbest N %%` under the task; `null` clears it. Returns `ok <ref> est <n|none>`.
`kb.estimates()` lists every card with a guess as `file:line<TAB>estMinutes<TAB>tookMinutes`; took is the summed time in `opts.col` (default Doing) from the move log. The Kanban Board app asks for a guess when a card moves into Doing and shows both in Logbook.

### `kb.sweep(fromCol, toCol, refs?)` — bulk-move a column
Same as the board's sweep button: same-file cards move bottom-up, and terminal
targets skip cards with open children. `refs` (array of `file:line`) limits the
sweep to those cards; omit it to sweep the whole column. Returns `ok <moved> <blocked>`.

### `kb.sweeps()` — sweep routes from settings
Tab lines `From<TAB>To`, one per configured route (settings `kanban.sweep`).

### `kb.openTask(filePath, line)` — open a task in Obsidian
Opens the source note, moves the editor cursor to the task line, and scrolls it into view.
Returns `ok opened file:line`.

### `kb.scopes(opts?)` — active organization/project combinations
Returns `org<TAB>project<TAB>count<TAB>status`, ranked by observed task-note count.
Inactive combinations are hidden unless `opts.all` is true. `opts.query` filters both names.

### `kb.createTask(opts)` — create one validated task note
Requires `text`, `org`, and `project`; `col` defaults to `Backlog`.
The organization/project combination must exist and remain active in `kb.scopes()`.
Returns `file<TAB>line<TAB>org<TAB>project<TAB>column<TAB>body`.

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

## Creating a task

Use `kanban create` or `kb.createTask`; do not construct task Markdown in an agent.

Manage active organizations and projects in the `scopes` code block in
`90-99 Obsidian Meta/Kanban Scopes.md`. Organization status applies to all its projects.
Project status remains saved while its organization is inactive. Legacy inactive frontmatter rules remain supported:

```yaml
kanban-inactive-orgs:
  - "[[OldOrg]]"
kanban-inactive-projects:
  - "[[FinishedProject]]"
kanban-inactive-scopes:
  - "CurrentOrg / PausedProject"
```

A task remains a **checkbox line inside a note**, never a standalone file with a `# heading` or `Status::` prop. The API creates:

1. New note path: `~/Vault/$(date +%Y%m%d-%H%M).md` (a daily note). Keep the hyphen between date and time.
2. Frontmatter carries the project (and org) the board filters on:
   ```
   ---
   org:
     - "[[Divami]]"
   projects:
     - "[[Arka]]"
   ---
   ```
3. The task line + a move stamp comment. Column tag is `#kb/<col-lowercase>`; the stamp records the move with proper-case column names:
   ```
   - [ ] Task title #kb/doing
     %% kb <YYYYMMDD-HHmm> Backlog > Doing %%

   Optional freeform prose under the task becomes its note (see kb.note).
   ```
4. Verify with `kb.plate("<Project>",{col:"Doing"})` — the row should appear.

To create directly in Backlog, use `#kb/backlog` and stamp `Backlog > Backlog` (or omit the stamp). Move later with `kb.moveTask`.

## Columns

Default config: `Backlog~, Todo, Doing!, Parked~, Done=x, Cancelled=-`
- `~` = paused, `!` = active marker, `=x`/`=-` = terminal states.
- `active()` excludes terminal + paused; `getDone()` covers terminal only.

## Source

`src/api.js` (`buildApi`). Rebuild bundles into `main.js` via `npm run build`.
Keep this skill in sync when api methods or output shapes change.
