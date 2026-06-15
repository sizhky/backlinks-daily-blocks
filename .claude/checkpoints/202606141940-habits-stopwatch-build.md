# Checkpoint — Habits Stopwatch Build (fat)
date: 2026-06-14 ~19:40 · plugin: backlinks-daily-blocks · branch: develop

Two layers here: (1) the full technical build of a habit-tracking system, and
(2) the behavioral/therapy thread that ran underneath it. Yeshwanth flagged he'll
want the second layer "for therapy some time later." Both kept honest below.

---

## 1. WHAT WE BUILT — technical handoff

### The model (decided this session)
- A **habit** is NOT a pipeline task. Pipeline tasks die at Done (one-shot, scarce).
  Habits never terminate — they loop and are measured over time.
- A habit is a **stopwatch card** on a two-column board: `columns: Idle~, Doing!`.
  - `Idle~` is paused (so its dwell time is excluded from "spent"); it's column[0]
    so the `~` does NOT trigger aging/rot.
  - A **span** = an `Idle>Doing … Doing>Idle` pair. Duration = end − start.
  - Multiple spans/day allowed (nap, snack). No cadence, no respawn, no terminal Done.
    "Done" was rejected; the card just laps.
- **Canonical marker (single source of truth):** a card is a habit iff its FILE
  frontmatter declares `metric` (`sum` = hours/day, `count` = sessions/day).
  `kbcolor` was explicitly DROPPED as a habit signal (color is cosmetic). Rejected
  `habit: true` as redundant/forceful — `metric` both flags and scores.
- **Identity = the task body** (cleanText(card.body)), NOT the filename. One file can
  hold many habits (Waste Time.md → `Reddit`, `Youtube`). Earlier "Waste Time shown
  twice" was a naming bug from keying on basename; fixed by keying on body.

### Files / folder
`00-09 Me/03 Daily/Habits/` (user moved it out of `/1992` mid-session):
- Sleep, Swim, Read → `metric: sum`
- Food, Angamardana, Shambhavi Kriya → `metric: count`
- Waste Time → `metric: sum`, projects `[[Procrastination]]`, holds Reddit + Youtube
Each habit file frontmatter: `projects`, `kbcolor` (file default tint), `metric`.

### On-disk format (a task block)
```
- [ ] Youtube
  %% kbcolor #e93147 %%      <- per-task color override (optional), PINNED under task
  %% kb 202606141845 Doing > Idle %%   <- logs, NEWEST ON TOP
  %% kb 202606141830 Idle > Doing %%
```
- Per-task color marker `%% kbcolor #hex %%` overrides file frontmatter `kbcolor`.
  Precedence everywhere: per-task `%% kbcolor %%` → file `kbcolor` → column color.
- Log insertion: `commentInsertAt` now skips config lines (tag line + `%% kbcolor %%`)
  so new `%% kb %%` logs land BELOW config, newest-on-top. Config never sinks.
  (This replaced the old "insert at line+1/line+2" that buried kbcolor.)

