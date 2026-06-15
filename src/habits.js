// Habits heatmap block. Reuses the kanban scan: each habit card cycles
// Idle <-> Doing; a span = (Idle>Doing , Doing>Idle) pair. The block reads
// spans, buckets them by end-date, and renders a year grid per habit.
const { parseKanbanConfig, scanKanbanTasks, stampToDate, cleanText, moveCard } = require('./kanban');
const { MarkdownRenderChild } = require('obsidian');

const HABIT_COLS = 'columns: Idle~, Doing!';

// Walk a card's move history, pairing each Idle>Doing with the next Doing>Idle.
// Returns [{start, end, ms}] in chronological order. An unclosed final Doing
// (you're mid-habit now) is returned with end=null.
function spans(history) {
  const h = history.slice().sort((a, b) => a.stamp.localeCompare(b.stamp));
  const out = [];
  let start = null;
  for (const m of h) {
    if (m.to === 'Doing') start = stampToDate(m.stamp);
    else if (m.from === 'Doing' && start) {
      const end = stampToDate(m.stamp);
      out.push({ start, end, ms: end - start });
      start = null;
    }
  }
  if (start) out.push({ start, end: null, ms: null });
  return out;
}

// Bucket spans by their END date (wake day owns a midnight-crossing sleep).
// metric 'sum' -> total hours that day; 'count' -> #sessions. Returns
// Map 'YYYY-MM-DD' -> { value, sessions, open } for the given year.
function bucketByDay(history, metric, year) {
  const days = new Map();
  for (const s of spans(history)) {
    const d = s.end || s.start;             // open span buckets on its start day
    if (d.getFullYear() !== year) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const cur = days.get(key) || { value: 0, sessions: 0, open: false };
    cur.sessions += 1;
    if (s.end === null) cur.open = true;
    else cur.value += metric === 'count' ? 1 : s.ms / 3600000;  // hours
    days.set(key, cur);
  }
  return days;
}

// Gather every habit card under the block's paths, with its per-file config.
async function collectHabits(app, paths, year) {
  const config = parseKanbanConfig(`${HABIT_COLS}\npaths: ${paths.join(', ')}`);
  const cards = await scanKanbanTasks(app, config);
  const all = [].concat(...cards.values());
  // A habit is a card whose file declares a `metric`; identity is the task body
  // (one file may hold several habits, e.g. Reddit + Youtube).
  return all
    .filter(card => app.metadataCache.getFileCache(card.file)?.frontmatter?.metric != null)
    .map(card => {
      const fm = app.metadataCache.getFileCache(card.file).frontmatter;
      const metric = (fm.metric === 'count') ? 'count' : 'sum';
      return {
        name: cleanText(card.body),
        metric,
        color: card.color || fm.kbcolor || null,
        days: bucketByDay(card.history, metric, year),
      };
    });
}

// --- render ---------------------------------------------------------------

// Hours (float) -> "8h 9m" / "8h" / "9m". Used everywhere a sum-metric shows.
function fmtHours(h) {
  const min = Math.round((h || 0) * 60);
  const hh = Math.floor(min / 60), mm = min % 60;
  if (hh && mm) return `${hh}h ${mm}m`;
  return hh ? `${hh}h` : `${mm}m`;
}

