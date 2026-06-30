// Habits heatmap block. Reuses the kanban scan: each habit card cycles
// Idle <-> Doing; a span = (Idle>Doing , Doing>Idle) pair. The block reads
// spans, buckets them by end-date, and renders a year grid per habit.
const { parseKanbanConfig, scanKanbanTasks, stampToDate, cleanText, moveCard, logTapSpan, addTitleCopy } = require('./kanban');
const { MarkdownRenderChild, setIcon } = require('obsidian');
const { openFileAtLine } = require('./core/render');

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
  const cards = await scanKanbanTasks(app, config, {
    cacheFilter: (cache) => cache?.frontmatter?.metric != null,
  });
  const all = [].concat(...cards.values());
  // A habit is a card whose file declares a `metric`; identity is the task body
  // (one file may hold several habits, e.g. Reddit + Youtube).
  return all
    .map(card => {
      const fm = app.metadataCache.getFileCache(card.file).frontmatter;
      const metric = (card.metric || fm.metric) === 'count' ? 'count' : 'sum';   // inline %% kbmetric %% beats fm
      return {
        name: cleanText(card.body),
        metric,
        color: card.color || fm.kbcolor || null,
        days: bucketByDay(card.history, metric, year),
      };
    });
}

// --- render ---------------------------------------------------------------

// Hours (float) -> "8h9m" / "8h" / "9m". Used everywhere a sum-metric shows.
function fmtHours(h) {
  const min = Math.round((h || 0) * 60);
  const hh = Math.floor(min / 60), mm = min % 60;
  if (hh && mm) return `${hh}h${mm}m`;
  return hh ? `${hh}h` : `${mm}m`;
}

function fmtVal(v, metric) {
  if (metric === 'count') return `${v}x`;
  return fmtHours(v);
}

function showPadBubble(text, x, y) {
  let el = document.querySelector('.bdb-report-drag-bubble');
  if (!el) {
    el = document.createElement('div');
    el.className = 'bdb-report-drag-bubble';
    document.body.appendChild(el);
  }
  el.textContent = text;
  const pad = 12;
  const width = el.offsetWidth || 0;
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const clamped = Math.max(pad + width / 2, Math.min(vw - pad - width / 2, x));
  const anchor = width ? ((x - (clamped - width / 2)) / width) * 100 : 50;
  el.style.left = `${clamped}px`;
  el.style.top = `${y}px`;
  el.style.setProperty('--bdb-bubble-anchor', `${Math.max(10, Math.min(90, anchor))}%`);
  el.classList.add('is-visible');
}

function hidePadBubble() {
  document.querySelector('.bdb-report-drag-bubble')?.classList.remove('is-visible');
}

function renderPadIcon(parent, icon, color) {
  const box = parent.createDiv({ cls: 'bdb-pad-icon', attr: { 'aria-hidden': 'true' } });
  const match = String(icon || '').match(/^([a-z0-9]+(?:-[a-z0-9]+)*):([a-z0-9]+(?:-[a-z0-9]+)*)$/i);
  if (!match) { setIcon(box, 'activity'); return; }
  const src = `https://api.iconify.design/${match[1]}/${match[2]}.svg?color=${encodeURIComponent(color || '#8b949e')}`;
  const img = box.createEl('img', { attr: { src, alt: '', loading: 'lazy', decoding: 'async' } });
  img.addEventListener('error', () => { img.remove(); setIcon(box, 'activity'); }, { once: true });
}

