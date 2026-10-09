// Pure helpers for activity tracking (blueprint: .yeshwanth/blueprints/activity-tracking.md).
// No obsidian import, so node --test loads this file directly.

const GAP_MS = 30 * 60000;

/** 1.1 Sleep gap: the last tick before a gap longer than gapMs, else null.
 * >>> sleepGap(0, 31 * 60000)   // -> 0
 * >>> sleepGap(0, 29 * 60000)   // -> null
 */
function sleepGap(lastTick, now, gapMs = GAP_MS) {
  if (!Number.isFinite(lastTick) || lastTick <= 0) return null;
  return now - lastTick > gapMs ? lastTick : null;
}

/** Moves oldest first. Stamps are minute-precision, so a card moved twice in one minute has equal
 * stamps; the note lists moves newest first, so on a tie the entry lower in the file (higher `seq`)
 * is older. A plain stamp sort kept file order and made Backlog>Doing look like the last move.
 * >>> chrono([{stamp:'1',to:'Done',seq:0},{stamp:'1',to:'Doing',seq:1}]).map(h=>h.to)  // -> ['Doing','Done']
 */
function chrono(history) {
  return history.slice().sort((x, y) => x.stamp.localeCompare(y.stamp) || (y.seq ?? 0) - (x.seq ?? 0));
}

/** Bare yyyymmddhhmm digits -> local ms. */
function stampMs(s) {
  s = String(s).replace(/\D/g, '');
  return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12)).getTime();
}

/** A note's birth from its name `YYYYMMDD-HHmm`, as local ms; null for other names.
 * >>> birthMs('20261007-1227.md') === stampMs('202610071227')  // -> true
 */
function birthMs(name) {
  const m = String(name).match(/^(\d{8})-(\d{4})/);
  return m ? stampMs(m[1] + m[2]) : null;
}

/** 1.2 A backdated move never sorts before the card's latest move.
 * False when the card moved after `at` (another device acted during the gap).
 * >>> backdateOk(stampMs('202610070030'), [{stamp:'202610070100'}])  // -> false
 */
function backdateOk(atMs, history) {
  const latest = Math.max(0, ...history.map(h => stampMs(h.stamp)));
  return atMs >= latest;
}

/** Stints in column `want` clipped to [lo, hi]; an open stint ends at `openEnd`.
 * history: [{stamp, to}] in any order. Returns [{s, e, open}].
 * `stillIn` = the card is in `want` now. A card ticked done off-board, or with out-of-order stamps,
 * can end its history on an entry into `want`; that stint is not running and counts as zero.
 */
function stints(history, want, lo, hi, openEnd, stillIn = true) {
  const ordered = chrono(history);
  const out = [];
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i].to.toLowerCase() !== want) continue;
    if (!ordered[i + 1] && !stillIn) continue;
    const s = stampMs(ordered[i].stamp);
    const raw = ordered[i + 1] ? stampMs(ordered[i + 1].stamp) : openEnd(s);
    const cs = Math.max(s, lo), ce = Math.min(raw, hi);
    if (ce > cs) out.push({ s: cs, e: ce, open: !ordered[i + 1], enter: ordered[i].stamp });
  }
  return out;
}

const MULL_MS = 60 * 60000;
const QUEUE = ['backlog', 'todo'];

/** 5.1 Ad hoc = before its first Doing entry the card spent less than `mullMs` in Backlog and Todo.
 * Queue time starts at `createdMs` (note name stamp), else at the first move. null = never reached Doing.
 * >>> adhoc([{stamp:'202610071000',from:'Backlog',to:'Doing'}], stampMs('202610071000'))          // -> true
 * >>> adhoc([{stamp:'202610071300',from:'Backlog',to:'Doing'}], stampMs('202610071000'))          // -> false
 * >>> adhoc([{stamp:'202610071000',from:'Backlog',to:'Done'}])                                     // -> null
 */
function adhoc(history, createdMs = null, mullMs = MULL_MS) {
  const ordered = chrono(history);
  if (!ordered.length) return null;
  let t = Number.isFinite(createdMs) ? createdMs : stampMs(ordered[0].stamp);
  let queued = 0;
  let inQueue = QUEUE.includes(String(ordered[0].from || 'backlog').toLowerCase());
  for (const h of ordered) {
    const at = stampMs(h.stamp);
    if (inQueue) queued += Math.max(0, at - t);
    if (h.to.toLowerCase() === 'doing') return queued < mullMs;
    inQueue = QUEUE.includes(h.to.toLowerCase());
    t = at;
  }
  return null;
}

/** 5.1 Planned = reached Doing after at least `mullMs` in Backlog and Todo. */
function planned(history, createdMs = null, mullMs = MULL_MS) {
  return adhoc(history, createdMs, mullMs) === false;
}

/** 2.4 Parse one day log (JSON lines). Bad lines are skipped.
 * Each span: {start, end, app, bundle, title, url, space} with ISO times -> ms.
 */
function parseActivity(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      const s = Date.parse(o.start), e = Date.parse(o.end);
      if (Number.isFinite(s) && Number.isFinite(e) && e > s) out.push({ ...o, s, e });
    } catch { /* partial line from a concurrent write */ }
  }
  return out.sort((a, b) => a.s - b.s);
}

/** Total ms of `spans` covered by `cover` (both lists of {s, e}).
 * >>> overlapMs([{s:0,e:10}], [{s:5,e:20}])  // -> 5
 */
