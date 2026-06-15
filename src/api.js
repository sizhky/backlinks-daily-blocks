// plugin.api — callable via: obsidian eval "JSON.stringify(await app.plugins.plugins['backlinks-daily-blocks'].api.METHOD())"
const { scanKanbanTasks, moveCard, parseKanbanConfig, stampToDate, cleanText } = require('./kanban');
const { collectDayTasks } = require('./report');

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
  const re = /%%\s?kb (\d{12}) /g;
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
    // Returns tab-lines: col<TAB>file:line<TAB>body<TAB>age
    // opts: { paths, col, tag, staleDays, limit, includePaused }
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
      return '\n' + rows.map(r => `${r.col}\t${r.file}:${r.line}\t${r.body}\t${relAge(r.since)}`).join('\n');
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
          .map(({ card, move }) => `${col.name}\t${card.file.path}:${card.line}\t${card.body}\t${hhmm(move.stamp)}`)
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
          if (want) return `${t.file.path}:${t.line}\t${t.body}\t${colSegments(t.history, want, dateStr)}`;
          const moves = t.history.map(h => `${hhmm(h.stamp)} ${h.from || '·'}>${h.to}`).join('  ');
          return `${t.file.path}:${t.line}\t${t.body}\t${moves}`;
        });
        if (multi) out.push(`== ${dateStr} ==`, ...(rows.length ? rows : ['(none)']));
        else out.push(...rows);
      }
      return '\n' + out.join('\n');
    },

    // List available methods.
    help() {
      return '\n' + [
        'active(opts?)            live tasks on plate; opts: paths,col,tag,staleDays,limit',
        'getDone(date,opts?)      tasks moved to terminal col on a date',
        'getReport(...)           move timeline; day | from,to | {days:N}',
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
          const metric = fm.metric === 'count' ? 'count' : 'sum';
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
  };
}

module.exports = { buildApi };
