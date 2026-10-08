// plugin.api — callable via: obsidian eval "JSON.stringify(await app.plugins.plugins['backlinks-daily-blocks'].api.METHOD())"
const { scanKanbanTasks, editLines, moveCard, sweepColumn, setRankLine, setDesktopLine, setEstLine, addActiveLine, noteText, setNoteLines, taskColumn, parseKanbanConfig, stampToDate, cleanText,
  stampNow, stampWrite, TASK_RE, TASK_END_RE, TAGLINE_RE, COLOR_RE, HIST_RE, EI_HIST_RE } = require('./kanban');
const { collectDayTasks } = require('./report');
const { backdateOk, stints, planned, adhoc, birthMs, desktopRef, chrono, stampMs, MULL_MS, columnSeconds } = require('./core/activity');
const { activitySummary } = require('./activity');
const { saveTemplate } = require('./templates');
const { parkAll } = require('./sleep');
const { openFileAtLine } = require('./core/render');

const DEFAULT_COLS = 'columns: Backlog~, Todo, Doing!, Parked~, Done=x, Cancelled=-';
const HABIT_COLS = 'columns: Idle~, Doing!';
const SCOPE_NOTE = '90-99 Obsidian Meta/Kanban Scopes.md';

function makeConfig(opts = {}, plugin) {
  const defaults = plugin?.settings?.kanban || {};
  const columns = String(defaults.columns || DEFAULT_COLS.replace('columns: ', ''))
    .split(/\r?\n|,/).map(s => s.trim()).filter(Boolean).join(', ');
  const lines = ['columns: ' + columns];
  const paths = opts.paths || defaults.paths;
  if (paths) lines.push('paths: ' + paths);
  return parseKanbanConfig(lines.join('\n'));
}

// History lines ({stamp, to}) directly under one task line.
async function cardHistory(app, file, line) {
  const lines = (await app.vault.read(file)).split(/\r?\n/);
  const base = (lines[line] || '').match(/^\s*/)[0].length;
  const out = [];
  for (let i = line + 1; i < lines.length; i++) {
    if (lines[i].trim() && lines[i].match(/^\s*/)[0].length <= base) break;
    const h = lines[i].match(HIST_RE);
    if (h) out.push({ stamp: h[1].replace(/\D/g, ''), to: h[3] });
  }
  return out;
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
  const stamp = fileNameStamp(f);
  return stamp ? stampToDate(stamp).getTime() : null;
}

function fileNameStamp(f) {
  const m = f.basename.match(/^(\d{8})(?:-(\d{4}))?/);
  return m ? m[1] + (m[2] || '0000') : null;
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

function scopeRules(app, path = SCOPE_NOTE) {
  const file = app.vault.getAbstractFileByPath(path);
  return file ? app.metadataCache.getFileCache(file)?.frontmatter || {} : {};
}

function scopeOrgInactive(rules, org) {
  return (fmVals(rules, 'kanban-inactive-orgs') || []).some(x => x.toLowerCase() === org.toLowerCase());
}

function scopeProjectActive(rules, org, project) {
  const raw = rules['kanban-scope-statuses'];
  const entries = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  const override = entries.find(item =>
    item && typeof item === 'object'
    && unwrap(item.org).toLowerCase() === org.toLowerCase()
    && unwrap(item.project).toLowerCase() === project.toLowerCase());
  if (override && typeof override.active === 'boolean') return override.active;
  const has = (key, value) => (fmVals(rules, key) || []).some(x => x.toLowerCase() === value.toLowerCase());
  return !has('kanban-inactive-projects', project)
    && !has('kanban-inactive-scopes', `${org} / ${project}`);
}

function scopeInactive(rules, org, project) {
  return scopeOrgInactive(rules, org) || !scopeProjectActive(rules, org, project);
}

async function scopeRows(app, opts = {}) {
  const scopeNote = opts.scopeNote || SCOPE_NOTE;
  const rules = scopeRules(app, scopeNote);
  const files = await fmFiles(app, opts.paths, opts.since, opts.tasks === true);
  const counts = new Map();
  for (const file of files) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    for (const org of (fmVals(fm, 'org') || [])) for (const project of (fmVals(fm, 'projects') || [])) {
      const key = `${org.toLowerCase()}\t${project.toLowerCase()}`;
      const row = counts.get(key) || { org, project, count: 0 };
      row.count++;
      counts.set(key, row);
    }
  }
  const query = String(opts.query || '').toLowerCase();
  const allRows = [...counts].map(([, { org, project, count }]) => {
    return { org, project, count, status: scopeInactive(rules, org, project) ? 'inactive' : 'active' };
  }).sort((a, b) => a.org.localeCompare(b.org) || a.project.localeCompare(b.project));
  return allRows.filter(row => (opts.all || row.status === 'active') && (!query || `${row.org} ${row.project}`.toLowerCase().includes(query)))
    .sort((a, b) => b.count - a.count || a.org.localeCompare(b.org) || a.project.localeCompare(b.project));
}