### Code paths (exact)
- **src/habits.js** (NEW): `spans(history)` pairs Idle>Doing…Doing>Idle (unclosed →
  end:null = in progress). `bucketByDay(history,metric,year)` → Map day→{value,sessions,open},
  midnight-cross owned by END date. `collectHabits(app,paths,year)` filters to
  `metric`-present files, name = cleanText(body), color = card.color||fm.kbcolor.
  `habitStats(history,metric,now)` → today, avg7, avg30, streak (consecutive days
  with a session; today-not-done doesn't break), min/mean/max, trend (avg7 vs avg30).
  `renderHabitsBlock` = year heatmap grid (7 rows × ~53 wk). `fmtHours(h)` → "8h 9m".
- **src/kanban.js**:
  - `COLOR_RE = /%% kbcolor (#hex|word) %%/`; parsed in scanKanbanTasks → `card.color`.
  - card render: `mode: habits` block flag swaps the flow-bar footer for habit footer
    (trend arrow + `today · 7d avg · streak`, hover = min/mean/max). Lazy
    `require('./habits')` to avoid circular import.
  - card tint: `card.color || fm.kbcolor` → `--kb-card-color` (left border + title).
  - `commentInsertAt` rewrite (log ordering, above).
  - collapse button (`fold-vertical`) now folds empty cols AND terminal cols (`col.state`).
  - `fit()` captures+restores page scrollTop around height change (kills the page jump).
  - vault `modify` handler ignores our own writes via `state.selfWriteAt` (<1500ms).
  - "work" → "spent" label rename. Idle declared `Idle~`.
- **src/report.js** (daily Gantt): paused cols → gap (rail shows through), terminal cols
  → 3px endpoint tick at completion (NOT a stretched bar), active sliver wears
  `task.color || fm.kbcolor`. `lane: <prop>` groups rows w/ per-group rollup header
  `Nt · Xh active · N done`. `COLOR_RE` parsed in collectDayTasks. Legend drops paused
  (keeps terminal). Imports `fmtDur`.
- **src/api.js** (CLI, `globalThis.kb`): `kb.habits(opts?)` →
  `name<TAB>state(idle|DOING)<TAB>today<TAB>7d<TAB>streak`. `kb.toggle(name,opts?)` flips
  Idle<->Doing (THE button/LLM logging primitive). `habitCards()` filters metric-only.
  identity = body; toggle refuses ambiguous names. fmtHours for sum.
- **src/main.js**: `registerMarkdownCodeBlockProcessor('habits', renderHabitsBlock)`.
- **styles.css**: `.bdb-habits*`, `.bdb-habit-grid/cell`, `.bdb-h0..h4`, `.bdb-h-open`
  (pulse), `.bdb-kanban-card-habit`, `.bdb-kanban-card-tinted`, `.bdb-report-mark`,
  `.bdb-report-group*`, `.bdb-report-rollup`.
- **Tasks.md**: report block (`columns: …Idle~…`, `lane: projects`); Personal kanban
  `filter: org!=Divami, projects!=Habits`; two Habits kanban boards (`mode: habits`,
  `columns: Idle~, Doing!`, split by `projects=Personal Health` vs `!=`); habits block.
- **kanban-cli/SKILL.md**: documented `kb.habits` + `kb.toggle`.

### Build / validate / reload
- `npm run build` (esbuild bundles src/main.js → main.js).
- Reload running plugin:
  `obsidian eval code='(async()=>{await app.plugins.disablePlugin("backlinks-daily-blocks");await app.plugins.enablePlugin("backlinks-daily-blocks")})()'`
- IMPORTANT: Obsidian caches rendered code blocks; plugin reload does NOT re-render
  open panes. Force it:
  `app.workspace.iterateAllLeaves(l=>{const v=l.view;if(v&&v.previewMode&&v.getViewType()==="markdown")v.previewMode.rerender(true)})`
- CLI smoke: `obsidian eval code='kb.habits()'`, `kb.toggle("Swim")`.

### Dead ends / gotchas
- Page-jump hunt: added `[bdb-jump]` console.debug across redraw/tick/modify/fit;
  found move-jump = DOUBLE redraw (immediate in-place + the vault-modify echo 500ms
  later) → fixed via selfWriteAt suppression. Minute-jump CAUSE STILL UNVERIFIED
  (something writes a file ~every 60s — sync? another plugin? the clock tick itself
  does NOT redraw). Fixed the SYMPTOM via scroll-preserve in fit. Debug logs since
  removed (grep main.js for bdb-jump = 0).
- Folder reorg mid-session caused me to clobber empty stubs + create junk
  Breakfast/Lunch/Dinner.md once; deleted them. Lesson: re-read dir state before bulk writes.
- Lots of toggle-test residue (0-min spans, dup Doing>Idle, dangling open spans) got
  written into Swim.md / Waste Time.md and cleaned by hand. Watch for more.

### Open debt / tunable
- Swim.md has a bare ```habits``` block (no paths → current file only) the user added.
- Heatmap knobs still default: color scale = per-habit auto min/max; blank past day =
  empty (no guilt-red, deliberate); open span = live pulse.
- Food is `count` (debatable vs `sum`).
- Memory updated: `memory/habits-stopwatch-model.md` (+ MEMORY.md index line).

---

## 2. THE THERAPY THREAD — for later

How it started: "load my backlog for obsidian workflow" → the backlog had exactly
ONE card: *"Talk about recurring tasks. Is it in infinite pool of backlog?"*

What happened: he turned that single capture card into a multi-hour feature-build
session. That IS the pattern from his own profile — Ideation #1 + Maximizer #5 +
Learner #4 walking him down a beautiful rabbit hole. His OWN rule (tweak-capture-rule,
written 2026-06-12) says plugin tweaks are "procrastinating shit," capture-then-batch.
He blew past it two days later. The tell: the moment we got within one decision of a
buildable spec, he asked for a roast — last-mile flinch dressed as self-awareness.

His pushback (and it was legitimate, not deflection): "3 days of kanban discipline is
the most in my life — this isn't belief, it's evidence, I'm one or two iterations
away." Granted in full: 3 days where there was zero IS real evidence. BUT "one or two
iterations away" is the exact sentence Maximizer uses to never ship — the fog of
options. The discipline came from the board EXISTING and being USED, not from it being
perfect.

The real why (his words): he doesn't want to optimize sleep — he wants *proof he's
holding it together*, to "track my life with more peace." A green grid that says "you're
functioning." The risk: Maximizer will always find the blank cell, so no amount of
heatmap will ever be enough reassurance. The honest question under all of it: *am I okay
right now, yes/no* — which only he can answer, not a plugin.

The design arc mirrored the psychology: kanban → heatmap → dot-matrix → back to kanban
"with special status" → guilt about miss-tracking → flipped to streaks/wins → realized
habits aren't tasks at all, they're an event log + a record you glance at. The unlock:
**the discipline came from the act of logging the move, not from the pipeline.** Habits
need the logger, not the pipeline.

The genuinely good instinct he showed: refusing to build prematurely ("that just causes
more iterations") — that's the opposite of the rabbit-hole reflex, and it was correct.
And wanting toggle-buttons so he logs hands-free *while focusing on work, not on logging*
— that's the right north star: the tool should disappear.

Things to poke later: (a) did the habit system actually get USED for a week before being
touched again, or did it become the next beautiful unshipped thing? (b) what was the
real need under "track my life with peace," and did a green grid meet it or just defer
the question? (c) the artifact bar: this session produced a working, shipped feature —
that's a real last-mile win, not just exploration. Credit it.
