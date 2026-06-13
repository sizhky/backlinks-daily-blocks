# Checkpoint: swimlanes shipped + the feature-creep therapy he asked me to throw back at him

Session 2026-06-12 evening. Built the entire lane/filter feature for the kanban block — same
trial week he swore (until ~2026-06-18) he'd leave the board ALONE and just use it. He didn't.
He asked, point-blank, for this checkpoint to "point my stupidity in asking for silly
features." So here it is, blunt, as ordered.

## The therapy thread — read this FIRST next session

### What actually happened today
- Trial week, day 1-2. The deal (memory: kanban-week-trial) was: USE the board, bring back
  real usage problems, NO redesigns until ~2026-06-18.
- He opened with "let's talk swimlanes" — I called the BS (Ideation #1 sniffing a new toy).
  He said "appreciate calling my bs, let's just talk." Good. Lasted about two messages.
- I pulled his vault data and showed him the verdict: **5 notes with open tasks, 0 open Divami
  tasks.** He was designing swimlanes for traffic that doesn't exist on the road yet.
- He read that, said "i know what i'm asking. implement both" — and overrode the trial.
  That's his right. But name what it was: the failure mode wearing a productivity costume.

### The honest scoreboard (he asked me to keep pointing at this)
Today's ratio: ~9 tweaks shipped to the TOOL, **0 cards moved to Done** on the board the tool
exists to serve. The features built today, in order:
1. filter: + lane: notation
2. foldable lanes (<details>)
3. big lane titles
4. hide all-done lanes
5. negation (!=), then pipe-OR (|), then multi-filter
6. board padding
7. foldable COLUMNS into vertical strips
8. single board-wide horizontal scroll
9. dot/text overlap fix, gap tuning, chevron restyle, accent color
10. flash-free minute tick (this one was a real fix — see technical)
11. lane count (x/y), then flipped done→open
12. lanesort knob, then settings dropdown, then asc/desc ×3 keys, then (none) tie rules,
    then (none) pinned-last-for-name-sort

Read that list back. Two of those (the flash fix, the dot overlap) were the board *lying or
unusable* — legitimate, fix-now. The other ~10 were "would be nicer if." Every single one
felt important in the moment. That feeling is the symptom, not the signal.

### The self-awareness moment (the good part)
Mid-session he stopped and said it himself: "these tweaks feel important but they are also
procrastinating shit... I want to track these but I won't even know I want it until I realize
it, so it doesn't even occur to add them." That is the whole disease stated in one breath:
- Ideation #1 generates wants faster than Discipline #34 can gate them.
- He can't pre-plan the wants (they're emergent), so he feels he MUST act now or lose them.
- Acting now = constant mid-flow context switches = the board never gets used, only built.

I gave him the out he already owned: the board scans the whole vault, so capture = one
`- [ ]` line in whatever note he's in, lands in Backlog free. The discipline isn't
remembering — it's NOT acting on it now. Overnight-in-Backlog is the itch-vs-need filter;
half dissolve by morning and you only learn which half by waiting. This became a committed
rule (memory: tweak-capture-rule): blocker = fix now, everything else = Backlog card,
batch weekly. He said "dhanyavaadam guru" — he accepted it.

### So the stupidity, named plainly (as requested)
- He asked for swimlanes for an EMPTY board. The data said wait; he built anyway.
- He then iterated those swimlanes ~10 times — sort directions, tie-breaking for a lane
  named "(none)" that has THREE cards in it — polishing the display of work he isn't doing.
- The (none)-tie-break debate is the tell: that's CS-grade attention spent on the cosmetics
  of a board with 5 live tasks. Bikeshedding his own bikeshed.
- He LITERALLY built a "capture tweaks to Backlog instead of building them now" rule... and
  then kept building tweaks now. The rule's first test is tomorrow morning, not tonight.

### How to hold him next session (he wants this)
1. First feature request that isn't the board-is-broken: ask "blocker or Backlog card?"
   Hold the line. He welcomes it; glazing is despised.
2. Remind him the trial runs to ~2026-06-18 and the scoreboard is cards-Done, not
   features-shipped.
3. If he says "I know what I'm asking" again — fine, build it, but say the ratio out loud
   first so the override is conscious, not automatic.

## Technical state (all shipped, built, working)

### Lane / filter feature — all in src/kanban.js + styles.css + src/settings.js
- `filter:` frontmatter conditions, AND across lines. Forms: `key=val` (match, brackets/case
  ignored), `key!=val` (no value matches — keyless notes pass too), `key` (present), `!key`
  (absent), `key=a|b` (OR within a key, composes with !=). parseFilters/passesFilter/fmValues.