async function setScopeStatus(app, { org, project, active }, path = SCOPE_NOTE) {
  const file = app.vault.getAbstractFileByPath(path);
  if (!file) throw new Error(`scope registry not found: ${path}`);
  const rows = await scopeRows(app, { all: true, scopeNote: path });
  const members = rows.filter(row => row.org.toLowerCase() === String(org).toLowerCase());
  await app.fileManager.processFrontMatter(file, fm => {
    const inactiveOrgs = fm['kanban-inactive-orgs'];
    const inactive = inactiveOrgs == null ? [] : Array.isArray(inactiveOrgs) ? inactiveOrgs : [inactiveOrgs];
    const activeOrgs = inactive.filter(value => unwrap(value).toLowerCase() !== org.toLowerCase());
    if (!project) {
      if (!active) activeOrgs.push(`[[${org}]]`);
      fm['kanban-inactive-orgs'] = activeOrgs;
    }
    const raw = fm['kanban-scope-statuses'];
    const entries = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
    const affected = project ? members.filter(row => row.project.toLowerCase() === project.toLowerCase()) : members;
    const affectedNames = new Set(affected.map(row => row.project.toLowerCase()));
    const kept = entries.filter(item => !item || typeof item !== 'object'
      || unwrap(item.org).toLowerCase() !== org.toLowerCase()
      || !affectedNames.has(unwrap(item.project).toLowerCase()));
    for (const row of affected) kept.push({
      org: row.org,
      project: row.project,
      active: !!active,
    });
    if (project && active) fm['kanban-inactive-orgs'] = activeOrgs;
    if (project && !active && !members.some(row =>
      row.project.toLowerCase() !== project.toLowerCase() && row.status === 'active')) {
      fm['kanban-inactive-orgs'] = [...activeOrgs, `[[${org}]]`];
      for (const row of members) {
        const entry = kept.find(item => item && typeof item === 'object'
          && unwrap(item.org).toLowerCase() === org.toLowerCase()
          && unwrap(item.project).toLowerCase() === row.project.toLowerCase());
        if (entry) entry.active = false;
      }
    }
    fm['kanban-scope-statuses'] = kept;
  });
  return `ok ${org}${project ? ` / ${project}` : ''}: ${active ? 'active' : 'inactive'}`;
}