function fmtVal(v, metric) {
  if (metric === 'count') return `${v}x`;
  return fmtHours(v);
}

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// One habit = a label + a GitHub-style year grid (7 rows = weekdays,
// columns = weeks). Intensity is auto-scaled to the habit's own max.
function renderHabitRow(parent, habit, year, today) {
  const row = parent.createDiv({ cls: 'bdb-habit-row' });
  if (habit.color) row.style.setProperty('--kb-habit-color', habit.color);
  const head = row.createDiv({ cls: 'bdb-habit-head' });
  head.createDiv({ cls: 'bdb-habit-name', text: habit.name });
  const max = Math.max(0, ...[...habit.days.values()].map(d => d.value));
  const total = [...habit.days.values()].reduce((a, d) => a + d.value, 0);
  const active = [...habit.days.values()].filter(d => d.value > 0 || d.open).length;
  head.createDiv({ cls: 'bdb-habit-stat',
    text: `${active}d · ${fmtVal(total, habit.metric)} total` });

  const grid = row.createDiv({ cls: 'bdb-habit-grid' });
  const jan1 = new Date(year, 0, 1);
  const startDow = (jan1.getDay() + 6) % 7;            // Mon=0
  let lastMonth = -1;
  for (let i = 0; i < 366; i++) {
    const d = new Date(year, 0, 1 + i);
    if (d.getFullYear() !== year) break;
    const col = Math.floor((startDow + i) / 7) + 1;    // grid col (1-based), row 1 = month labels
    const dow = (d.getDay() + 6) % 7;
    if (d.getMonth() !== lastMonth) {                   // month label on first week it appears
      lastMonth = d.getMonth();
      const lbl = grid.createDiv({ cls: 'bdb-habit-month', text: MONTHS[d.getMonth()] });
      lbl.style.gridColumn = `${col}`;
      lbl.style.gridRow = '1';
    }
    const cell = grid.createDiv({ cls: 'bdb-habit-cell' });
    cell.style.gridColumn = `${col}`;
    cell.style.gridRow = `${dow + 2}`;                  // +2: row 1 reserved for months
    const info = habit.days.get(dayKey(d));
    const future = d > today;
    if (info?.open) {
      cell.addClass('bdb-h-open');
      cell.setAttribute('aria-label', `${dayKey(d)}: in progress`);
    } else if (info && info.value > 0) {
      const lvl = max ? Math.min(4, Math.ceil((info.value / max) * 4)) : 0;
      cell.addClass(`bdb-h${lvl}`);
      cell.setAttribute('aria-label', `${dayKey(d)}: ${fmtVal(info.value, habit.metric)}`);
    } else if (future) {
      cell.addClass('bdb-h-future');
    } else {
      cell.addClass('bdb-h-empty');                    // past, no log = empty (no guilt-red)
      cell.setAttribute('aria-label', `${dayKey(d)}: —`);
    }
  }
}

async function renderHabitsBlock(plugin, source, el, ctx) {
  const lines = (source || '').split(/\r?\n/);
  let paths = [], year = null;
  for (const line of lines) {
    const m = line.match(/^(paths|year)\s*:\s*(.*)$/);
    if (!m) continue;
    if (m[1] === 'paths') paths = m[2].split(',').map(s => s.trim()).filter(Boolean);
    else year = parseInt(m[2].replace(/[^0-9]/g, ''), 10) || null;
  }
  if (!paths.length) paths = [ctx.sourcePath];          // default: this file only
  const now = new Date();
  if (!year) year = now.getFullYear();

  const habits = await collectHabits(plugin.app, paths, year);
  const wrap = el.createDiv({ cls: 'bdb-habits' });
  wrap.createDiv({ cls: 'bdb-habits-title', text: `Habits ${year}` });
  if (!habits.length) { wrap.createDiv({ text: `no habit cards under ${paths.join(', ')}` }); return; }
  for (const h of habits.sort((a, b) => a.name.localeCompare(b.name))) {
    renderHabitRow(wrap, h, year, now);
  }
}

// Per-card habit stats from move history, for the kanban habit footer.
// Returns null if there's nothing logged. metric 'sum' = hours/day, 'count' = sessions/day.
function habitStats(history, metric, now) {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const byDay = new Map();          // day -> value
  let open = false;
  for (const s of spans(history)) {
    const d = s.end || s.start;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (s.end === null) { open = true; continue; }
    const v = metric === 'count' ? 1 : s.ms / 3600000;
    byDay.set(key, (byDay.get(key) || 0) + v);
  }
  if (!byDay.size && !open) return null;

  const vals = [...byDay.values()];
  const todayVal = byDay.get(today) || 0;

  // 7-day average over the trailing 7 calendar days (incl today).
  const lastN = (n) => {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      sum += byDay.get(k) || 0;
    }
    return sum / n;
  };
  const avg7 = lastN(7);
  const avg30 = lastN(30);

  // Streak: consecutive days back from today (or yesterday) with a logged value.
  let streak = 0;
  for (let i = 0; i < 366; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (byDay.get(k)) streak++;
    else if (i > 0) break;          // today not-yet-done doesn't break a prior streak
  }

  // Trend: 7d vs 30d average. up if recent beats baseline.
  const trend = avg30 === 0 ? 0 : (avg7 - avg30) / avg30;
  return {
    metric, open, today: todayVal, avg7, streak,
    min: Math.min(...vals), max: Math.max(...vals),
    mean: vals.reduce((a, b) => a + b, 0) / vals.length,
    days: byDay.size, trend,
  };
}

