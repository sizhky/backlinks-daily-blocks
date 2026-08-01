// plugin.api — callable via: obsidian eval "JSON.stringify(await app.plugins.plugins['backlinks-daily-blocks'].api.METHOD())"
const { scanKanbanTasks, moveCard, parseKanbanConfig, stampToDate, cleanText,
  TASK_RE, TAGLINE_RE, COLOR_RE, HIST_RE, EI_HIST_RE } = require('./kanban');
const { collectDayTasks } = require('./report');
const { saveTemplate } = require('./templates');

const DEFAULT_COLS = 'columns: Backlog~, Todo, Doing!, Parked~, Done=x, Cancelled=-';
const HABIT_COLS = 'columns: Idle~, Doing!';

function makeConfig(opts = {}) {
  const lines = [DEFAULT_COLS];
  if (opts.paths) lines.push('paths: ' + opts.paths);
  return parseKanbanConfig(lines.join('\n'));
}

function makeHabitConfig(opts = {}) {
  const lines = [HABIT_COLS];
  if (opts.paths) lines.push('paths: ' + opts.paths);
  return parseKanbanConfig(lines.join('\n'));
}

// A habit is a card whose file declares a `metric` (sum|count) — the single,
// canonical marker. Returns [{ card, colKey ('idle'|'doing'), fm }].
async function habitCards(plugin, opts = {}) {
  const cards = await scanKanbanTasks(plugin.app, makeHabitConfig(opts));
  const out = [];
  for (const [colKey, list] of cards) {
    for (const card of list) {
      const fm = plugin.app.metadataCache.getFileCache(card.file)?.frontmatter || {};
      if (fm.metric == null) continue; // not a habit
      out.push({ card, colKey, fm });
    }
  }
  return out;
}

// --- frontmatter (Obsidian properties) query helpers ---

// parse a span like "1d","3d","1w","2m","1y","6h" -> ms. null/blank -> null.
function spanMs(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d+)\s*([hdwmy])$/i);
  if (!m) return null;
  const n = +m[1], unit = { h: 3.6e6, d: 864e5, w: 6048e5, m: 2592e6, y: 31536e6 };
  return n * unit[m[2].toLowerCase()];
}

// file contains at least one checkbox task ("- [ ]" / "- [x]" ...)
function hasTask(app, f) {
  const li = app.metadataCache.getFileCache(f)?.listItems;
  return !!li && li.some(it => it.task != null);
}

// creation time from the filename's leading digits (YYYYMMDD[HHMM]); null if none.
function fileNameMs(f) {
  const d = f.basename.replace(/[^0-9]/g, '');
  if (d.length < 8) return null;
  return stampToDate(d.slice(0, 8) + (d.length >= 12 ? d.slice(8, 12) : '0000')).getTime();
}

// true if the file shows real activity within the span: filename date (creation) or
// any "%% kb <stamp> %%" task-move stamp >= cut. File mtime is NOT trusted (sync bumps it).
async function activeWithin(app, f, cut) {
  const nm = fileNameMs(f);
  if (nm != null && nm >= cut) return true;        // creation in window — no read needed
  let latest = nm || 0;
  const re = /%%\s?kb (\d{8}-?\d{4}) /g;
  let m;
  for (const line of (await app.vault.cachedRead(f)).split(/\r?\n/)) {
    if ((m = re.exec(line))) { const t = stampToDate(m[1]).getTime(); if (t > latest) latest = t; }
    re.lastIndex = 0;
  }
  return latest >= cut;
}

// markdown files filtered by path prefixes (paths), task-bearing only (tasks), and
// recency (since) — recency keyed off filename + %% kb %% stamps, never mtime.
async function fmFiles(app, paths, since, tasks) {
  const prefixes = paths ? String(paths).split(',').map(s => s.trim()).filter(Boolean) : [];
  const span = spanMs(since);
  const cut = span == null ? null : Date.now() - span;
  const list = app.vault.getMarkdownFiles()
    .filter(f => !prefixes.length || prefixes.some(p => f.path.startsWith(p)))
    .filter(f => !tasks || hasTask(app, f));
  if (cut == null) return list;
  const out = [];
  for (const f of list) if (await activeWithin(app, f, cut)) out.push(f);
  return out;
}

