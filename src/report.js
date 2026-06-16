// report fence — daily task Gantt chart
const { TASK_RE, STAMP_RE, stampToDate, parseKanbanConfig, fmtDur, addTitleCopy } = require('./kanban');
const { openFileAtLine } = require('./core/render');
const { MarkdownRenderChild, Modal, Notice } = require('obsidian');

const HIST_RE = /^\s*%%\s?kb (\d{12}) (.+?) > (.+?)\s?%%\s*$/;
const COLOR_RE = /^\s*%%\s?kbcolor (#[0-9a-fA-F]{3,8}|[a-zA-Z]+)\s?%%\s*$/;
const COL_PALETTE = {
  backlog: '#8a8f98', todo: '#d29922', doing: '#2d7ff9',
  parked: '#8d7ee7', review: '#b180d7', done: '#2ea043', cancelled: '#e93147',
};
const COL_CYCLE = ['#2d7ff9', '#d29922', '#b180d7', '#2ea043', '#e93147', '#8a8f98'];
const _colCache = {};
let _cycleIdx = 0;
function colColor(name) {
  const k = (name || '').toLowerCase().replace(/\s+/g, '-');
  if (_colCache[k]) return _colCache[k];
  return (_colCache[k] = COL_PALETTE[k] || COL_CYCLE[(_cycleIdx++) % COL_CYCLE.length]);
}

function indentWidth(text) {
  let w = 0;
  for (const ch of text.match(/^\s*/)[0]) w += ch === '\t' ? 4 : 1;
  return w;
}

function fmtClock(d) {
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

async function collectReportData(app, dateStr, paths, isActive) {
  const tasks = [], standing = [];
  const files = app.vault.getMarkdownFiles().filter(f => {
    if (paths.length && !paths.some(p => f.path.startsWith(p))) return false;
    return !!app.metadataCache.getFileCache(f)?.listItems?.some(it => it.task != null);
  });
  for (const file of files) {
    const lines = (await app.vault.cachedRead(file)).split(/\r?\n/);
    const stack = [], cards = [];
    for (let li = 0; li < lines.length; li++) {
      const text = lines[li];
      const tm = text.match(TASK_RE);
      if (tm) {
        const indent = indentWidth(text);
        while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
        const card = { body: tm[4].replace(STAMP_RE, '').trim(), history: [], indent, file, line: li, color: null };
        stack.push({ indent, card }); cards.push(card); continue;
      }
      const hm = text.match(HIST_RE);
      if (hm) {
        const hi = indentWidth(text);
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].indent < hi) { stack[i].card.history.push({ stamp: hm[1], from: hm[2], to: hm[3], line: li }); break; }
        }
        continue;
      }
      const cm = text.match(COLOR_RE);
      if (cm) {
        const ci = indentWidth(text);
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].indent < ci) { stack[i].card.color = cm[1]; break; }
        }
      }
    }
    for (const card of cards) {
      const todayMoves = card.history.filter(h => h.stamp.startsWith(dateStr));
      if (todayMoves.length) { tasks.push({ ...card, history: todayMoves }); continue; }
      const upto = card.history.filter(h => h.stamp.slice(0, 8) <= dateStr);
      if (!upto.length) continue;
      const last = upto.reduce((a, b) => (b.stamp > a.stamp ? b : a));
      if (isActive(last.to)) standing.push({ ...card, col: last.to });
    }
  }
  return { tasks, standing };
}

function buildSegments(history, rangeStart, rangeEnd) {
  const events = history.slice().sort((a, b) => a.stamp.localeCompare(b.stamp));
  const segs = [];
  segs.push({ col: events[0].from, start: rangeStart, end: stampToDate(events[0].stamp), startIdx: null, endIdx: 0 });
  for (let i = 0; i < events.length; i++) {
    const end = i + 1 < events.length ? stampToDate(events[i + 1].stamp) : rangeEnd;
    segs.push({ col: events[i].to, start: stampToDate(events[i].stamp), end, startIdx: i, endIdx: i + 1 < events.length ? i + 1 : null });
  }
  return segs.filter(s => s.end > s.start);
}