// --- habit-pad: grid of clickable stopwatch buttons --------------------------

// One push toggles a habit Idle<->Doing. A card "on" (in Doing) sits depressed
// and glows; its sub-line runs a live timer. Re-renders on click + each minute.
async function renderHabitPad(plugin, source, el, ctx) {
  const child = new MarkdownRenderChild(el);
  ctx.addChild(child);
  // Same config language as the kanban block: paths, filter, columns, colors…
  // Columns default to the two-state habit board; paths default to this note.
  const config = parseKanbanConfig(source || '');
  if (!config.columns.length) config.columns = parseKanbanConfig(HABIT_COLS).columns;
  if (!config.paths.length) config.paths = [ctx.sourcePath];
  const liveCol = config.columns.find(c => c.live) || config.columns.find(c => !c.state && !c.paused);
  const idleCol = config.columns.find(c => !c.state && c.paused) || config.columns.find(c => !c.state);

  const draw = async () => {
    el.empty();
    const cardsByCol = await scanKanbanTasks(plugin.app, config);
    const now = new Date();
    const items = [];
    for (const [colKey, list] of cardsByCol) {
      for (const card of list) {
        const fm = plugin.app.metadataCache.getFileCache(card.file)?.frontmatter || {};
        if (fm.metric == null) continue;            // habit = file declares metric
        items.push({ card, colKey, fm });
      }
    }
    items.sort((a, b) => cleanText(a.card.body).localeCompare(cleanText(b.card.body)));

    const grid = el.createDiv({ cls: 'bdb-pad' });
    for (const { card, colKey, fm } of items) {
      const metric = fm.metric === 'count' ? 'count' : 'sum';
      const doing = colKey === liveCol?.key;
      const color = card.color || fm.kbcolor || null;
      const btn = grid.createDiv({ cls: 'bdb-pad-card' + (doing ? ' bdb-pad-on' : '') });
      if (color) btn.style.setProperty('--kb-card-color', color);
      btn.createDiv({ cls: 'bdb-pad-name', text: cleanText(card.body) });

      let sub;
      if (doing) {
        const sp = spans(card.history);
        const open = sp[sp.length - 1];
        const elapsed = open && open.end === null ? (now - open.start) / 3600000 : 0;
        sub = `▶ ${fmtHours(elapsed)}`;          // ▶ running time
      } else {
        const st = habitStats(card.history, metric, now);
        sub = st ? `${st.streak}d · ${metric === 'count' ? st.today + 'x' : fmtHours(st.today)}` : 'tap to start';
      }
      btn.createDiv({ cls: 'bdb-pad-sub', text: sub });

      btn.addEventListener('click', async () => {
        const cur = config.columns.find(c => c.key === colKey);
        const target = doing ? idleCol : liveCol;          // stop -> Idle / start -> Doing
        if (!target) return;
        await moveCard(plugin.app, card.file, card.line, target, config, { fromCol: cur });
        await draw();
      });
    }
    if (!items.length) grid.createDiv({ text: `no habit cards under ${paths.join(', ')}` });
  };

  child.registerInterval(window.setInterval(draw, 60000));
  await draw();
}

module.exports = { spans, bucketByDay, collectHabits, renderHabitsBlock, habitStats, fmtHours, renderHabitPad };
