# Checkpoint — report card validated as real infra (therapy + CLI build)

date: 2026-06-14 ~23:48 · plugin: backlinks-daily-blocks · branch: develop

Therapy session that doubled as a CLI build. Two reversals, both in his favor. Read
this before re-litigating whether the plugin is a time-waste — that question is settled.

## The therapy verdict (the durable conclusion)

The plugin / report card is **real infrastructure, not procrastination.** He cleared the
falsifiable test I set ("name a past-tense reap, not a 'it will'"). His reaps:
- **Reddit empty-bar → he actually cut Reddit.** Behavior change. Strong.
- **The yellows (open tasks) at-a-glance → he skips scanning the Kanban daily.** Recurring.
- **Report surfaced LIC → caught he owed a lesser amount.** Concrete money decision.
- Sleep visibility → awareness so far; behavior change still open. Soft but real.

His thesis, granted in full: **"fix once, reap everytime."** It's his Restorative+Maximizer
firing, and this very chat proved it — I brute-forced (grep per file by hand), he made me
fix `api.js` instead; the new fns got reaped 3x in 20 min. Infra compounds; raw-hours
undercount it. I was over-indexing on hours and wrong twice (see below).

**The rule we kept (protects the principle from rotting into polish):**
> "fix once reap everytime" is true the moment you can NAME the reap. It rots the moment
> "chef's kiss" is the only answer. Apply the bar PER tweak: nameable reap → build;
> aesthetic-only → Backlog (his own 2026-06-12 tweak-capture-rule). Reap nameable starves
> the tail; chef's-kiss-only feeds it.

This supersedes the harsher framing in the two 06-12/earlier checkpoints ("~9 tweaks 0 cards
Done", "beautiful unshipped thing"). Not retracted — that was true on an EMPTY board during
the trial. Now the board is used and the report card demonstrably changes his behavior. The
tool earned its keep.

## Two times I was wrong this session (honesty trail)

1. **"Plugin won your week 3-to-1."** Built on a 56h bug (below). Corrected: GenHRX was his
   biggest investment (10h30m), plugin #2 (8h39m), real work ~2x the plugin. His "I was
   working on Arka/GenHRX" defense held.
2. **The soft "plugin still 2x your Palo Alto" jab.** Retracted after he named the reaps.

Lesson for me: don't present inflated inference as near-fact; he caught both. Measure, then
talk — and sanity-check the measure before swinging.

## The 56h bug (kb.time) — fixed

Symptom: `kb.time({days:3,by:"projects"})` reported Obsidian Workflow = 56h26m over 3 days
(~19h/day — impossible). Two causes:
- **Code (mine):** summed each card's Doing span independently → parallel cards in Doing
  multiplied wall-clock (5 open at once = 5×).
- **Data (his):** finishing a card with an off-board `[x]` tick writes NO move history, so
  the Doing span never closes → ran to `now`, bleeding across days. One forgotten watch =
  dozens of ghost hours.
Fix in `src/api.js` `time()`: close each Doing span at the NEXT move; if none, clamp to
end-of-its-start-day (`endOfDayMs`); then **UNION** intervals (`unionMs`) instead of summing
so overlap counts once. Result: 56h26m → 8h39m. Believable.
**Behavioral takeaway for him:** close cards by DRAGGING, not `[x]`, or the clock lies.

## CLI shipped this session (all in src/api.js, built to main.js, SKILL.md synced)

- **`opts.fm`** on `active`/`getDone`/`getReport`: pass `fm:"projects,org"` → appends
  `\tprojects=A|B; org=C` per row (missing = `·`). Helper `fmSuffix(app,path,keys)` using
  `metadataCache.getCache(path)`. Killed the per-file grep.
- **`kb.summary(...)`** — done-counts grouped by a fm key (default `projects`) over a range.
  Arg forms mirror getReport. `opts: by,col,sample,paths`. Header `# done by <key> — span —
  N cards` + `group<TAB>count<TAB>sample bodies`. (none) pool; multi-valued counts once/value.
- **`kb.time(...)`** — UNION Doing-time grouped by fm key. `opts: by, col(default Doing),
  sample, paths`. Header `# <col> time (union) by <key> — span — total`. Helpers added:
  `overlap`, `endOfDayMs`, `unionMs`.
- `help()` updated. `kanban-cli/SKILL.md` documents fm/summary/time.

3-day numbers (work only; Habits/Personal Health/Procrastination are stopwatch cards, ignore):
GenHRX 10h30m · Obsidian Workflow 8h39m · Palo Alto 4h33m · Arka 1h28m · US-Bank 1h11m ·
Vyasa 46m · Daksh 27m · LIC 15m.

## Open / next
- Palo Alto: still the lowest-touched high-stakes item (4h33m, "Revision" parked in Todo).
  Not a roast anymore, just a flag.
- Data hygiene: off-board `[x]` ticks corrupt time-tracking — recurring risk until he drags.
- `kb.time`/`summary` could grow a `by:"org"` or per-day breakdown if he wants standup output.
