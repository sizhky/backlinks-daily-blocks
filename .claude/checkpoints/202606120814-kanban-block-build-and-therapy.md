# Checkpoint: kanban block build + workflow therapy session

Session span: 2026-06-11 → 2026-06-12. One long session: built the entire ```kanban``` feature
for the backlinks-daily-blocks Obsidian plugin from scratch, interleaved with workflow-design
therapy. Trial week running until ~2026-06-18 (see memory: kanban-week-trial).

## Technical state (all shipped, built, working)

### Architecture
- `src/kanban.js` — everything kanban: config parse, vault scan, line rewrite, board render.
  Registered in `src/main.js` as markdown code block processor `kanban`.
- `src/settings.js` — tabbed settings (Kanban/Backlinks/Daily/Views), `mergeSettings`,
  textarea binds, read-only config preview + Copy button (`kanbanBlockText()`).
- `styles.css` — all board CSS at bottom of file. CSS-only changes need NO rebuild;
  JS changes need `npm run build` (esbuild bundles src/main.js → main.js).
- `data.json` — live user settings. Has stale `logfile` key (dead feature, harmless).

### Data model / file conventions (THE contract)
- Task = any `- [ ]` line, any indent, any note. `TASK_RE = /^(\s*[-*]\s*\[)(.)(\]\s*)(.*)$/`.
- Column membership: open columns via `#kb/<key>` tag; no tag = first column.
  Terminal columns via checkbox char (`[x]`, `[-]`).
- Terminal move: sets char, strips `#kb` tag, appends stamp `YYYYMMDDHHmm` to line end.
  Reopen (drag out): `[ ]`, strip stamp, add tag.
- Move history: hidden comment one indent level under task: `%% kb 202606111530 From > To %%`
  (`HIST_RE` tolerates old no-space form `%%kb ...%%`). Attaches to deepest task above with
  shallower indent — indent measured by `indentWidth()` (tab=4; char-count comparison was a
  real bug with mixed tabs/spaces, fixed).
- Task birth = note filename `YYYYMMDD-HHmm` prefix. Only vault-wide convention assumed.
- Nesting: indent stack in `scanKanbanTasks`; every task at any depth is a card with
  `parent`/`children` refs. Unindented non-task line resets stack.

### Column spec grammar (one per line or comma-sep)
`Name[~][!][=x] [@color]`
- `~` paused/idle: time excluded from work totals; aging stripes apply (not first column).
- `!` live: heartbeat — card border+glow pulse and column wash overlay, 4.8s, color = column color.
- `=x` terminal: maps checkbox char. Duplicate state chars → block-level error message.
- `@color` inline color; overrides palette. `COL_PALETTE` by key (backlog/todo/doing/parked/
  review/done/cancelled), `COL_CYCLE` for unknowns.