// strip wikilink + alias: "[[Page|Alias]]" -> "Page". Leaves plain strings untouched.
// objects/dates coerced sanely so they don't render as "[object Object]".
function unwrap(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (typeof v.toISOString === 'function') return v.toISOString().slice(0, 10);
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  const s = String(v).trim();
  const m = s.match(/^\[\[([^\]]+)\]\]$/);
  return (m ? m[1].split('|')[0] : s).trim();
}

// frontmatter value -> flat array of normalized strings (handles scalar | array)
function fmVals(fm, key) {
  if (!fm || !(key in fm)) return null;
  const raw = fm[key];
  return (Array.isArray(raw) ? raw : [raw]).map(unwrap);
}

// does any normalized value match `want`? case-insensitive; substring when opts.contains
function matchVal(vals, want, contains) {
  const w = unwrap(want).toLowerCase();
  return vals.some(v => {
    const x = v.toLowerCase();
    return contains ? x.includes(w) : x === w;
  });
}

// trailing "\tkey=a|b; key2=c" of selected frontmatter keys for a file path.
// keys = comma-sep string (opts.fm). Missing value renders "·". "" when no keys.
function fmSuffix(app, path, keys) {
  if (!keys) return '';
  const fm = app.metadataCache.getCache(path)?.frontmatter;
  const list = String(keys).split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) return '';
  return '\t' + list.map(k => `${k}=${(fmVals(fm, k) || []).join('|') || '·'}`).join('; ');
}

function relAge(iso) {
  if (!iso) return '?';
  const ms = Date.now() - new Date(iso).getTime();
  const h = ms / 3.6e6;
  if (h < 1) return Math.max(0, Math.round(ms / 6e4)) + 'm';
  if (h < 24) return Math.round(h) + 'h';
  return Math.round(h / 24) + 'd';
}

function hhmm(stamp) {
  const d = stampToDate(stamp);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function dur(ms) {
  const m = Math.round(ms / 6e4);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
}

function durCompact(ms) {
  const m = Math.round(ms / 6e4);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h' + (m % 60 ? (m % 60) + 'm' : '');
}

function pct(n, d) {
  if (!d) return '0%';
  const v = (n * 100) / d;
  const decimals = (v < 10 && !Number.isInteger(v)) ? 1 : 0;
  return (Math.round(v * 10) / 10).toFixed(decimals) + '%';
}

// ms overlap of interval [s,e] with window [lo,hi]; 0 if disjoint.
function overlap(s, e, lo, hi) {
  const a = Math.max(s, lo), b = Math.min(e, hi);
  return b > a ? b - a : 0;
}

// 23:59:59.999 of the day containing ms.
function endOfDayMs(ms) { const d = new Date(ms); d.setHours(23, 59, 59, 999); return d.getTime(); }

// total ms covered by the UNION of [s,e] intervals (overlaps counted once).
function unionMs(ivals) {
  if (!ivals.length) return 0;
  const s = ivals.slice().sort((a, b) => a[0] - b[0]);
  let total = 0, cs = s[0][0], ce = s[0][1];
  for (let i = 1; i < s.length; i++) {
    const [a, b] = s[i];
    if (a <= ce) { if (b > ce) ce = b; }
    else { total += ce - cs; cs = a; ce = b; }
  }
  return total + (ce - cs);
}

function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// Resolve getReport args into { dates: [YYYYMMDD...], opts }.
// Forms: (date) | (date, opts) | (from, to) | (from, to, opts) | ({days:N, ...opts})
function resolveDates(a, b, c) {
  const toStr = x => String(x).replace(/[^0-9]/g, '').slice(0, 8);
  if (a && typeof a === 'object') {
    const opts = a, n = Math.max(1, opts.days || 1), out = [];
    for (let i = n - 1; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); out.push(ymd(d)); }
    return { dates: out, opts };
  }
  const from = toStr(a);
  if (b != null && typeof b !== 'object') {
    const to = toStr(b), out = [];
    const mk = s => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
    for (let d = mk(from); ymd(d) <= to; d.setDate(d.getDate() + 1)) out.push(ymd(d));
    return { dates: out, opts: c || {} };
  }
  return { dates: [from], opts: b || {} };
}