function taskNote({ text, org, project, col, stamp }) {
  const body = String(text).replace(/\s+/g, ' ').trim();
  return `---\norg:\n  - ${JSON.stringify(`[[${org}]]`)}\nprojects:\n  - ${JSON.stringify(`[[${project}]]`)}\n---\n\n- [ ] ${body} #kb/${col.toLowerCase()}\n  %% kb ${stamp} Backlog > ${col} %%\n`;
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
  const ordered = chrono(history);
  const y = +dateStr.slice(0, 4), mo = +dateStr.slice(4, 6) - 1, d = +dateStr.slice(6, 8);
  const dayEnd = new Date(y, mo, d, 23, 59, 59).getTime();
  const segs = [];
  let start = null;
  for (const h of ordered) {
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
  const movedAt = last ? stampToDate(last.stamp).getTime() : 0;
  const recent = Math.max(fileNameMs(card.file) || 0, movedAt) || null;
  return {
    file: card.file.path,
    line: card.line,
    body: card.body,
    col: col.name,
    tags: card.tags,
    rank: card.rank ?? null,
    desktop: card.desktop ?? null,
    since: recent ? new Date(recent).toISOString() : null,
    recent,
  };
}

// Kanban Board card ID -> daily-note basename and 1-based task ordinal (Card.identifier in the app).
// parseTaskId("HTP-261008-1106.01") -> { key: "HTP", base: "20261008-1106", ordinal: 1 }
// parseTaskId("OW-260613-1844")     -> { key: "OW", base: "20260613-1844", ordinal: 1 }
function parseTaskId(id) {
  const m = String(id).trim().match(/^([A-Za-z0-9]+)-(\d{6})-(\d{4})(?:\.(\d{2}))?$/);
  if (!m) return null;
  return { key: m[1].toUpperCase(), base: `20${m[2]}-${m[3]}`, ordinal: m[4] ? +m[4] : 1 };
}

function filterSince(rows, since, now = Date.now()) {
  const span = spanMs(since);
  if (span == null) return rows;
  const cut = now - span;
  return rows.filter(row => row.recent != null && row.recent >= cut);
}

function buildApi(plugin) {
  return {
    // Live tasks (non-terminal). Paused cols (e.g. Backlog~) are excluded by default,
    // but INCLUDED when explicitly requested via opts.col or opts.includePaused.
    // Returns tab-lines: col<TAB>file:line<TAB>body<TAB>age[<TAB>timestamp]
    // opts: { paths, col, tag, staleDays, limit, includePaused, timestamps }
    async active(opts = {}) {
      const config = makeConfig(opts, plugin);
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
      rows = filterSince(rows, opts.since);
      if (opts.limit) rows = rows.slice(0, opts.limit);
      return '\n' + rows.map(r => `${r.col}\t${r.file}:${r.line}\t${r.body}\t${relAge(r.since)}${opts.timestamps ? `\t${r.since || ''}` : ''}${opts.rank ? `\t${r.rank ?? ''}` : ''}${opts.desktop ? `\t${r.desktop ?? ''}` : ''}${fmSuffix(plugin.app, r.file, opts.fm)}`).join('\n');
    },

    // Every configured column and its tasks. The `full` column is unfiltered;
    // other columns only include tasks seen within `hours` (default 24).
    async board(opts = {}) {
      const config = makeConfig(opts, plugin);
      const byCol = await scanKanbanTasks(plugin.app, config);
      const full = String(opts.full || 'Doing').toLowerCase();
      const since = `${Math.max(1, Number(opts.hours) || 24)}h`;
      const lines = [];
      for (const col of config.columns) {
        lines.push(`@column\t${col.name}`);
        let rows = (byCol.get(col.key) || []).map(card => cardJson(card, col));
        if (col.name.toLowerCase() !== full) rows = filterSince(rows, since);
        lines.push(...rows.map(r => `${r.col}\t${r.file}:${r.line}\t${r.body}\t${relAge(r.since)}${opts.timestamps ? `\t${r.since || ''}` : ''}`));
      }
      return '\n' + lines.join('\n');
    },

    async openTask(filePath, line) {
      const file = plugin.app.vault.getAbstractFileByPath(filePath);
      if (!file) throw new Error('file not found: ' + filePath);
      openFileAtLine(plugin.app, file, line, false);
      return `ok opened ${filePath}:${line}`;
    },

    // Freeform notes for one task: every line between the task and the next task
    // line (any indent) or `---` separator, minus the metadata block
    // (tag/color/%%kb%%/%%ei%%).
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
      return '\n' + noteText(lines, line);
    },

    // Replaces a task's prose (what note() returns) with `text`; metadata lines stay.
    async setNote(ref, text) {
      const i = ref.lastIndexOf(':'), path = ref.slice(0, i), line = +ref.slice(i + 1);
      const file = plugin.app.vault.getAbstractFileByPath(path);
      if (!file) throw new Error('no file: ' + path);
      const changed = await editLines(plugin.app, file, lines => {
        if (!TASK_RE.test(lines[line] || '')) throw new Error('not a task: ' + ref);
        return setNoteLines(lines, line, text);
      });
      return `ok ${ref} ${changed === false ? 'unchanged' : 'note set'}`;
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
      for (const [key, list] of byCol) {
        for (const card of list) {
          const ordered = chrono(card.history);
          const ivals = [];
          for (let i = 0; i < ordered.length; i++) {
            if (ordered[i].to.toLowerCase() !== want) continue;
            if (!ordered[i + 1] && key !== want) continue; // ends on entering `want` but is not there now
            const s = stampToDate(ordered[i].stamp).getTime();
            // close at the NEXT move; if none (off-board [x] tick left it open) clamp to end of that day
            const e = ordered[i + 1] ? stampToDate(ordered[i + 1].stamp).getTime() : endOfDayMs(s);
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
    // Lines: HHMM:HHMM[~]<TAB>dur<TAB>body[<TAB>file:line<TAB>first project with opts.refs]
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
        const openEnd = s => (today ? Date.now() : endOfDayMs(s));
        for (const [key, list] of byCol) for (const card of list) {
          for (const x of stints(card.history, want, lo, hi, openEnd, key === want)) {
            const project = (fmVals(plugin.app.metadataCache.getCache(card.file.path)?.frontmatter, 'projects') || [])[0] || '';
            segs.push({ ...x, open: x.open && today, body: cleanText(card.body), ref: `${card.file.path}:${card.line}`, project });
          }
        }
        const tracked = segs.reduce((sum, x) => sum + (x.e - x.s), 0);
        grandTracked += tracked;
        grandElapsed += elapsed;
        const rows = segs.sort((a, b) => a.s - b.s)
          .map(x => `${hhmmBare(x.s)}:${hhmmBare(x.e)}${x.open ? '~' : ''}\t${durCompact(x.e - x.s)}\t${x.body}${opts.refs ? `\t${x.ref}\t${x.project}` : ''}`);
        const footer = `TOTAL\t${dur(tracked)}\t${pct(tracked, elapsed)} elapsed`;
        if (multi) out.push(`== ${dateStr} ==`, ...(rows.length ? rows : ['(none)']), footer);
        else out.push(...rows, footer);
      }
      if (multi) {
        out.push(`== total ==`, `TOTAL\t${dur(grandTracked)}\t${pct(grandTracked, grandElapsed)} elapsed`);
      }
      return '\n' + out.join('\n');
    },

    // 6 Reports input: every card with a Doing stint in the range or a terminal move in the range.
    // opts.mull = mulling threshold in minutes (default 60). Times are epoch seconds.
    // Lines: ref<TAB>title<TAB>orgs<TAB>projects<TAB>desktop<TAB>adhoc 1|0|-<TAB>done|-<TAB>lifetime Doing s<TAB>s-e,s-e
    async reportCards(a, b, c) {
      const { dates, opts } = resolveDates(a, b, c);
      const mk = s => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)).getTime();
      const lo = mk(dates[0]), hi = endOfDayMs(mk(dates[dates.length - 1]));
      const mull = (opts.mull ?? MULL_MS / 60000) * 60000;
      const now = Date.now();
      const openEnd = s => Math.min(now, endOfDayMs(s));
      const config = makeConfig(opts, plugin);
      const done = config.columns.filter(c => c.state);
      const terminal = new Set(done.map(c => c.name.toLowerCase())), terminalKeys = new Set(done.map(c => c.key));
      const byCol = await scanKanbanTasks(plugin.app, config);
      const sec = ms => Math.round(ms / 1000);
      const rows = [];
      for (const [key, list] of byCol) for (const card of list) {
        const inRange = stints(card.history, 'doing', lo, hi, openEnd, key === 'doing');
        const last = chrono(card.history).pop();
        const doneMs = last && terminal.has(last.to.toLowerCase()) && terminalKeys.has(key) ? stampMs(last.stamp) : null;
        const doneIn = doneMs != null && doneMs >= lo && doneMs <= hi;
        if (!inRange.length && !doneIn) continue;
        const life = stints(card.history, 'doing', 0, now, openEnd, key === 'doing').reduce((t, x) => t + x.e - x.s, 0);
        const fm = plugin.app.metadataCache.getCache(card.file.path)?.frontmatter;
        const ah = adhoc(card.history, birthMs(card.file.name), mull);
        rows.push([`${card.file.path}:${card.line}`, cleanText(card.body), (fmVals(fm, 'org') || []).join('|'),
          (fmVals(fm, 'projects') || []).join('|'), card.desktop ?? '', ah == null ? '-' : ah ? '1' : '0',
          doneIn ? String(sec(doneMs)) : '-', String(sec(life)), inRange.map(x => `${sec(x.s)}-${sec(x.e)}`).join(',')].join('\t'));
      }
      return '\n' + rows.join('\n');
    },

    // 5.1 Planned vs unplanned time in a column (default Doing) over a date range.
    // Planned = the card sat in Todo before its first Doing entry. Arg forms mirror getReport.
    // Lines: header with both totals, then planned|unplanned<TAB>dur<TAB>file:line<TAB>body
    async planned(a, b, c) {
      const { dates, opts } = resolveDates(a, b, c);
      const want = String(opts.col || 'Doing').toLowerCase();
      const mk = s => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)).getTime();
      const lo = mk(dates[0]), hi = endOfDayMs(mk(dates[dates.length - 1]));
      const openEnd = s => Math.min(Date.now(), endOfDayMs(s));
      const byCol = await scanKanbanTasks(plugin.app, makeConfig(opts, plugin));
      const rows = [];
      const sum = { planned: 0, unplanned: 0 };
      for (const [key, list] of byCol) for (const card of list) {
        const ms = stints(card.history, want, lo, hi, openEnd, key === want).reduce((t, x) => t + x.e - x.s, 0);
        if (!ms) continue;
        const kind = planned(card.history, birthMs(card.file.name), (opts.mull ?? 60) * 60000) ? 'planned' : 'unplanned';
        sum[kind] += ms;
        rows.push([kind, ms, `${card.file.path}:${card.line}`, cleanText(card.body)]);
      }
      rows.sort((x, y) => y[1] - x[1]);
      const span = dates.length > 1 ? `${dates[0]}..${dates[dates.length - 1]}` : dates[0];
      const total = sum.planned + sum.unplanned;
      return `\n# ${want} time ${span} — planned ${dur(sum.planned)} (${pct(sum.planned, total)}) · unplanned ${dur(sum.unplanned)} (${pct(sum.unplanned, total)})\n`
        + rows.map(([k, ms, ref, body]) => `${k}\t${dur(ms)}\t${ref}\t${body}`).join('\n');
    },

    // 3 One day's captured activity against Doing stints. date YYYYMMDD (default today).
    // Lines: totals, then app<TAB>dur<TAB>top title, longest first.
    async activity(date) {
      return activitySummary(plugin, String(date || ymd(new Date())), makeConfig({}, plugin));
    },

    // Organization/project combinations observed in note properties.
    // Default excludes combinations disabled by the scope registry note.
    async scopes(opts = {}) {
      const rows = await scopeRows(plugin.app, opts);
      return '\n' + rows.map(row => `${row.org}\t${row.project}\t${row.count}\t${row.status}`).join('\n');
    },

    async scopeCatalog() {
      const rows = await scopeRows(plugin.app, { all: true });
      const groups = new Map();
      for (const row of rows) {
        if (!row.org || !row.project) continue;
        if (!groups.has(row.org)) groups.set(row.org, { org: row.org, active: false, projects: [] });
        const group = groups.get(row.org);
        const project = {
          name: row.project,
          active: row.status === 'active',
          count: row.count,
        };
        group.projects.push(project);
        group.active ||= project.active;
      }
      return [...groups.values()].sort((a, b) => a.org.localeCompare(b.org));
    },

    scopeFrontmatterActive(frontmatter) {
      const orgs = fmVals(frontmatter, 'org') || [];
      const projects = fmVals(frontmatter, 'projects') || [];
      if (!orgs.length || !projects.length) return true;
      const rules = scopeRules(plugin.app);
      return orgs.some(org => projects.some(project => !scopeInactive(rules, org, project)));
    },

    async setScopeStatus(opts = {}) {
      return setScopeStatus(plugin.app, opts);
    },

    // Create one task note after validating its active organization/project combination.
    async createTask(opts = {}) {
      const text = String(opts.text || '').replace(/\s+/g, ' ').trim();
      if (!text) throw new Error('text is required');
      const rows = await scopeRows(plugin.app, { all: true, scopeNote: opts.scopeNote });
      const row = rows.find(x => x.org.toLowerCase() === String(opts.org || '').toLowerCase()
        && x.project.toLowerCase() === String(opts.project || '').toLowerCase());
      if (!row) throw new Error(`unknown scope: ${opts.org || '?'} / ${opts.project || '?'}`);
      if (row.status === 'inactive') throw new Error(`inactive scope: ${row.org} / ${row.project}`);
      const config = makeConfig({}, plugin);
      const col = config.columns.find(x => x.name.toLowerCase() === String(opts.col || 'Backlog').toLowerCase());
      if (!col) throw new Error('unknown col: ' + opts.col);
      let at = new Date(), filePath;
      for (let i = 0; i < 60; i++, at = new Date(at.getTime() + 60000)) {
        filePath = `${stampWrite(stampNow(at))}.md`;
        if (!plugin.app.vault.getAbstractFileByPath(filePath)) break;
      }
      if (plugin.app.vault.getAbstractFileByPath(filePath)) throw new Error('no free daily-note timestamp');
      const stamp = stampWrite(stampNow());
      await plugin.app.vault.create(filePath, taskNote({ text, org: row.org, project: row.project, col: col.name, stamp }));
      return `${filePath}\t7\t${row.org}\t${row.project}\t${col.name}\t${text}`;
    },

    // List available methods.
    help() {
      return '\n' + [
        'active(opts?)            live tasks on plate; opts: paths,col,tag,staleDays,limit,timestamps',
        'getDone(date,opts?)      tasks moved to terminal col on a date',
        'note("file:line")        freeform notes under a task (prose to next task or ---)',
        'setNote(ref,text)        replace a task\'s notes; metadata lines stay',
        'columnTimes(opts)        closed seconds per column per card: ref<TAB>Col=sec|Col=sec',
        'getReport(...)           move timeline; day | from,to | {days:N}',
        'chronicle(...)           day chronicle of Doing stints; day | from,to | {days:N}',
        'summary(...)             done counts grouped by fm key; opts: by,col,sample,paths',
        '   note: active/getDone/getReport take opts.fm="projects,org" to append fm cols',
        'plate(project,opts?)     a project\'s live tasks (incl Backlog); opts: prop,col,paths,since,limit',
        'board(opts?)             configured columns + tasks; opts: hours (24), full (Doing), paths, timestamps',
        'openTask(file,line)      open a task at its exact source line',
        'scopes(opts?)            active org/project combinations; opts: all,query,scopeNote',
        'scopeCatalog()           orgs with projects and inherited activity settings',
        'setScopeStatus(opts)     set one organization or organization/project active state',
        'createTask(opts)         create a validated task note; opts: text,org,project,col',
        'moveTask(file,line,col)  move a task to a column',
        'moveTasks(refs,col)      move several file:line refs to a column',
        'rankTasks(pairs,col?)    set manual order [[file:line, rank]], moving into col first',
        'setEstimate(ref,min)    set (minutes) or clear (null) the time guess of a card',
        'estimates(opts?)        cards with a guess: ref, est min, took min (time in opts.col, default Doing)',
        'planned(date|from,to,opts) Doing time split planned (>= opts.mull min, default 60, in Backlog/Todo first) vs ad hoc',
        'addActive([[ref,sec]])   add seconds to each card\'s %% kbactive N %% (active-task time); returns ref<TAB>total',
        'activeTimes(opts?)       cards with active time: ref<TAB>seconds',
        'reportCards(from,to,opts) Reports input: cards with Doing stints or done in range; opts.mull minutes',
        'activity(date?)          captured Mac activity vs Doing stints for one day (.activity/YYYYMMDD.jsonl)',
        'moveTasks(refs,col,{at}) at=ISO backdates the move; cards that moved later are skipped',
        'parkAll(at)              park every Doing card (habits to Idle) stamped at ISO at; returns ok <moved>',
        'setDesktop(ref,d)        set (1-9 or a desktop name) or clear (null) the macOS desktop of a card; active({desktop:true}) lists it',
        'sweep(from,to,refs?)     bulk-move a column (refs = file:line list)',
        'sweeps()                 sweep routes from settings: From<TAB>To',
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
      let rows = (await this.active({
        col: opts.col,
        includePaused: true,
        limit: opts.limit,
        since: opts.since,
      })).split('\n').filter(Boolean);
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
      const config = makeConfig({}, plugin);
      const col = config.columns.find(c => c.name.toLowerCase() === String(toCol).toLowerCase());
      if (!col) throw new Error('unknown col: ' + toCol);
      await moveCard(plugin.app, file, line, col, config, {});
      return `ok ${filePath}:${line} -> ${col.name}`;
    },

    // Move several "file:line" refs to one column. Same-file refs go bottom-up so
    // each inserted history line cannot shift a ref still to move. Returns "ok <moved>".
    // opts.at (ISO time) backdates the stamp; a card that moved after `at` is skipped.
    async moveTasks(refs, toCol, opts = {}) {
      const config = makeConfig({}, plugin);
      const col = config.columns.find(c => c.name.toLowerCase() === String(toCol).toLowerCase());
      if (!col) throw new Error('unknown col: ' + toCol);
      const parsed = refs.map(r => { const i = r.lastIndexOf(':'); return { path: r.slice(0, i), line: +r.slice(i + 1) }; })
        .sort((a, b) => a.path === b.path ? b.line - a.line : a.path.localeCompare(b.path));
      const at = opts.at ? new Date(opts.at) : null;
      if (at && Number.isNaN(at.getTime())) throw new Error('bad at: ' + opts.at);
      let moved = 0;
      for (const { path, line } of parsed) {
        const file = plugin.app.vault.getAbstractFileByPath(path);
        if (!file) continue;
        if (at && !backdateOk(at.getTime(), await cardHistory(plugin.app, file, line))) continue;
        if (await moveCard(plugin.app, file, line, col, config, { at })) moved++;
      }
      return `ok ${moved}`;
    },

    // Sleep park (sleep.js 1.2) on demand: Kanban Board calls it on wake with the sleep moment.
    async parkAll(at) {
      const when = new Date(at);
      if (Number.isNaN(when.getTime())) throw new Error('bad at: ' + at);
      return `ok ${await parkAll(plugin, when, () => makeConfig({}, plugin))}`;
    },

    // Manual order: [[ref, rank], ...]. With toCol, cards not already there move first.
    // Same-file refs go bottom-up (each edit only inserts below its task). Returns "ok <n>".
    async rankTasks(pairs, toCol) {
      const config = makeConfig({}, plugin);
      const col = toCol == null ? null : config.columns.find(c => c.name.toLowerCase() === String(toCol).toLowerCase());
      if (toCol != null && !col) throw new Error('unknown col: ' + toCol);
      const parsed = pairs.map(([r, rank]) => { const i = r.lastIndexOf(':'); return { path: r.slice(0, i), line: +r.slice(i + 1), rank: Number(rank) }; })
        .filter(p => Number.isFinite(p.rank))
        .sort((a, b) => a.path === b.path ? b.line - a.line : a.path.localeCompare(b.path));
      let n = 0;
      for (const p of parsed) {
        const file = plugin.app.vault.getAbstractFileByPath(p.path);
        if (!file) continue;
        if (col) {
          const lines = (await plugin.app.vault.read(file)).split(/\r?\n/);
          const m = lines[p.line]?.match(TASK_RE);
          if (m && taskColumn(lines, p.line, m, config)?.key !== col.key) await moveCard(plugin.app, file, p.line, col, config, {});
        }
        const ok = await editLines(plugin.app, file, lines => {
          if (!TASK_RE.test(lines[p.line] || '')) return false;
          setRankLine(lines, p.line, p.rank);
        });
        if (ok !== false) n++;
      }
      return `ok ${n}`;
    },

    // A card's macOS desktop: `%% kbdesktop <ref> %%` under the task. ref = 1-9 or a desktop
    // name from the Kanban Board label store; null clears.
    async setDesktop(ref, value) {
      const i = ref.lastIndexOf(':'), path = ref.slice(0, i), line = +ref.slice(i + 1);
      const desk = desktopRef(value);
      if (value != null && desk == null) throw new Error('desktop must be 1-9, a name without % or newlines, or null');
      const file = plugin.app.vault.getAbstractFileByPath(path);
      if (!file) throw new Error('no file: ' + path);
      await editLines(plugin.app, file, lines => {
        if (!TASK_RE.test(lines[line] || '')) throw new Error('not a task: ' + ref);
        setDesktopLine(lines, line, desk);
      });
      return `ok ${ref} desktop ${desk ?? 'none'}`;
    },

    // A card's time guess in minutes: `%% kbest N %%` under the task. null clears.
    async setEstimate(ref, minutes) {
      const i = ref.lastIndexOf(':'), path = ref.slice(0, i), line = +ref.slice(i + 1);
      const num = minutes == null ? null : Math.round(Number(minutes));
      if (num != null && !(num >= 1)) throw new Error('estimate must be minutes >= 1 or null');
      const file = plugin.app.vault.getAbstractFileByPath(path);
      if (!file) throw new Error('no file: ' + path);
      await editLines(plugin.app, file, lines => {
        if (!TASK_RE.test(lines[line] || '')) throw new Error('not a task: ' + ref);
        setEstLine(lines, line, num);
      });
      return `ok ${ref} est ${num ?? 'none'}`;
    },

    // Active time: seconds a card was the one active task (Kanban Board app, by desktop).
    // items = [[ref, seconds], ...]; one read and write per file, bottom-up so refs stay valid.
    // Returns "ref<TAB>total" per written card.
    async addActive(items) {
      const byFile = new Map();
      for (const [ref, sec] of items || []) {
        const n = Math.round(Number(sec));
        if (!(n > 0)) continue;
        const i = ref.lastIndexOf(':');
        const list = byFile.get(ref.slice(0, i)) || [];
        list.push([+ref.slice(i + 1), n, ref]);
        byFile.set(ref.slice(0, i), list);
      }
      const out = [];
      for (const [path, list] of byFile) {
        const file = plugin.app.vault.getAbstractFileByPath(path);
        if (!file) throw new Error('no file: ' + path);
        await editLines(plugin.app, file, lines => {
          for (const [line, n, ref] of list.sort((a, b) => b[0] - a[0])) {
            if (!TASK_RE.test(lines[line] || '')) throw new Error('not a task: ' + ref);
            out.push(`${ref}\t${addActiveLine(lines, line, n)}`);
          }
        });
      }
      return '\n' + out.join('\n');
    },

    // Cards with active time: "file:line<TAB>seconds".
    async activeTimes(opts = {}) {
      const byCol = await scanKanbanTasks(plugin.app, makeConfig(opts, plugin));
      const out = [];
      for (const [, list] of byCol) for (const card of list) {
        if (card.activeSec != null) out.push(`${card.file.path}:${card.line}\t${card.activeSec}`);
      }
      return '\n' + out.join('\n');
    },

    // One task by its Kanban Board ID ("HTP-261008-1106.01"): the note named by the stamp, the
    // ordinal-th checkbox task in it. Tab fields: id, ref, col, body, age, orgs, projects, desktop,
    // estMinutes, activeSeconds, columnSeconds (Doing=1800|Todo=600, closed stints).
    async task(id) {
      const p = parseTaskId(id);
      if (!p) throw new Error('bad task id: ' + id + ' (want KEY-yymmdd-HHmm[.NN], e.g. HTP-261008-1106.01)');
      const file = plugin.app.vault.getMarkdownFiles().find(f => f.basename === p.base || f.basename.startsWith(p.base + '.'));
      if (!file) throw new Error('no note ' + p.base + '.md for ' + id);
      const tasks = (plugin.app.metadataCache.getFileCache(file)?.listItems || []).filter(i => i.task !== undefined);
      const item = tasks[p.ordinal - 1];
      if (!item) throw new Error(`${file.path} has ${tasks.length} task(s), no #${p.ordinal}`);
      const line = item.position.start.line;
      const config = makeConfig({}, plugin);
      const byCol = await scanKanbanTasks(plugin.app, config);
      let r = null, found = null;
      for (const col of config.columns) for (const card of byCol.get(col.key) || []) {
        if (card.file.path === file.path && card.line === line) { found = card; r = cardJson(card, col); }
      }
      if (!found) return `\n${id}\t${file.path}:${line}\t\t(not on the board)`;
      const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter || {};
      const list = k => [].concat(fm[k] ?? []).map(v => String(v).replace(/^\[\[|\]\]$/g, '').split('|')[0]).join('|');
      const times = Object.entries(columnSeconds(found.history)).map(([c, sec]) => `${c}=${Math.round(sec)}`).join('|');
      return '\n' + [id, `${file.path}:${line}`, r.col, cleanText(r.body), relAge(r.since),
        list('org'), list('projects'), r.desktop ?? '', found.est ?? '', found.activeSec ?? '', times].join('\t');
    },

    // Closed time per column for every card: "file:line<TAB>Doing=1800|Todo=600" (seconds).
    // The open stint (current column since its last move) is left to the caller.
    async columnTimes(opts = {}) {
      const byCol = await scanKanbanTasks(plugin.app, makeConfig(opts, plugin));
      const out = [];
      for (const [, list] of byCol) for (const card of list) {
        const t = Object.entries(columnSeconds(card.history)).map(([c, sec]) => `${c}=${Math.round(sec)}`);
        if (t.length) out.push(`${card.file.path}:${card.line}\t${t.join('|')}`);
      }
      return '\n' + out.join('\n');
    },

    // Cards with a guess: "file:line<TAB>estMinutes<TAB>tookMinutes", took = summed time in `col` (default Doing).
    async estimates(opts = {}) {
      const want = String(opts.col || 'Doing').toLowerCase();
      const byCol = await scanKanbanTasks(plugin.app, makeConfig(opts, plugin));
      const out = [];
      for (const [key, list] of byCol) for (const card of list) {
        if (card.est == null) continue;
        const ev = chrono(card.history);
        let ms = 0;
        ev.forEach((e, i) => {
          if (e.to.toLowerCase() !== want) return;
          if (!ev[i + 1] && key !== want) return; // not in `want` now: no open stint
          ms += (ev[i + 1] ? stampToDate(ev[i + 1].stamp).getTime() : Date.now()) - stampToDate(e.stamp).getTime();
        });
        out.push(`${card.file.path}:${card.line}\t${card.est}\t${Math.round(ms / 60000)}`);
      }
      return '\n' + out.join('\n');
    },

    // Bulk-move a column, as the board's sweep button does. refs ("file:line")
    // limits it to those cards. Returns "ok <moved> <blocked>".
    async sweep(fromCol, toCol, refs) {
      const config = makeConfig({}, plugin);
      const find = n => config.columns.find(c => c.name.toLowerCase() === String(n).toLowerCase());
      const from = find(fromCol), to = find(toCol);
      if (!from || !to) throw new Error('unknown col: ' + (from ? toCol : fromCol));
      const byCol = await scanKanbanTasks(plugin.app, config);
      let cards = byCol.get(from.key) || [];
      if (refs) { const keep = new Set(refs); cards = cards.filter(c => keep.has(`${c.file.path}:${c.line}`)); }
      const { moved, blocked } = await sweepColumn(plugin.app, config, from, to, cards);
      return `ok ${moved} ${blocked}`;
    },

    // Sweep routes from settings, one "From<TAB>To" line each (names as typed).
    sweeps() {
      return '\n' + String(plugin.settings?.kanban?.sweep || '').split(/[,\n]/)
        .map(r => r.split('>').map(s => s.trim())).filter(([f, t]) => f && t)
        .map(([f, t]) => `${f}\t${t}`).join('\n');
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

module.exports = { buildApi, makeConfig, fileNameStamp, filterSince, scopeInactive, taskNote, parseTaskId };