- Default: `Backlog~, Todo, Doing!, Parked~, Done=x, Cancelled=-`, maxage 7, sweep Doing>Parked(+user's routes).

### Other config keys (block body; settings = defaults; block wins)
- `paths:` comma prefixes; `maxage: N` hides terminal cards stamped older than N days
  (unstamped terminal also hidden when maxage on — deliberate); `sweep:` routes `From > To`
  one per line (continuation-line parser: bare lines belong to last key);
  legacy `colors:` key still parses.
- `resolveKanbanConfig(plugin, src)` re-resolved on EVERY redraw — settings edits reach live
  boards (closure-staleness bug fixed; was why sweeps "didn't show").
- Defaults merge gotcha fixed: `@colors` from settings columns string now merged
  (`config.colors = {...d.colors, ...config.colors}`).

### Board behaviors
- Drag-drop HTML5; dataTransfer `path::line::fromKey`. Full column = drop zone (flex stretch).
- Terminal drop refused while open `[ ]` descendants: red dashed outline on dragover
  (`rejects()` via `state.card`), Notice on drop. Cancelled children count as closed.
- Sweep: ghost button `⤳ Target` on From column header, always visible (even empty col).
  Same-file cards processed bottom-up (history insert shifts lines — ordering matters).
- Live refresh: `MarkdownRenderChild` + 60s interval + debounced (500ms) `vault.on('modify')`;
  `state.dragging` guards mid-drag redraws.
- Cards: title (markdown-rendered, tags/stamp stripped) + inline rollup pill `closed/total`
  (all descendants; green when full) + parent breadcrumb (click → scroll + glow parent card,
  fallback openFileAtLine) + two journey bars (3px each: full timeline incl idle / active-only;
  flex-grow ∝ duration, min 3px) + label: open = `Doing 33m`, terminal = `16m work · 3d total`
  (frozen at completion stamp) + footer `notebasename · stamp` (click → jump to line).
- Label trusts actual column; history supplies duration only when last.to matches column
  (off-board edits — manual checkbox ticks — write no history; was the "Doing label on Done
  card" confusion; the green segment was a real prior Done visit).
- Aging WIP: paused columns (not first) — amber left stripe >2d, red >7d.
- Parent cards: stacked-paper box-shadows (lines at 4px/8px — equidistant, his OCD), 2px border.
  Live parents have separate keyframe preserving stack shadows under glow.
- Pulse: card border + 10px glow at peak; column wash via ::before overlay opacity 0→0.22
  (color-mix in keyframes strobes in Electron — opacity interpolates; that was the "jump scare").

### Dead ends / rejected designs (don't resurrect without cause)
- Central `Kanban Log.md` append log: built, then replaced by under-task `%% kb %%` history
  (he wants per-task time, co-located). `logfile` key removed from settings.
- Journey as text trail on card: too busy → replaced by bars + tooltip.
- Undo-collapse of backward moves in trail: built, he rejected — "good to accept my mistakes".
  Full linear history is the truth.
- Terminal-cap / kill-bar options rejected → "took Xm work · Y total" design instead.
- Sub-task blocks rendered inside cards: removed — cards show title only.

## Therapy thread (read this before next session)

He's explicitly running this as half coding, half self-management therapy. Profile at
`/Users/yeshwanth/Vault/00-09 Me/01 Strenghts and Weaknesses/CLAUDE.md` — Ideation #1,
Discipline #34, "beautiful exploration that ships nothing" is the named failure mode.
He ASKS to be held to commitments. Roasting welcome; glazing despised.

### Commitments he made (hold him to these)
1. **Trial week** until ~2026-06-18: use the board, come back with usage problems, no new
   redesigns. Parked idea: parents-as-swimlanes / generic group-by + filter on frontmatter
   (categories/projects) — captured in vault note `20260611-1638.md` with mull-notes.
2. **WIP curfew**: Doing empty before sleep = success; else sweep to Parked. He named it
   "treat workflow as failure if something is in Doing before I sleep."
3. **Parent two-drag convention**: parents move only Backlog→Todo (commit) and →Done
   (rollup full). Children do the real walking.
4. **Capped Todo** (~5): move into Todo must cost something; uncapped Todo = backlog with
   better posture. (Advice given; cap not enforced in code.)

### Question patterns he brings (and what worked)
- "Let's just talk / no code" — he genuinely means it; deliver assessment, stop. Building
  during a talk-request is a violation. He'll say "build it" / "go" when ready.
- Concept-grounding questions: "what does Jira do", "what's this called in common parlance"
  (sweep/carryover, aging WIP, lead vs cycle time). He wants industry vocabulary + whether
  the distinction earns its keep for HIM specifically, pros/cons, then his own call.
- Self-doubt framed as feature questions: "do I need backlog vs todo or am I inventing steps?",
  "do I really need parked/done durations?", "I have commitment issues...". Pattern: validate
  the design instinct where real, name the psychological function bluntly (Backlog absorbs
  Ideation flood; Todo is the commitment device; Parked age = honesty signal), warn the trap
  (ritual without meaning, system-becomes-the-project).
- He spots conceptual asymmetries himself (parent=clock/lead vs child=hourglass/cycle;
  "parked-as-string isn't special but its STATUS is" → became the `~` attribute; "nothing
  special about these two columns" → sweep as generic route). Reward: turn his observation
  into a general mechanism, never a hardcoded name.
- Visual taste: minimal, OCD about spacing, "make it louder/slower/more obvious" iterations
  follow every visual feature. Expect 2-3 rounds. No emojis.

### Working agreements observed this session
- Caveman tone, ≤5 sentences, but correctness/safety prose allowed.
- "go turbo" granted early — 50-line chunk limit waived since.
- Config syntax: ruthlessly lean, newline-over-comma, attributes-over-fields, no clutter.
- He edits settings/files mid-session — staleness bugs surfaced twice (closure config,
  README sed); always verify against live file before diagnosing.
- Memory file exists: `kanban-week-trial.md` — remind him of trial if he feature-creeps
  before 2026-06-18; after, start from his reported problems (group-by/lanes = lead candidate).

## Resume hints
- Build: `npm run build` in plugin dir. Reload Obsidian only for JS; CSS hot via pane reload.
- His live board: `Tasks.md` (empty block = all defaults from data.json).
- Next likely asks: trial-week problem reports, group-by/swimlanes, Todo cap enforcement,
  maybe `Blocked~` column, maybe pulse tuning round 4.