function hhmmMs(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function hhmmBare(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
}

// segments a task sat in column `want` on dateStr, as "HH:MM->HH:MM :: dur" joined.
// open segment (still in col) closes at end of day, end marked with "~".
function colSegments(history, want, dateStr) {
  const chrono = history.slice().sort((a, b) => a.stamp.localeCompare(b.stamp));
  const y = +dateStr.slice(0, 4), mo = +dateStr.slice(4, 6) - 1, d = +dateStr.slice(6, 8);
  const dayEnd = new Date(y, mo, d, 23, 59, 59).getTime();
  const segs = [];
  let start = null;
  for (const h of chrono) {
    if (h.to.toLowerCase() === want) start = stampToDate(h.stamp).getTime();
    else if (start != null) { segs.push([start, stampToDate(h.stamp).getTime(), false]); start = null; }
  }
  if (start != null) segs.push([start, dayEnd, true]);
  const parts = segs.map(([s, e, open]) => `(${hhmmMs(s)}->${hhmmMs(e)}${open ? '~' : ''} :: ${dur(e - s)})`);
  const total = segs.reduce((a, [s, e]) => a + (e - s), 0);
  return parts.join(', ') + ' = ' + dur(total);
}

function cardJson(card, col) {
  const last = card.history.slice().sort((a, b) => b.stamp.localeCompare(a.stamp))[0] || null;
  return {
    file: card.file.path,
    line: card.line,
    body: card.body,
    col: col.name,
    tags: card.tags,
    since: last ? stampToDate(last.stamp).toISOString() : null,
  };
}

function buildApi(plugin) {
  return {
    // Live tasks (non-terminal). Paused cols (e.g. Backlog~) are excluded by default,
    // but INCLUDED when explicitly requested via opts.col or opts.includePaused.
    // Returns tab-lines: col<TAB>file:line<TAB>body<TAB>age[<TAB>timestamp]
    // opts: { paths, col, tag, staleDays, limit, includePaused, timestamps }
    async active(opts = {}) {
      const config = makeConfig(opts);
      const byCol = await scanKanbanTasks(plugin.app, config);
      const keepPaused = !!opts.col || !!opts.includePaused;
      let rows = config.columns
        .filter(c => !c.state && (keepPaused || !c.paused))
        .flatMap(col => (byCol.get(col.key) || []).map(card => cardJson(card, col)));
      if (opts.col) rows = rows.filter(r => r.col.toLowerCase() === String(opts.col).toLowerCase());
      if (opts.tag) {
        const t = String(opts.tag).toLowerCase();
        rows = rows.filter(r => r.tags.some(x => x.toLowerCase().includes(t)) || r.body.toLowerCase().includes(t));
      }
      if (opts.staleDays) {
        const cut = Date.now() - opts.staleDays * 864e5;
        rows = rows.filter(r => r.since && new Date(r.since).getTime() <= cut);
      }
      if (opts.limit) rows = rows.slice(0, opts.limit);
      return '\n' + rows.map(r => `${r.col}\t${r.file}:${r.line}\t${r.body}\t${relAge(r.since)}${opts.timestamps ? `\t${r.since || ''}` : ''}${fmSuffix(plugin.app, r.file, opts.fm)}`).join('\n');
    },

    // Freeform notes for one task: every line between the task and the next task
    // line (any indent), minus the metadata block (tag/color/%%kb%%/%%ei%%).
    // arg = "file:line" (the file:line other reads emit) or (filePath, line).
    // Returns the trimmed prose, "" when the task has no notes.
    async note(arg, line) {
      let path = arg;
      if (line == null && typeof arg === 'string' && arg.includes(':')) {
        const i = arg.lastIndexOf(':'); path = arg.slice(0, i); line = +arg.slice(i + 1);
      }
      const file = plugin.app.vault.getAbstractFileByPath(path);
      if (!file) throw new Error('file not found: ' + path);
      const lines = (await plugin.app.vault.cachedRead(file)).split(/\r?\n/);
      if (!TASK_RE.test(lines[line] || '')) throw new Error(`no task at ${path}:${line}`);
      const meta = t => TAGLINE_RE.test(t) || COLOR_RE.test(t) || HIST_RE.test(t) || EI_HIST_RE.test(t);
      const out = [];
      for (let i = line + 1; i < lines.length && !TASK_RE.test(lines[i]); i++) {
        if (!meta(lines[i])) out.push(lines[i]);
      }
      return '\n' + out.join('\n').replace(/^\n+|\n+$/g, '');
    },

    // Tasks moved to a terminal column on a date — "what I did"
    // Tab-lines: col<TAB>file:line<TAB>body<TAB>HH:MM
    async getDone(date, opts = {}) {
      const dateStr = String(date).replace(/[^0-9]/g, '').slice(0, 8);
      const want = opts.col && String(opts.col).toLowerCase();
      const config = makeConfig(opts);
      const byCol = await scanKanbanTasks(plugin.app, config);
      const rows = config.columns
        .filter(c => c.state && (!want || c.name.toLowerCase() === want))
        .flatMap(col => (byCol.get(col.key) || [])
          .map(card => ({ card, move: card.history.find(h => h.stamp.startsWith(dateStr) && h.to === col.name) }))
          .filter(({ move }) => move)
          .map(({ card, move }) => `${col.name}\t${card.file.path}:${card.line}\t${card.body}\t${hhmm(move.stamp)}${fmSuffix(plugin.app, card.file.path, opts.fm)}`)
        );
      return '\n' + rows.join('\n');
    },

    // Full move timeline for a day — "how the day flowed"
    // Tab-lines: file:line<TAB>body<TAB>HH:MM from>to  HH:MM from>to ...
    async getReport(a, b, c) {
      const { dates, opts } = resolveDates(a, b, c);
      const want = opts.col && String(opts.col).toLowerCase();
      const config = makeConfig(opts);
      const multi = dates.length > 1;
      const out = [];
      for (const dateStr of dates) {
        let tasks = await collectDayTasks(plugin.app, dateStr, config.paths);
        if (want) tasks = tasks.filter(t => t.history.some(h => h.to.toLowerCase() === want));
        const rows = tasks.map(t => {
          const suf = fmSuffix(plugin.app, t.file.path, opts.fm);
          if (want) return `${t.file.path}:${t.line}\t${t.body}\t${colSegments(t.history, want, dateStr)}${suf}`;
          const moves = t.history.map(h => `${hhmm(h.stamp)} ${h.from || '·'}>${h.to}`).join('  ');
          return `${t.file.path}:${t.line}\t${t.body}\t${moves}${suf}`;
        });
        if (multi) out.push(`== ${dateStr} ==`, ...(rows.length ? rows : ['(none)']));
        else out.push(...rows);
      }
      return '\n' + out.join('\n');
    },

    // Roll up terminal-column moves (i.e. "done") over a date range, grouped by a
    // frontmatter key. The single command behind "what did I ship, by project".
    // Arg forms mirror getReport: (date) | (from,to) | ({days:N, ...opts}).
    // opts: { by (fm key, default "projects"), col (terminal-col filter), paths,
    //         sample (max sample bodies per group, default 3) }
    // Lines: groupVal<TAB>doneCount<TAB>sample, bodies (capped)
    async summary(a, b, c) {
      const { dates, opts } = resolveDates(a, b, c);
      const by = opts.by || 'projects';
      const cap = opts.sample || 3;
      const want = opts.col && String(opts.col).toLowerCase();
      const config = makeConfig(opts);
      const byCol = await scanKanbanTasks(plugin.app, config);
      const dateSet = new Set(dates);
      const groups = new Map(); // groupVal -> { n, bodies:[] }
      for (const col of config.columns) {
        if (!col.state || (want && col.name.toLowerCase() !== want)) continue;
        for (const card of (byCol.get(col.key) || [])) {
          if (!card.history.some(h => h.to === col.name && dateSet.has(h.stamp.slice(0, 8)))) continue;
          const vals = fmVals(plugin.app.metadataCache.getCache(card.file.path)?.frontmatter, by);
          for (const g of (vals && vals.length ? vals : ['(none)'])) {
            const e = groups.get(g) || { n: 0, bodies: [] };
            e.n++; if (e.bodies.length < cap) e.bodies.push(cleanText(card.body));
            groups.set(g, e);
          }
        }
      }
      const total = [...groups.values()].reduce((a, e) => a + e.n, 0);
      const rows = [...groups.entries()].sort((a, b) => b[1].n - a[1].n)
        .map(([g, e]) => `${g}\t${e.n}\t${e.bodies.join(', ')}`);
      const span = dates.length > 1 ? `${dates[0]}..${dates[dates.length - 1]}` : dates[0];
      return `\n# done by ${by} — ${span} — ${total} cards\n` + rows.join('\n');
    },

    // Actual TIME cards spent in a column (default Doing) over a date range, grouped by a
    // frontmatter key — the "hours per project" measure (vs summary's card COUNT).
    // Walks each card's full history, pairs enter>exit for the column, clips overlap to the
    // window; an unclosed span counts up to now. Arg forms mirror getReport.
    // opts: { by (default "projects"), col (default "Doing"), paths, sample (default 3) }
    // Lines: groupVal<TAB>Xh Ym<TAB>N cards<TAB>sample, bodies
    async time(a, b, c) {
      const { dates, opts } = resolveDates(a, b, c);
      const by = opts.by || 'projects';
      const want = String(opts.col || 'Doing').toLowerCase();
      const cap = opts.sample || 3;
      const byCol = await scanKanbanTasks(plugin.app, makeConfig(opts));
      const mk = s => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
      const lo = mk(dates[0]).getTime();
      const hiD = mk(dates[dates.length - 1]); hiD.setHours(23, 59, 59, 999);
      const hi = hiD.getTime();
      const groups = new Map(); // g -> { ivals:[[s,e]], cards:Set, bodies:[] }
      const allIvals = [];      // every interval, for the wall-clock grand total
      for (const [, list] of byCol) {
        for (const card of list) {
          const chrono = card.history.slice().sort((x, y) => x.stamp.localeCompare(y.stamp));
          const ivals = [];
          for (let i = 0; i < chrono.length; i++) {
            if (chrono[i].to.toLowerCase() !== want) continue;
            const s = stampToDate(chrono[i].stamp).getTime();
            // close at the NEXT move; if none (off-board [x] tick left it open) clamp to end of that day
            const e = chrono[i + 1] ? stampToDate(chrono[i + 1].stamp).getTime() : endOfDayMs(s);
            const cs = Math.max(s, lo), ce = Math.min(e, hi);
            if (ce > cs) ivals.push([cs, ce]);
          }
          if (!ivals.length) continue;
          allIvals.push(...ivals);
          const vals = fmVals(plugin.app.metadataCache.getCache(card.file.path)?.frontmatter, by);
          for (const g of (vals && vals.length ? vals : ['(none)'])) {
            const e = groups.get(g) || { ivals: [], cards: new Set(), bodies: [] };
            e.ivals.push(...ivals); e.cards.add(card.file.path + ':' + card.line);
            if (e.bodies.length < cap) e.bodies.push(cleanText(card.body));
            groups.set(g, e);
          }
        }
      }
      const span = dates.length > 1 ? `${dates[0]}..${dates[dates.length - 1]}` : dates[0];
      const rows = [...groups.entries()]
        .map(([g, e]) => [g, unionMs(e.ivals), e])
        .sort((a, b) => b[1] - a[1])
        .map(([g, ms, e]) => `${g}\t${dur(ms)}\t${e.cards.size} cards\t${e.bodies.join(', ')}`);
      return `\n# ${want} time (union) by ${by} — ${span} — ${dur(unionMs(allIvals))} total\n` + rows.join('\n');
    },

    // Chronicle of time spent in a column (default Doing), sorted by stint start.
    // Lines: HHMM:HHMM[~]<TAB>dur<TAB>body
    async chronicle(a, b, c) {
      const { dates, opts } = resolveDates(a, b, c);
      const want = String(opts.col || 'Doing').toLowerCase();
      const byCol = await scanKanbanTasks(plugin.app, makeConfig(opts));
      const multi = dates.length > 1;
      const out = [];
      let grandTracked = 0;
      let grandElapsed = 0;
      for (const dateStr of dates) {
        const lo = new Date(+dateStr.slice(0, 4), +dateStr.slice(4, 6) - 1, +dateStr.slice(6, 8)).getTime();
        const hi = endOfDayMs(lo);
        const today = ymd(new Date()) === dateStr;
        const elapsed = Math.max(0, (today ? Date.now() : hi) - lo);
        const segs = [];
        for (const [, list] of byCol) for (const card of list) {
          const chrono = card.history.slice().sort((x, y) => x.stamp.localeCompare(y.stamp));
          for (let i = 0; i < chrono.length; i++) {
            if (chrono[i].to.toLowerCase() !== want) continue;
            const s = stampToDate(chrono[i].stamp).getTime();
            const rawEnd = chrono[i + 1]
              ? stampToDate(chrono[i + 1].stamp).getTime()
              : (today ? Date.now() : endOfDayMs(s));
            const cs = Math.max(s, lo), ce = Math.min(rawEnd, hi);
            if (ce <= cs) continue;
            segs.push({ s: cs, e: ce, open: !chrono[i + 1] && today, body: cleanText(card.body) });
          }
        }
        const tracked = segs.reduce((sum, x) => sum + (x.e - x.s), 0);
        grandTracked += tracked;
        grandElapsed += elapsed;
        const rows = segs.sort((a, b) => a.s - b.s)
          .map(x => `${hhmmBare(x.s)}:${hhmmBare(x.e)}${x.open ? '~' : ''}\t${durCompact(x.e - x.s)}\t${x.body}`);
        const footer = `TOTAL\t${dur(tracked)}\t${pct(tracked, elapsed)} elapsed`;
        if (multi) out.push(`== ${dateStr} ==`, ...(rows.length ? rows : ['(none)']), footer);
        else out.push(...rows, footer);
      }
      if (multi) {
        out.push(`== total ==`, `TOTAL\t${dur(grandTracked)}\t${pct(grandTracked, grandElapsed)} elapsed`);
      }
      return '\n' + out.join('\n');
    },

    // List available methods.
    help() {
      return '\n' + [
        'active(opts?)            live tasks on plate; opts: paths,col,tag,staleDays,limit,timestamps',
        'getDone(date,opts?)      tasks moved to terminal col on a date',
        'note("file:line")        freeform notes under a task (prose to next task)',
        'getReport(...)           move timeline; day | from,to | {days:N}',
        'chronicle(...)           day chronicle of Doing stints; day | from,to | {days:N}',
        'summary(...)             done counts grouped by fm key; opts: by,col,sample,paths',
        '   note: active/getDone/getReport take opts.fm="projects,org" to append fm cols',
        'plate(project,opts?)     a project\'s live tasks (incl Backlog); opts: prop,col,paths,since,limit',
        'moveTask(file,line,col)  move a task to a column',
        'habits(opts?)            habit stats: state, today, 7d avg, streak; opts: paths',
        'toggle(name,opts?)       flip a habit idle<->Doing (start/stop logging); opts: paths',
        'props(opts?)             frontmatter schema of task files; opts: paths,sample,since,tasks',
        'notes(opts)             query notes by frontmatter; opts: where,paths,limit,contains,since,tasks',
        'help()                   this list',
      ].join('\n');
    },

    // Discover frontmatter schema of this vault — no hardcoded keys.
    // Tab-lines: key<TAB>noteCount<TAB>sample,values,distinct (capped)
    // opts: { paths, sample (max distinct values per key, default 8) }
    async props(opts = {}) {
      if (typeof opts === 'string') opts = { since: opts }; // kb.props("1w") shorthand
      const cap = opts.sample || 8;
      const tasks = opts.tasks !== false; // default: only task-bearing files; pass {tasks:false} for all notes
      const files = await fmFiles(plugin.app, opts.paths, opts.since, tasks);
      const counts = new Map();   // key -> note count
      const seen = new Map();     // key -> Set of normalized values
      for (const f of files) {
        const fm = plugin.app.metadataCache.getFileCache(f)?.frontmatter;
        if (!fm) continue;
        for (const key of Object.keys(fm)) {
          if (key === 'position') continue; // obsidian-internal
          counts.set(key, (counts.get(key) || 0) + 1);
          const set = seen.get(key) || new Set();
          for (const v of (fmVals(fm, key) || [])) if (v) set.add(v);
          seen.set(key, set);
        }
      }
      const rows = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k}\t${n}\t${[...seen.get(k)].slice(0, cap).join(', ')}`);
      return '\n' + rows.join('\n');
    },

    // Query notes by frontmatter properties. Keys caller-supplied, never baked in.
    // where: { KEY: VAL, ... } — note matches when EVERY key matches (any array elem).
    // Tab-lines: file<TAB>key=val; key=val  (the queried props' actual values)
    // opts: { where (required), paths, limit, contains }
    async notes(opts = {}) {
      const where = opts.where || {};
      const keys = Object.keys(where);
      const files = await fmFiles(plugin.app, opts.paths, opts.since, opts.tasks); // opts.tasks:true -> task-bearing only
      const rows = [];
      for (const f of files) {
        const fm = plugin.app.metadataCache.getFileCache(f)?.frontmatter;
        if (!fm) continue;
        const ok = keys.every(k => {
          const vals = fmVals(fm, k);
          return vals && matchVal(vals, where[k], opts.contains);
        });
        if (!ok) continue;
        const shown = keys.map(k => `${k}=${(fmVals(fm, k) || []).join('|')}`).join('; ');
        rows.push(`${f.path}\t${shown}`);
        if (opts.limit && rows.length >= opts.limit) break;
      }
      return '\n' + rows.join('\n');
    },

    // A project's live plate: active tasks (incl. paused Backlog) in notes whose
    // frontmatter `prop` matches `project`. The notes∩active cross-query, packaged.
    // opts: { prop (default "projects"), col, paths, since, limit, includePaused }
    async plate(project, opts = {}) {
      if (project && typeof project === 'object') { opts = project; project = null; } // opts-first call
      const prop = opts.prop || 'projects';
      let rows = (await this.active({ col: opts.col, includePaused: true, limit: opts.limit })).split('\n').filter(Boolean);
      if (project) { // filter to notes whose frontmatter `prop` matches `project`
        const files = await fmFiles(plugin.app, opts.paths, opts.since, false);
        const set = new Set(files
          .filter(f => {
            const vals = fmVals(plugin.app.metadataCache.getFileCache(f)?.frontmatter, prop);
            return vals && matchVal(vals, project, opts.contains);
          })
          .map(f => f.path));
        rows = rows.filter(l => set.has((l.split('\t')[1] || '').split(':')[0]));
      }
      return '\n' + rows.join('\n');
    },

    // Move a task to a column
    async moveTask(filePath, line, toCol) {
      const file = plugin.app.vault.getAbstractFileByPath(filePath);
      if (!file) throw new Error('file not found: ' + filePath);
      const config = makeConfig();
      const col = config.columns.find(c => c.name.toLowerCase() === String(toCol).toLowerCase());
      if (!col) throw new Error('unknown col: ' + toCol);
      await moveCard(plugin.app, file, line, col, config, {});
      return `ok ${filePath}:${line} -> ${col.name}`;
    },

    // Habit stats — one line per habit card. opts: { paths }.
    // Lines: name<TAB>state(idle|DOING)<TAB>today<TAB>7d<TAB>streak
    async habits(opts = {}) {
      const { habitStats, fmtHours } = require('./habits');
      const now = new Date();
      const rows = (await habitCards(plugin, opts))
        .map(x => ({ ...x, label: cleanText(x.card.body) }))
        .sort((a, b) => a.label.localeCompare(b.label))
        .map(({ card, colKey, fm, label }) => {
          const metric = (card.metric || fm.metric) === 'count' ? 'count' : 'sum';   // inline %% kbmetric %% beats fm
          const st = habitStats(card.history, metric, now);
          const f = (v) => metric === 'count' ? `${Math.round((v || 0) * 10) / 10}x` : fmtHours(v);
          const state = colKey === 'doing' ? 'DOING' : 'idle';
          if (!st) return `${label}\t${state}\tno logs\t\t`;
          return `${label}\t${state}\ttoday ${f(st.today)}\t7d ${f(st.avg7)}\t${st.streak}d`;
        });
      return '\n' + rows.join('\n');
    },

    // Toggle a habit's stopwatch: idle -> Doing (start) or Doing -> idle (stop).
    // This is the button/LLM primitive — log work without opening the board.
    // `name` = the habit file's basename (case-insensitive). opts: { paths }.
    async toggle(name, opts = {}) {
      const want = String(name).toLowerCase();
      const items = (await habitCards(plugin, opts)).map(x => ({ ...x, label: cleanText(x.card.body) }));
      const matches = items.filter(x => x.label.toLowerCase() === want);
      if (!matches.length) throw new Error('habit not found: ' + name);
      if (matches.length > 1) throw new Error(`ambiguous habit "${name}" — ${matches.length} cards match`);
      const it = matches[0];
      const config = makeHabitConfig(opts);
      const cur = config.columns.find(c => c.key === it.colKey);
      const target = it.colKey === 'doing'
        ? config.columns.find(c => !c.state && c.paused)  // stop -> Idle
        : config.columns.find(c => c.live);               // start -> Doing
      await moveCard(plugin.app, it.card.file, it.card.line, target, config, { fromCol: cur });
      return `ok ${it.label}: ${cur.name} -> ${target.name}`;
    },

    // Snapshot the ACTIVE note's properties into a reusable, provenance-stamped
    // template (body dropped). Notes made from it inherit `template`/`template-version`
    // for a future retroactive "propagate". Usage: kb.saveTemplate("Project ABC").
    async saveTemplate(name) {
      return saveTemplate(plugin, name);
    },
  };
}

module.exports = { buildApi };