- `lane:` groups by first frontmatter value of that key; cards without it pool in `(none)`.
  laneSplit() builds per-lane column maps. Lanes are VIEWPORT only — drag still moves columns,
  never rewrites frontmatter (moves-not-labels respected; cross-lane drag = misfile fix, rare).
- Lanes render as native `<details>`/`<summary>`; fold state in state.folded (Set), survives
  redraws, resets on reload. Chevron `›` rotates 90° open, accent-colored title, big (1.2em).
- `hidedonelanes:` (default false) — hide lanes with nothing in an open column. Knob only.
- Lane title shows `(open/total)` — open = cards in open columns. NOTE: this is the INVERSE
  of the card rollup pill which is `closed/total`. He chose this deliberately: lane answers
  "how much left", pill answers "how done". They will diverge; that's intended.
- `lanesort:` "<key>-<dir>", key=total|open|name, dir=desc|asc. Default total-desc. Settings
  has a 6-option dropdown (src/settings.js renderKanban). Block lanesort overrides settings;
  resolveKanbanConfig falls back to defaults.lanesort. Bare `open`/`total` still parse.
  Sort rule: numeric keys → byKey, (none) loses ties to real lanes, then A→Z. NAME keys →
  (none) ALWAYS pinned last, real lanes A→Z or Z→A above it.

### Foldable columns
- Click any column title to fold/unfold to a ~2.4em vertical strip (writing-mode: vertical-rl,
  rotated title + count). Empty columns auto-fold; manual toggle overrides until a DROP into
  the column clears the fold (state.colFold Map, keyed `${laneName}::${colKey}`).
- Folded columns stay live drop targets. Sweep buttons + card lists hidden while folded.
- Dot::before uses margin-inline-end (0.7em) so the gap follows writing mode in both
  orientations (was margin-right — broke when vertical, dot overlapped text).

### Single horizontal scroll across lanes
- .bdb-kanban-stacked: overflow-x auto on the board; .bdb-kanban-lane is min-width:max-content;
  lane rows no longer scroll individually. Lane titles position:sticky left:0 so they stay
  readable mid-scroll. Caveat: per-lane column folds → rows can differ in width; far-right
  scroll ends earlier for lanes with more folded columns. Acceptable; board-wide fold would
  fix it if it ever bugs him.

### Flash-free clock tick (the one genuinely-good fix today)
- WAS: 60s interval → redraw → drawBoard → board.empty() → full rescan + re-render + refit.
  That full teardown was the "flash every minute." Sledgehammer for a clock tick.
- NOW: drawBoard collects state.timeUpdaters[] (reset each full draw). Each non-terminal,
  in-sync card with history pushes a closure that patches IN PLACE: the .bdb-kanban-card-now
  text, the live visit's bar span (marked .bdb-kanban-live-span) flex-grow, and the aging
  amber/red class. The 60s interval now calls tick() (runs updaters) not redraw(). Full
  drawBoard still fires on vault-modify and drops, where the rebuild is wanted. Terminal cards
  freeze → no updater. Bonus: amber/red age threshold now crosses live.
- liveDur = Date.now() - stampToDate(last.stamp); identical to `since` when inSync.

### Build / test
- `npm run build` in plugin dir (esbuild src/main.js → main.js, ~87kb). JS changes need
  Obsidian reload; CSS hot via pane reload.
- Parser smoke-test harness: stub obsidian at /tmp/kbtest/node_modules/obsidian/index.js,
  override Module._resolveFilename for 'obsidian' and './core/render', then require kanban.js
  and call parseKanbanConfig. Used it to verify filter/lanesort parsing this session.
- His live board: Tasks.md. Settings → Kanban tab now has Lane sort dropdown.

## Not done (Backlog candidates per his own new rule — do NOT just build these)
- README documents NONE of the new keys (filter/lane/hidedonelanes/lanesort). One-pass write
  when he's settled the grammar.
- Settings tab has no filter/lane/hidedonelanes defaults (block-only right now).
- Board-wide (vs per-lane) column fold, if the ragged-right-scroll ever bothers him.

## Resume hint
Next session almost certainly opens with another "small tweak." The correct first move is the
question, not the Edit tool: "blocker, or Backlog card?" Then, if he overrides, say the
scoreboard out loud. That is the job he hired me for this week.