function renderPadTitle(parent, text) {
  const nameEl = parent.createDiv({ cls: 'bdb-pad-name' });
  const track = nameEl.createDiv({ cls: 'bdb-pad-name-track' });
  const first = track.createSpan({ cls: 'bdb-pad-name-copy', text });
  window.requestAnimationFrame(() => {
    const overflow = first.scrollWidth - nameEl.clientWidth;
    if (overflow <= 8) return;
    const gap = 56;
    track.createSpan({ cls: 'bdb-pad-name-copy bdb-pad-name-copy-ghost', text });
    nameEl.addClass('is-ticker');
    nameEl.style.setProperty('--bdb-ticker-gap', `${gap}px`);
    nameEl.style.setProperty('--bdb-ticker-shift', `${first.scrollWidth + gap}px`);
    nameEl.style.setProperty('--bdb-ticker-duration', `${Math.max(7, Math.round((first.scrollWidth + gap) / 18))}s`);
  });
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
  const nameEl = head.createDiv({ cls: 'bdb-habit-name', text: habit.name });
  addTitleCopy(nameEl, habit.name);
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
  const loggedDays = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const latest = loggedDays[loggedDays.length - 1] || null;
  const latestPrev = loggedDays.length > 1 ? loggedDays[loggedDays.length - 2] : null;
  const dayVal = (offset) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return byDay.get(k) || 0;
  };
  const yesterdayVal = dayVal(1);
  const prevVal = dayVal(2);
  const prev2Val = dayVal(3);

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
  const avg3 = lastN(3);
  const avg7 = lastN(7);
  const avg30 = lastN(30);
  const _closedActive = [];
  for (let i = 1; _closedActive.length < 3 && i <= 90; i++) {
    const v = dayVal(i);
    if (v > 0) _closedActive.push(v);
  }
  const avg3Closed = _closedActive.length > 0
    ? _closedActive.reduce((a, b) => a + b, 0) / _closedActive.length
    : 0;
  const spark7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    spark7.push(byDay.get(k) || 0);
  }

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
    metric, open, today: todayVal, avg3, avg3Closed, avg7, streak, spark7,
    latestDay: latest?.[0] || null, latestVal: latest?.[1] || 0,
    latestPrevDay: latestPrev?.[0] || null, latestPrevVal: latestPrev?.[1] || 0,
    yesterday: yesterdayVal, prevDay: prevVal,
    min: Math.min(...vals), max: Math.max(...vals),
    mean: vals.reduce((a, b) => a + b, 0) / vals.length,
    days: byDay.size, trend,
    deltaLatest: (latest?.[1] || 0) - (latestPrev?.[1] || 0),
    deltaMu3: (latest?.[1] || 0) - avg3Closed,
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
    const cardsByCol = await scanKanbanTasks(plugin.app, config, {
      cacheFilter: (cache) => cache?.frontmatter?.metric != null,
    });
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
      const metric = (card.metric || fm.metric) === 'count' ? 'count' : 'sum';   // inline %% kbmetric %% beats fm
      const tap = card.tap === true || fm.tap === true || fm.tap === 'true';      // inline %% kbtap %% or fm.tap
      const doing = !tap && colKey === liveCol?.key;       // tap habits never sit in Doing
      const st = habitStats(card.history, metric, now);
      const color = card.color || fm.kbcolor || null;
      const btn = grid.createDiv({ cls: 'bdb-pad-card' + (doing ? ' bdb-pad-on' : '') });
      if (color) btn.style.setProperty('--kb-card-color', color);
      const head = btn.createDiv({ cls: 'bdb-pad-head' });
      renderPadIcon(head, card.icon || fm.icon, doing ? '#ffffff' : color);
      renderPadTitle(head, cleanText(card.body));
      const openBtn = head.createSpan({ cls: 'bdb-pad-open', attr: { 'aria-label': 'Open habit note' } });
      setIcon(openBtn, 'external-link');

      let sub = [];
      if (doing) {
        const sp = spans(card.history);
        const open = sp[sp.length - 1];
        const elapsed = open && open.end === null ? (now - open.start) / 3600000 : 0;
        sub = [{ text: `▶ ${fmtHours(elapsed)}` }, { text: 'live now' }];          // running time
      } else {
        if (st) {
          const f = (v) => metric === 'count' ? `${Number(v.toFixed(1)).toString()}x` : fmtHours(v);
          const trendCls = st.deltaLatest > 0.05 ? 'up' : st.deltaLatest < -0.05 ? 'down' : 'flat';
          const muCls = st.deltaMu3 > 0.05 ? 'up' : st.deltaMu3 < -0.05 ? 'down' : 'flat';
          const arrow = trendCls === 'up' ? '↑' : trendCls === 'down' ? '↓' : '→';
          const muArrow = muCls === 'up' ? '↑' : muCls === 'down' ? '↓' : '→';
          sub = [
            { text: `${st.streak}d · ${f(st.today)}` },
            {
              chunks: [
                { text: `last ${f(st.latestVal)} ` },
                { trend: { text: arrow, cls: trendCls } },
              ],
            },
            {
              chunks: [
                { text: `μ3 ${f(st.avg3Closed)} ` },
                { trend: { text: muArrow, cls: muCls } },
              ],
            }
          ];
        } else sub = [{ text: tap ? 'tap to log' : 'tap to start' }];
      }
      const subEl = btn.createDiv({ cls: 'bdb-pad-sub' });
      for (const line of sub) {
        const lineEl = subEl.createDiv({ cls: 'bdb-pad-subline' });
        if (line.chunks) {
          for (const chunk of line.chunks) {
            if (chunk.text) lineEl.appendText(chunk.text);
            if (chunk.trend) lineEl.createSpan({ cls: `bdb-pad-trend bdb-pad-trend-${chunk.trend.cls}`, text: chunk.trend.text });
          }
        } else {
          lineEl.appendText(line.text);
          if (line.trend) lineEl.createSpan({ cls: `bdb-pad-trend bdb-pad-trend-${line.trend.cls}`, text: line.trend.text });
        }
      }
      if (st?.spark7?.some(v => v > 0)) {
        const sparkEl = btn.createDiv({ cls: 'bdb-pad-spark', attr: { 'aria-label': 'Last 7 days activity' } });
        const sparkMax = Math.max(1, ...st.spark7);
        for (let i = 0; i < st.spark7.length; i++) {
          const v = st.spark7[i];
          const bar = sparkEl.createDiv({ cls: 'bdb-pad-spark-bar' + (!v ? ' is-zero' : '') });
          bar.style.setProperty('--bdb-bar-h', `${Math.max(2, Math.round((v / sparkMax) * 18))}px`);
          const day = `${i === st.spark7.length - 1 ? 'today' : `${st.spark7.length - 1 - i}d ago`}: ${fmtVal(v, metric)}`;
          const label = v ? day : `${day} (none)`;
          bar.setAttribute('aria-label', label);
          bar.addEventListener('pointerenter', (e) => showPadBubble(label, e.clientX, e.clientY - 14));
          bar.addEventListener('pointermove', (e) => showPadBubble(label, e.clientX, e.clientY - 14));
          bar.addEventListener('pointerleave', hidePadBubble);
        }
      }

      openBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openFileAtLine(plugin.app, card.file, card.line, e.ctrlKey || e.metaKey);
      });

      btn.addEventListener('click', async (e) => {
        const cur = config.columns.find(c => c.key === colKey);
        if (tap) {                                          // one click = one closed span, single write
          await logTapSpan(plugin.app, card.file, card.line);
          showPadBubble('+1', e.clientX, e.clientY - 14);
          window.setTimeout(hidePadBubble, 800);
          await draw();
          return;
        }
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