function hhmmInput(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function stampForDateTime(dateStr, hhmm) {
  const digits = String(hhmm || '').replace(/[^0-9]/g, '');
  if (digits.length !== 4) return null;
  return `${dateStr}${digits}`;
}

async function rewriteReportSegmentTimes(app, task, seg, dateStr, startVal, endVal) {
  const startStamp = stampForDateTime(dateStr, startVal);
  const endStamp = seg.endIdx == null ? null : stampForDateTime(dateStr, endVal);
  if (!startStamp || (seg.endIdx != null && !endStamp)) throw new Error('time must be HH:MM');
  if (seg.endIdx != null && startStamp >= endStamp) throw new Error('start must be before end');
  if (seg.startIdx == null) throw new Error('segment start is not editable');
  const events = task.history.slice().sort((a, b) => a.stamp.localeCompare(b.stamp));
  const prev = seg.startIdx > 0 ? events[seg.startIdx - 1].stamp : `${dateStr}0000`;
  const next = seg.endIdx == null
    ? null
    : (seg.endIdx + 1 < events.length ? events[seg.endIdx + 1].stamp : `${dateStr}2359`);
  if (startStamp <= prev) throw new Error('start would overlap previous segment');
  if (endStamp && endStamp >= next) throw new Error('end would overlap next segment');

  const content = await app.vault.read(task.file);
  const lines = content.split(/\r?\n/);
  const refs = [events[seg.startIdx], ...(seg.endIdx == null ? [] : [events[seg.endIdx]])];
  for (const ref of refs) {
    const li = ref.line;
    const m = lines[li]?.match(HIST_RE);
    if (!m) throw new Error('history line not found');
    const newStamp = ref === refs[0] ? startStamp : endStamp;
    lines[li] = lines[li].replace(ref.stamp, newStamp);
  }
  await app.vault.modify(task.file, lines.join('\n'));
}

function editSegmentTimes(app, task, seg, dateStr) {
  return new Promise(resolve => {
    const modal = new Modal(app);
    let done = false;
    modal.titleEl.setText(`Edit ${seg.col}`);
    const start = modal.contentEl.createEl('input', { type: 'time', value: hhmmInput(seg.start) });
    const end = modal.contentEl.createEl('input', { type: 'time', value: hhmmInput(seg.end) });
    start.style.display = end.style.display = 'block';
    start.style.width = end.style.width = '100%';
    start.style.marginBottom = '8px';
    if (seg.endIdx == null) {
      end.disabled = true;
      modal.contentEl.createDiv({ text: 'Running segment: end stays at now.' });
    }
    const info = modal.contentEl.createDiv({ text: `${fmtClock(seg.start)}-${fmtClock(seg.end)} · ${fmtDur(seg.end - seg.start)}` });
    const actions = modal.contentEl.createDiv();
    actions.style.display = 'flex';
    actions.style.gap = '8px';
    actions.style.marginTop = '12px';
    const save = actions.createEl('button', { text: 'Save' });
    const cancel = actions.createEl('button', { text: 'Cancel' });
    const submit = async () => {
      try {
        await rewriteReportSegmentTimes(app, task, seg, dateStr, start.value, end.value);
        done = true;
        modal.close();
        resolve(true);
      } catch (err) {
        new Notice(`report: ${err.message}`);
      }
    };
    save.addEventListener('click', submit);
    cancel.addEventListener('click', () => { done = true; modal.close(); resolve(false); });
    end.addEventListener('keydown', e => { if (e.key === 'Enter') void submit(); });
    start.addEventListener('keydown', e => { if (e.key === 'Enter') void submit(); });
    modal.onClose = () => { if (!done) resolve(false); };
    modal.open();
    window.setTimeout(() => start.focus(), 0);
  });
}

function renderPending(plugin, wrap, standing) {
  if (!standing.length) return;
  wrap.createEl('div', { cls: 'bdb-report-pending-title', text: 'Still pending (no move today)' });
  for (const card of standing) {
    const row = wrap.createEl('div', { cls: 'bdb-report-pending-row' });
    row.createEl('i', { cls: 'bdb-report-legend-dot' }).style.background = colColor(card.col);
    const lbl = row.createEl('span', { cls: 'bdb-report-pending-label', text: card.body, attr: { 'aria-label': `${card.col}: ${card.body}` } });
    lbl.addEventListener('click', (e) => openFileAtLine(plugin.app, card.file, card.line, e.ctrlKey || e.metaKey));
  }
}

async function drawReport(plugin, source, el, ctx, redraw) {
  let dateStr = (source || '').trim().replace(/[^0-9]/g, '').substring(0, 8);
  if (!dateStr) { const m = ctx.sourcePath.match(/(\d{8})/); dateStr = m ? m[1] : null; }
  if (!dateStr) { const t = new Date(); dateStr = `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}`; }

  const DEFAULT_COLS = 'columns: Backlog~, Todo, Doing!, Parked~, Done=x, Cancelled=-';
  const config = parseKanbanConfig(source || '');
  const cols = config.columns.length ? config.columns : parseKanbanConfig(DEFAULT_COLS).columns;
  const activeNames = new Set(cols.filter(c => !c.state && !c.paused).map(c => c.name.toLowerCase()));
  // Paused columns (Idle, Backlog, Parked) render as gaps — the timeline shows
  // "doing", not "waiting"; the bar's rail shows through where nothing happened.
  const pausedNames = new Set(cols.filter(c => c.paused).map(c => c.name.toLowerCase()));
  // Terminal columns (Done, Cancelled) are events, not durations — render them as
  // an endpoint tick at completion time, never a bar stretched to end-of-day.
  const terminalNames = new Set(cols.filter(c => c.state).map(c => c.name.toLowerCase()));
  const { tasks, standing } = await collectReportData(plugin.app, dateStr, config.paths, n => activeNames.has((n || '').toLowerCase()));
  if (!tasks.length && !standing.length) { el.createEl('div', { text: `report: no task movements on ${dateStr}` }); return; }
  if (!tasks.length) { renderPending(plugin, el.createEl('div', { cls: 'bdb-report' }), standing); return; }

  const y = +dateStr.slice(0, 4), mo = +dateStr.slice(4, 6) - 1, d = +dateStr.slice(6, 8);
  const dayStart = new Date(y, mo, d, 0, 0, 0);
  const endOfDay = new Date(y, mo, d, 23, 59, 59);

  const allStamps = tasks.flatMap(t => t.history.map(h => stampToDate(h.stamp).getTime()));
  const pad = 15 * 60000;
  const minT = dayStart.getTime();
  // Right edge = last event + pad, but for TODAY extend to the current time so the
  // axis tracks the wall clock and in-progress (Doing) bars reach "now".
  const now = new Date();
  const todayStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const maxEvent = Math.max(...allStamps) + pad;
  const maxT = Math.min(endOfDay.getTime(), dateStr === todayStr ? Math.max(maxEvent, now.getTime()) : maxEvent);
  const rangeMs = maxT - minT || 1;
  const pct = (t) => Math.max(0, Math.min(100, ((t.getTime() - minT) / rangeMs) * 100)).toFixed(2);
  const fmt = fmtClock;

  const wrap = el.createEl('div', { cls: 'bdb-report' });
  wrap.createEl('div', { cls: 'bdb-report-title', text: `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}` });

  // Ruler
  const rulerBar = wrap.createEl('div', { cls: 'bdb-report-ruler' });
  for (let i = 0; i <= 4; i++) {
    const tick = rulerBar.createEl('span', { cls: 'bdb-report-tick', text: fmt(new Date(minT + rangeMs * i / 4)) });
    tick.style.left = `${(i / 4) * 100}%`;
  }

  // Precompute per-task: segments, active time (non-paused, non-terminal
  // durations), and whether it completed today. Feeds both rows and rollups.
  for (const task of tasks) {
    task._segs = buildSegments(task.history, new Date(minT), new Date(maxT));
    task._active = task._segs.reduce((s, seg) => {
      const k = (seg.col || '').toLowerCase();
      return s + (!pausedNames.has(k) && !terminalNames.has(k) ? (seg.end - seg.start) : 0);
    }, 0);
    task._done = task._segs.some(seg => terminalNames.has((seg.col || '').toLowerCase()));
  }

  const renderRow = (host, task) => {
    const row = host.createEl('div', { cls: 'bdb-report-row' });
    const lbl = row.createEl('div', { cls: 'bdb-report-label', text: task.body, attr: { 'aria-label': task.body } });
    lbl.addEventListener('click', (e) => openFileAtLine(plugin.app, task.file, task.line, e.ctrlKey || e.metaKey));
    const bar = row.createEl('div', { cls: 'bdb-report-bar' });
    // Habit cards carry their own identity color (per-task %% kbcolor %% beats the
    // file's frontmatter); normal tasks keep column colors.
    const cardColor = task.color || plugin.app.metadataCache.getFileCache(task.file)?.frontmatter?.kbcolor || null;
    for (const seg of task._segs) {
      const key = (seg.col || '').toLowerCase();
      if (pausedNames.has(key)) continue; // gap, not a wash
      if (terminalNames.has(key)) {       // event tick at completion, not a stretched bar
        const m = bar.createEl('div', { cls: 'bdb-report-mark' });
        m.style.cssText = `left:${pct(seg.start)}%;background:${cardColor || colColor(seg.col)}`;
        m.title = `${seg.col}: ${fmt(seg.start)}`;
        continue;
      }
      const s = bar.createEl('div', { cls: 'bdb-report-seg' });
      s.style.cssText = `left:${pct(seg.start)}%;width:${Math.max(0.5, pct(seg.end) - pct(seg.start))}%;background:${cardColor || colColor(seg.col)}`;
      s.title = `${seg.col}: ${fmt(seg.start)}–${fmt(seg.end)} · ${fmtDur(seg.end - seg.start)}`;
      if (seg.startIdx != null) {
        s.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (await editSegmentTimes(plugin.app, task, seg, dateStr)) await redraw();
        });
      }
    }
  };

  const rollup = (list) => {
    const active = list.reduce((s, t) => s + t._active, 0);
    const done = list.filter(t => t._done).length;
    return `${list.length}t · ${fmtDur(active)} active · ${done} done`;
  };

  // Group rows by a frontmatter prop (lane:), mirroring the kanban swimlanes.
  const laneKey = config.lane;
  const groupOf = (task) => {
    let v = plugin.app.metadataCache.getFileCache(task.file)?.frontmatter?.[laneKey];
    if (Array.isArray(v)) v = v[0];
    v = v == null ? '' : String(v).replace(/^\[\[|\]\]$/g, '').replace(/\|.*$/, '').trim();
    return v || '(none)';
  };

  if (!laneKey) {
    wrap.createEl('div', { cls: 'bdb-report-rollup', text: rollup(tasks) });
    for (const task of tasks) renderRow(wrap, task);
  } else {
    const groups = new Map();
    for (const task of tasks) {
      const g = groupOf(task);
      (groups.get(g) || groups.set(g, []).get(g)).push(task);
    }
    const entries = [...groups.entries()].sort((a, b) =>
      (a[0] === '(none)') - (b[0] === '(none)') || b[1].length - a[1].length || a[0].localeCompare(b[0]));
    for (const [name, list] of entries) {
      const head = wrap.createEl('div', { cls: 'bdb-report-group' });
      const nameEl = head.createEl('span', { cls: 'bdb-report-group-name', text: name });
      addTitleCopy(nameEl, name);
      head.createEl('span', { cls: 'bdb-report-group-stat', text: rollup(list) });
      for (const task of list) renderRow(wrap, task);
    }
  }

  renderPending(plugin, wrap, standing);

  // Legend — drop paused columns (they render as gaps, nothing to label). Keep
  // terminal: it draws a visible endpoint tick worth explaining.
  const legendCols = [...new Set(tasks.flatMap(t => t.history.flatMap(h => [h.from, h.to])))]
    .filter(c => !pausedNames.has((c || '').toLowerCase()));
  const legend = wrap.createEl('div', { cls: 'bdb-report-legend' });
  for (const col of legendCols) {
    const item = legend.createEl('span', { cls: 'bdb-report-legend-item' });
    item.createEl('i', { cls: 'bdb-report-legend-dot' }).style.background = colColor(col);
    item.appendText(col);
  }
}

// Wrapper: redraw each minute so today's axis tracks the wall clock and
// in-progress bars grow. Lifecycle tied to the block via MarkdownRenderChild.
async function renderReportBlock(plugin, source, el, ctx) {
  const child = new MarkdownRenderChild(el);
  ctx.addChild(child);
  const draw = async () => { el.empty(); try { await drawReport(plugin, source, el, ctx, draw); } catch (e) { console.error('bdb report', e); } };
  child.registerInterval(window.setInterval(draw, 60000));
  await draw();
}

module.exports = { renderReportBlock, collectDayTasks: async (app, dateStr, paths) => (await collectReportData(app, dateStr, paths, () => false)).tasks };