function overlapMs(spans, cover) {
  let ms = 0;
  for (const a of spans) for (const b of cover) {
    const s = Math.max(a.s, b.s), e = Math.min(a.e, b.e);
    if (e > s) ms += e - s;
  }
  return ms;
}

/** Merge overlapping {s, e} intervals. */
function union(ivals) {
  const sorted = ivals.slice().sort((a, b) => a.s - b.s);
  const out = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last && x.s <= last.e) last.e = Math.max(last.e, x.e);
    else out.push({ s: x.s, e: x.e });
  }
  return out;
}

/** A card's desktop reference: a number 1-9 or a desktop name from the Kanban Board label store.
 * null when empty or unsafe inside a %% comment.
 * >>> desktopRef(' PenguinAI ')  // -> 'PenguinAI'
 * >>> desktopRef(12)             // -> null
 */
function desktopRef(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s.length > 40 || /[%\r\n]/.test(s)) return null;
  if (/^\d+$/.test(s)) return +s >= 1 && +s <= 9 ? String(+s) : null;
  return s;
}

/** Seconds per column over closed stints (each move to the next); the open stint is the caller's.
 * >>> columnSeconds([{stamp:'202610081000',from:'Todo',to:'Doing'},{stamp:'202610081030',from:'Doing',to:'Parked'}])
 * -> { Doing: 1800 }
 */
function columnSeconds(history) {
  const ev = chrono(history), out = {};
  for (let i = 0; i + 1 < ev.length; i++) {
    const sec = (stampMs(ev[i + 1].stamp) - stampMs(ev[i].stamp)) / 1000;
    if (sec > 0) out[ev[i].to] = (out[ev[i].to] || 0) + sec;
  }
  return out;
}

// Move history rides under the task as hidden comment lines: %% kb 20260611-1530 Todo > Doing %%
// (regex tolerates the older no-space and unhyphenated forms)
const HIST_RE = /^\s*%%\s?kb (\d{8}-?\d{4}) (.+?) > (.+?)\s?%%\s*$/;
const NOTE_END_RE = /^\s*[-*]\s*\[.\]|^\s*---+\s*$/;

/** The move lines of the task at `taskLine`: its notes run until the next task, a `---`, or a
 * line indented no deeper than the task. Returns [{stamp, from, to, seq, line}].
 * >>> taskMoves(['- [ ] a', '  %% kb 20261008-1030 Doing > Done %%', '- [ ] b'], 0).map(h => h.line)  // -> [1]
 */
function taskMoves(lines, taskLine) {
  const base = (lines[taskLine] || '').match(/^\s*/)[0].length;
  const out = [];
  for (let i = taskLine + 1; i < lines.length; i++) {
    const t = lines[i];
    if (NOTE_END_RE.test(t) || (t.trim() && t.match(/^\s*/)[0].length <= base)) break;
    const h = t.match(HIST_RE);
    if (h) out.push({ stamp: h[1].replace(/\D/g, ''), from: h[2], to: h[3], seq: out.length, line: i });
  }
  return out;
}

/** Rewrites the Doing stint that entered at `enter` (bare stamp) in the task's move lines; mutates `lines`.
 * change = {start, end} (bare stamps, either optional) moves the entry or exit move, clamped between
 * the neighbouring moves so the order of moves never changes; change = 'delete' drops the entry move
 * and makes the exit move start from the entry's column (dropped too when that leaves X > X).
 * An open stint has no exit: its end and delete are refused.
 * >>> const L = ['- [ ] a', '  %% kb 20261008-1100 Doing > Done %%', '  %% kb 20261008-1000 Todo > Doing %%'];
 * >>> stintEdit(L, 0, '202610081000', 'delete'); L  // -> ['- [ ] a', '  %% kb 20261008-1100 Todo > Done %%']
 */
function stintEdit(lines, taskLine, enter, change) {
  const ev = chrono(taskMoves(lines, taskLine));
  const i = ev.findIndex(h => h.to.toLowerCase() === 'doing' && h.stamp === String(enter));
  if (i < 0) throw new Error('no Doing stint entered at ' + enter);
  const into = ev[i], exit = ev[i + 1];
  if (!exit && (change === 'delete' || change.end != null)) throw new Error('stint is still open');
  const write = (h, stamp, from) => {
    lines[h.line] = lines[h.line].replace(/kb \d{8}-?\d{4} (.+?) > /, (_, f) => `kb ${stamp.slice(0, 8)}-${stamp.slice(8, 12)} ${from ?? f} > `);
  };
  if (change === 'delete') {
    const drop = exit.to === into.from ? [into.line, exit.line] : [into.line];
    if (drop.length === 1) write(exit, exit.stamp, into.from);
    for (const l of drop.sort((a, b) => b - a)) lines.splice(l, 1);
    return;
  }
  const clamp = (v, lo, hi) => (lo && v < lo ? lo : hi && v > hi ? hi : v);
  const start = change.start == null ? into.stamp : clamp(String(change.start), ev[i - 1]?.stamp, exit?.stamp);
  const end = change.end == null ? exit?.stamp : clamp(String(change.end), start, ev[i + 2]?.stamp);
  write(into, start);
  if (exit) write(exit, end);
}

module.exports = { HIST_RE, taskMoves, stintEdit, birthMs, chrono, columnSeconds, desktopRef, GAP_MS, MULL_MS, sleepGap, stampMs, backdateOk, stints, adhoc, planned, parseActivity, overlapMs, union };
