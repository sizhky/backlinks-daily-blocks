// report fence — daily task Gantt chart
const { TASK_RE, STAMP_RE, stampToDate, stampDigits, stampWrite, parseKanbanConfig, fmtDur, addTitleCopy } = require('./kanban');
const { openFileAtLine } = require('./core/render');
const { chrono } = require('./core/activity');
const { MarkdownRenderChild, Modal, Notice, getFrontMatterInfo, parseYaml } = require('obsidian');

const HIST_RE = /^\s*%%\s?kb (\d{8}-?\d{4}) (.+?) > (.+?)\s?%%\s*$/;
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

// Deterministic, well-spread color per project name (summary bar segments).
function projColor(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 52% 55%)`;
}

function indentWidth(text) {
  let w = 0;
  for (const ch of text.match(/^\s*/)[0]) w += ch === '\t' ? 4 : 1;
  return w;
}

function fmtClock(d) {
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function fmtDateTitle(dateStr) {
  return `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;
}

function shiftDateStr(dateStr, { years = 0, months = 0, days = 0 } = {}) {
  const d = new Date(+dateStr.slice(0, 4), +dateStr.slice(4, 6) - 1, +dateStr.slice(6, 8));
  if (years) d.setFullYear(d.getFullYear() + years);
  if (months) d.setMonth(d.getMonth() + months);
  if (days) d.setDate(d.getDate() + days);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function parseDateStr(dateStr) {
  return new Date(+dateStr.slice(0, 4), +dateStr.slice(4, 6) - 1, +dateStr.slice(6, 8));
}

function toDateStr(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function rangeDates(startStr, endStr) {
  const out = [];
  for (let d = parseDateStr(startStr), end = parseDateStr(endStr); d <= end; d.setDate(d.getDate() + 1)) {
    out.push(toDateStr(d));
  }
  return out;
}

function weekBounds(dateStr) {
  const d = parseDateStr(dateStr);
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  const start = toDateStr(d);
  d.setDate(d.getDate() + 6);
  const end = toDateStr(d);
  return { start, end };
}

function reportRange(state) {
  if (state.mode === 'week') {
    const { start, end } = weekBounds(state.dateStr);
    return { start, end, dates: rangeDates(start, end), label: `${fmtDateTitle(start)} .. ${fmtDateTitle(end)}` };
  }
  if (state.mode === '7d') {
    const end = state.dateStr;
    const start = shiftDateStr(end, { days: -6 });
    return { start, end, dates: rangeDates(start, end), label: `${fmtDateTitle(start)} .. ${fmtDateTitle(end)}` };
  }
  return { start: state.dateStr, end: state.dateStr, dates: [state.dateStr], label: fmtDateTitle(state.dateStr) };
}

function dayOfWeekLabel(dateStr) {
  return parseDateStr(dateStr).toLocaleDateString(undefined, { weekday: 'long' });
}

function weekNumberLabel(dateStr) {
  const d = parseDateStr(dateStr);
  const utc = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc - yearStart) / 86400000) + 1) / 7);
  return `Week ${week}`;
}

async function collectReportData(app, startStr, endStr, paths, isActive) {
  const tasks = [], standing = [];
  const files = app.vault.getMarkdownFiles().filter(f => {
    if (paths.length && !paths.some(p => f.path.startsWith(p))) return false;
    return !!app.metadataCache.getFileCache(f)?.listItems?.some(it => it.task != null);
  });
  for (const file of files) {
    const raw = await app.vault.cachedRead(file);
    const info = getFrontMatterInfo(raw);
    const fm = info.frontmatter ? (parseYaml(info.frontmatter) || {}) : {};
    const lines = raw.split(/\r?\n/);
    const stack = [], cards = [];
    for (let li = 0; li < lines.length; li++) {
      const text = lines[li];
      const tm = text.match(TASK_RE);
      if (tm) {
        const indent = indentWidth(text);
        while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
        const card = { body: tm[4].replace(STAMP_RE, '').trim(), history: [], indent, file, line: li, color: null, fm };
        stack.push({ indent, card }); cards.push(card); continue;
      }
      const hm = text.match(HIST_RE);
      if (hm) {
        const hi = indentWidth(text);
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].indent < hi) { stack[i].card.history.push({ stamp: stampDigits(hm[1]), from: hm[2], to: hm[3], line: li, seq: li }); break; }
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
      const rangeMoves = card.history.filter(h => {
        const ds = h.stamp.slice(0, 8);
        return ds >= startStr && ds <= endStr;
      });
      if (rangeMoves.length) { tasks.push({ ...card, history: rangeMoves }); continue; }
      const upto = card.history.filter(h => h.stamp.slice(0, 8) <= endStr);
      if (!upto.length) continue;
      const last = chrono(upto).at(-1);
      if (isActive(last.to)) standing.push({ ...card, col: last.to });
    }
  }
  return { tasks, standing };
}

function buildSegments(history, rangeStart, rangeEnd) {
  const events = chrono(history);
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

function stampToMs(stamp) {
  return stampToDate(stamp).getTime();
}

function formatDragStamp(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtDurGranular(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

async function rewriteReportSegmentTimes(app, task, seg, dateStr, startVal, endVal) {
  const startStamp = seg.startIdx == null ? null : stampForDateTime(dateStr, startVal);
  const endStamp = seg.endIdx == null ? null : stampForDateTime(dateStr, endVal);
  if ((seg.startIdx != null && !startStamp) || (seg.endIdx != null && !endStamp)) throw new Error('time must be HH:MM');
  if (seg.startIdx != null && seg.endIdx != null && startStamp >= endStamp) throw new Error('start must be before end');
  const events = task.chrono(history);
  const prev = seg.startIdx > 0 ? events[seg.startIdx - 1].stamp : `${dateStr}0000`;
  const next = seg.endIdx == null
    ? null
    : (seg.endIdx + 1 < events.length ? events[seg.endIdx + 1].stamp : `${dateStr}2359`);
  if (startStamp && startStamp <= prev) throw new Error('start would overlap previous segment');
  if (endStamp && endStamp >= next) throw new Error('end would overlap next segment');
  if (startStamp && endStamp && startStamp >= endStamp) throw new Error('start must be before end');

  const content = await app.vault.read(task.file);
  const lines = content.split(/\r?\n/);
  const refs = [
    ...(seg.startIdx == null ? [] : [events[seg.startIdx]]),
    ...(seg.endIdx == null ? [] : [events[seg.endIdx]]),
  ];
  for (const ref of refs) {
    const li = ref.line;
    const m = lines[li]?.match(HIST_RE);
    if (!m) throw new Error('history line not found');
    const newStamp = ref === events[seg.startIdx] ? startStamp : endStamp;
    lines[li] = lines[li].replace(m[1], stampWrite(newStamp));
  }
  await app.vault.modify(task.file, lines.join('\n'));
}

function dragBounds(task, seg, dateStr, maxT) {
  const events = task.chrono(history);
  return {
    prev: seg.startIdx > 0 ? stampToMs(events[seg.startIdx - 1].stamp) : new Date(+dateStr.slice(0, 4), +dateStr.slice(4, 6) - 1, +dateStr.slice(6, 8), 0, 0, 0).getTime(),
    next: seg.endIdx == null
      ? maxT
      : (seg.endIdx + 1 < events.length ? stampToMs(events[seg.endIdx + 1].stamp) : new Date(+dateStr.slice(0, 4), +dateStr.slice(4, 6) - 1, +dateStr.slice(6, 8), 23, 59, 0).getTime()),
  };
}

function reportSegDragMode(seg, localX, segWidthPx, edgePx) {
  const canStart = seg.startIdx != null;
  const canEnd = seg.endIdx != null;
  if (canStart && canEnd) {
    if (localX <= edgePx) return 'start';
    if (localX >= segWidthPx - edgePx) return 'end';
    return 'move';
  }
  if (canStart && localX <= edgePx) return 'start';
  if (canEnd && localX >= segWidthPx - edgePx) return 'end';
  return null;
}

function showDragBubble(text, x, y) {
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
  return el;
}

function hideDragBubble() {
  document.querySelector('.bdb-report-drag-bubble')?.classList.remove('is-visible');
}

function showOriginBubble(text, x, y, color) {
  let el = document.querySelector('.bdb-report-origin-bubble');
  if (!el) {
    el = document.createElement('div');
    el.className = 'bdb-report-origin-bubble';
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
  if (color) el.style.setProperty('--bdb-origin-color', color);
  if (color) el.style.setProperty('--bdb-origin-color-mix', `color-mix(in srgb, ${color} 78%, black)`);
  el.classList.add('is-visible');
  return el;
}

function hideOriginBubble() {
  document.querySelector('.bdb-report-origin-bubble')?.classList.remove('is-visible');
}

function setReportGuidesVisible(el, on, topPx = null) {
  if (!el) return;
  if (topPx != null) el.style.top = `${topPx}px`;
  el.classList.toggle('is-visible', !!on);
}

let activeReportDrag = null;
let reportEscBound = false;
function ensureReportEscHandler() {
  if (reportEscBound) return;
  reportEscBound = true;
  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !activeReportDrag?.cancel) return;
    ev.preventDefault();
    ev.stopPropagation();
    activeReportDrag.cancel();
  }, true);
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
    if (seg.startIdx == null) {
      start.disabled = true;
      modal.contentEl.createDiv({ text: 'Carryover segment: start stays at day start.' });
    }
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

async function renderReportRangeSection(plugin, host, startStr, endStr, config, activeNames, pausedNames, terminalNames, redraw, { showSubtitle = false, label = null, interactive = true } = {}) {
  const title = label || (startStr === endStr ? fmtDateTitle(startStr) : `${fmtDateTitle(startStr)} .. ${fmtDateTitle(endStr)}`);
  const visibleKeys = new Set((config.only?.length ? config.only : ['todo', 'doing', 'parked', 'done', 'cancelled'])
    .map(s => String(s).toLowerCase()));
  const { tasks, standing } = await collectReportData(plugin.app, startStr, endStr, config.paths, n => activeNames.has((n || '').toLowerCase()));
  const section = host.createDiv({ cls: 'bdb-report-day' });
  if (showSubtitle) section.createDiv({ cls: 'bdb-report-subtitle', text: title });
  if (!tasks.length && !standing.length) {
    section.createEl('div', { cls: 'bdb-report-empty', text: `No task movements on ${title}` });
    return;
  }
  if (!tasks.length) {
    section.createEl('div', { cls: 'bdb-report-empty', text: `No task movements on ${title}` });
    renderPending(plugin, section, standing);
    return;
  }

  const dayStart = parseDateStr(startStr); dayStart.setHours(0, 0, 0, 0);
  const endOfDay = parseDateStr(endStr); endOfDay.setHours(23, 59, 59, 999);
  const allStamps = tasks.flatMap(t => t.history.map(h => stampToDate(h.stamp).getTime()));
  const pad = 15 * 60000;
  const minT = dayStart.getTime();
  const now = new Date();
  const todayStr = toDateStr(now);
  const maxEvent = Math.max(...allStamps) + pad;
  const maxT = endStr < todayStr
    ? endOfDay.getTime()
    : Math.min(endOfDay.getTime(), Math.max(maxEvent, now.getTime()));
  const rangeMs = maxT - minT || 1;
  const pct = (t) => Math.max(0, Math.min(100, ((t.getTime() - minT) / rangeMs) * 100)).toFixed(2);
  const fmt = fmtClock;
  const pxToMinuteMs = (dx, width) => Math.round(((dx / Math.max(width, 1)) * rangeMs) / 60000) * 60000;
  section.dataset.zoom = section.dataset.zoom || '1';
  section.dataset.pan = section.dataset.pan || '0';
  const applyZoom = (z, anchor01) => {
    section.dataset.zoom = String(z);
    const pan = Number(section.dataset.pan || '0');
    section.style.setProperty('--bdb-report-zoom', String(z));
    section.style.setProperty('--bdb-report-zoom-shift', `${pan - ((z - 1) * anchor01 * 100)}%`);
  };
  const applyPan = (pan) => {
    const zoom = Number(section.dataset.zoom || '1');
    const minPan = -(zoom - 1) * 100;
    const clamped = Math.max(minPan, Math.min(0, pan));
    section.dataset.pan = String(clamped);
    section.style.setProperty('--bdb-report-zoom', String(zoom));
    section.style.setProperty('--bdb-report-zoom-shift', `${clamped}%`);
  };
  applyPan(Number(section.dataset.pan || '0'));

  const rulerBar = section.createEl('div', { cls: 'bdb-report-ruler' });
  const rulerInner = rulerBar.createDiv({ cls: 'bdb-report-ruler-inner' });
  for (let i = 0; i <= 4; i++) {
    const tick = rulerInner.createEl('span', { cls: 'bdb-report-tick', text: fmt(new Date(minT + rangeMs * i / 4)) });
    tick.style.left = `${(i / 4) * 100}%`;
  }
  section.addEventListener('wheel', (e) => {
    const rect = rulerBar.getBoundingClientRect();
    if (e.altKey) {
      e.preventDefault();
      applyPan(Number(section.dataset.pan || '0') - (e.deltaY + e.deltaX) * 0.08);
      return;
    }
    if (!(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    const anchor01 = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(rect.width, 1)));
    const cur = Number(section.dataset.zoom || '1');
    const next = Math.max(1, Math.min(20, e.deltaY < 0 ? cur * 1.12 : cur / 1.12));
    applyZoom(next, anchor01);
  }, { passive: false });

  for (const task of tasks) {
    task._segs = buildSegments(task.history, new Date(minT), new Date(maxT));
    task._active = task._segs.reduce((s, seg) => {
      const k = (seg.col || '').toLowerCase();
      return s + (!pausedNames.has(k) && !terminalNames.has(k) ? (seg.end - seg.start) : 0);
    }, 0);
    task._done = task._segs.some(seg => terminalNames.has((seg.col || '').toLowerCase()));
  }
  const guidePcts = [...new Set(tasks.flatMap(t => t._segs.flatMap(seg => {
    const k = (seg.col || '').toLowerCase();
    if (pausedNames.has(k) || terminalNames.has(k)) return [];
    return [pct(seg.start), pct(seg.end)];
  })))];
  const midnightPcts = [];
  if (startStr !== endStr) {
    for (let d = new Date(dayStart); ; ) {
      d.setDate(d.getDate() + 1);
      if (d > endOfDay) break;
      midnightPcts.push(pct(d));
    }
  }
  const midnightsEl = section.createDiv({ cls: 'bdb-report-midnights' });
  for (const p of midnightPcts) {
    const line = midnightsEl.createDiv({ cls: 'bdb-report-midnight' });
    line.style.left = `${p}%`;
  }
  const guidesEl = section.createDiv({ cls: 'bdb-report-guides' });
  for (const p of guidePcts) {
    const line = guidesEl.createDiv({ cls: 'bdb-report-guide' });
    line.style.left = `${p}%`;
  }

  const renderRow = (task) => {
    const row = section.createEl('div', { cls: 'bdb-report-row' });
    const lbl = row.createEl('div', { cls: 'bdb-report-label', text: task.body, attr: { 'aria-label': task.body } });
    lbl.addEventListener('click', (e) => openFileAtLine(plugin.app, task.file, task.line, e.ctrlKey || e.metaKey));
    const bar = row.createEl('div', { cls: 'bdb-report-bar' });
    const barInner = bar.createDiv({ cls: 'bdb-report-bar-inner' });
    const cardColor = task.color || task.fm?.kbcolor || null;
    for (const seg of task._segs) {
      const key = (seg.col || '').toLowerCase();
      if (!visibleKeys.has(key)) continue;
      if (terminalNames.has(key)) {
        const m = barInner.createEl('div', { cls: 'bdb-report-mark' });
        m.style.cssText = `left:${pct(seg.start)}%;background:${cardColor || colColor(seg.col)}`;
        continue;
      }
      const s = barInner.createEl('div', { cls: 'bdb-report-seg' });
      s.style.cssText = `left:${pct(seg.start)}%;width:${Math.max(0.5, pct(seg.end) - pct(seg.start))}%;background:${cardColor || colColor(seg.col)}`;
      const tip = `${task.body} · ${seg.col}: ${fmt(seg.start)}–${fmt(seg.end)} · ${fmtDurGranular(seg.end - seg.start)}`;
      s.dataset.bdbTip = tip;
      s.addEventListener('pointerenter', (e) => { if (!activeReportDrag) showDragBubble(tip, e.clientX, e.clientY - 14); });
      s.addEventListener('pointerleave', () => {
        if (!activeReportDrag) hideDragBubble();
        s.classList.remove('is-drag-start', 'is-drag-end', 'is-drag-move');
      });
      s.addEventListener('pointermove', (e) => {
        if (!activeReportDrag) showDragBubble(tip, e.clientX, e.clientY - 14);
        if (!interactive) return;
        const localX = e.clientX - s.getBoundingClientRect().left;
        const segWidthPx = s.getBoundingClientRect().width;
        const mode = reportSegDragMode(seg, localX, segWidthPx, 10);
        s.classList.toggle('is-drag-start', mode === 'start');
        s.classList.toggle('is-drag-end', mode === 'end');
        s.classList.toggle('is-drag-move', mode === 'move');
      });
      if (interactive && (seg.startIdx != null || seg.endIdx != null)) {
        s.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault(); e.stopPropagation();
          const rect = bar.getBoundingClientRect();
          const segStartMs = seg.start.getTime(), segEndMs = seg.end.getTime();
          const localX = e.clientX - s.getBoundingClientRect().left;
          const segWidthPx = s.getBoundingClientRect().width;
          const mode = reportSegDragMode(seg, localX, segWidthPx, 10);
          if (!mode) return;
          const bounds = dragBounds(task, seg, startStr, maxT);
          let moved = false, cancelled = false, draftStart = segStartMs, draftEnd = segEndMs;
          const originText = mode === 'move' ? `${formatDragStamp(segStartMs)}-${formatDragStamp(segEndMs)}` : formatDragStamp(mode === 'end' ? segEndMs : segStartMs);
          setReportGuidesVisible(guidesEl, true, rulerBar.offsetTop + rulerBar.offsetHeight + 4);
          showOriginBubble(originText, e.clientX, rect.top - 18, cardColor || colColor(seg.col));
          const paint = () => { s.style.left = `${((draftStart - minT) / rangeMs) * 100}%`; s.style.width = `${Math.max(0.5, ((draftEnd - draftStart) / rangeMs) * 100)}%`; };
          const updateBubble = (x, y) => showDragBubble(mode === 'move' ? `${formatDragStamp(draftStart)}-${formatDragStamp(draftEnd)}` : formatDragStamp(mode === 'end' ? draftEnd : draftStart), x, y - 18);
          const onMove = (ev) => {
            const delta = pxToMinuteMs(ev.clientX - e.clientX, rect.width);
            moved = moved || Math.abs(delta) >= 60000;
            if (mode === 'start') draftStart = Math.max(bounds.prev + 60000, Math.min(segEndMs - 60000, segStartMs + delta));
            else if (mode === 'end') draftEnd = Math.min(bounds.next - 60000, Math.max(segStartMs + 60000, segEndMs + delta));
            else {
              const span = segEndMs - segStartMs, minStart = bounds.prev + 60000, maxStart = bounds.next - span - 60000;
              draftStart = Math.max(minStart, Math.min(maxStart, segStartMs + delta)); draftEnd = draftStart + span;
            }
            paint(); updateBubble(ev.clientX, rect.top);
          };
          const cancelDrag = () => {
            cancelled = true; window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp);
            hideDragBubble(); hideOriginBubble(); setReportGuidesVisible(guidesEl, false); activeReportDrag = null;
            s.style.cssText = `left:${pct(seg.start)}%;width:${Math.max(0.5, pct(seg.end) - pct(seg.start))}%;background:${cardColor || colColor(seg.col)}`;
          };
          activeReportDrag = { cancel: cancelDrag };
          const onUp = async () => {
            activeReportDrag = null; window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp);
            hideDragBubble(); hideOriginBubble(); setReportGuidesVisible(guidesEl, false);
            if (cancelled) return;
            if (!moved) {
              s.style.cssText = `left:${pct(seg.start)}%;width:${Math.max(0.5, pct(seg.end) - pct(seg.start))}%;background:${cardColor || colColor(seg.col)}`;
              if (await editSegmentTimes(plugin.app, task, seg, startStr)) await redraw();
              return;
            }
            try {
              await rewriteReportSegmentTimes(plugin.app, task, seg, startStr, hhmmInput(new Date(draftStart)), hhmmInput(new Date(draftEnd)));
              await redraw();
            } catch (err) {
              new Notice(`report: ${err.message}`);
              s.style.cssText = `left:${pct(seg.start)}%;width:${Math.max(0.5, pct(seg.end) - pct(seg.start))}%;background:${cardColor || colColor(seg.col)}`;
            }
          };
          updateBubble(e.clientX, rect.top);
          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', onUp, { once: true });
        });
      }
    }
  };

  const rollup = (list) => `${list.length}t · ${fmtDur(list.reduce((s, t) => s + t._active, 0))} active · ${list.filter(t => t._done).length} done`;
  const laneKey = config.lane;
  const groupOf = (task) => {
    let v = task.fm?.[laneKey];
    if (Array.isArray(v)) v = v[0];
    v = v == null ? '' : String(v).replace(/^\[\[|\]\]$/g, '').replace(/\|.*$/, '').trim();
    return v || '(none)';
  };
  if (!laneKey) {
    section.createEl('div', { cls: 'bdb-report-rollup', text: rollup(tasks) });
    for (const task of tasks) renderRow(task);
  } else {
    const groups = new Map();
    for (const task of tasks) (groups.get(groupOf(task)) || groups.set(groupOf(task), []).get(groupOf(task))).push(task);
    for (const [name, list] of [...groups.entries()].sort((a, b) => (a[0] === '(none)') - (b[0] === '(none)') || b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
      const head = section.createEl('div', { cls: 'bdb-report-group' });
      const nameEl = head.createEl('span', { cls: 'bdb-report-group-name', text: name });
      addTitleCopy(nameEl, name);
      head.createEl('span', { cls: 'bdb-report-group-stat', text: rollup(list) });
      for (const task of list) renderRow(task);
    }
  }
  renderPending(plugin, section, standing);
  const legendCols = [...new Set(tasks.flatMap(t => t.history.flatMap(h => [h.from, h.to])))]
    .filter(c => visibleKeys.has((c || '').toLowerCase()));
  const legend = section.createEl('div', { cls: 'bdb-report-legend' });
  for (const col of legendCols) {
    const item = legend.createEl('span', { cls: 'bdb-report-legend-item' });
    item.createEl('i', { cls: 'bdb-report-legend-dot' }).style.background = colColor(col);
    item.appendText(col);
  }
}

// Compact day summary: overall totals, a stacked column-time bar, and a
// per-project breakdown. Reuses the same segment math as the Gantt — just
// aggregates instead of drawing each stay. Shown when the Σ toggle is on.
async function renderDaySummary(plugin, host, startStr, endStr, config, activeNames, pausedNames, terminalNames) {
  const { tasks, standing } = await collectReportData(plugin.app, startStr, endStr, config.paths, n => activeNames.has((n || '').toLowerCase()));
  const section = host.createDiv({ cls: 'bdb-report-summary' });
  if (!tasks.length) {
    section.createDiv({ cls: 'bdb-report-empty', text: 'No task movements' });
    renderPending(plugin, section, standing);
    return;
  }
  const dayStart = parseDateStr(startStr); dayStart.setHours(0, 0, 0, 0);
  const endOfDay = parseDateStr(endStr); endOfDay.setHours(23, 59, 59, 999);
  const now = new Date(); const todayStr = toDateStr(now);
  const allStamps = tasks.flatMap(t => t.history.map(h => stampToDate(h.stamp).getTime()));
  const maxEvent = Math.max(...allStamps) + 15 * 60000;
  const maxT = endStr < todayStr
    ? endOfDay.getTime()
    : Math.min(endOfDay.getTime(), Math.max(maxEvent, now.getTime()));

  const colTime = new Map();  // column -> active ms
  const colCount = new Map(); // column -> distinct tasks that touched it today
  for (const task of tasks) {
    task._segs = buildSegments(task.history, dayStart, new Date(maxT));
    task._active = 0; task._done = false;
    const seen = new Set();
    for (const seg of task._segs) {
      const k = (seg.col || '').toLowerCase();
      seen.add(seg.col);
      if (terminalNames.has(k)) { task._done = true; continue; }
      const dur = seg.end - seg.start;
      if (!pausedNames.has(k)) task._active += dur;
      colTime.set(seg.col, (colTime.get(seg.col) || 0) + dur);
    }
    for (const c of seen) colCount.set(c, (colCount.get(c) || 0) + 1);
  }
  const totalActive = tasks.reduce((s, t) => s + t._active, 0);
  const doneN = tasks.filter(t => t._done).length;

  // Per-project rollup (every project, no truncation).
  const groups = [];
  if (config.lane) {
    const groupOf = (task) => {
      let v = task.fm?.[config.lane];
      if (Array.isArray(v)) v = v[0];
      v = v == null ? '' : String(v).replace(/^\[\[|\]\]$/g, '').replace(/\|.*$/, '').trim();
      return v || '(none)';
    };
    const m = new Map();
    for (const t of tasks) { const g = groupOf(t); (m.get(g) || m.set(g, []).get(g)).push(t); }
    groups.push(...[...m.entries()].sort((a, b) => b[1].length - a[1].length));
  }

  section.createDiv({ cls: 'bdb-report-summary-head', text: `${tasks.length} tasks · ${fmtDur(totalActive)} active · ${doneN} done` });

  // A labeled stacked bar: one segment per item, sized by task count so it stays
  // meaningful even on days with no tracked time. Inline label, full detail on hover.
  const sumBar = (caption, segs) => {
    if (!segs.length) return;
    const row = section.createDiv({ cls: 'bdb-report-sumbar-row' });
    row.createSpan({ cls: 'bdb-report-sumbar-cap', text: caption });
    const track = row.createDiv({ cls: 'bdb-report-sumbar' });
    for (const x of segs) {
      const seg = track.createDiv({ cls: 'bdb-report-sumbar-seg' });
      seg.style.flexGrow = String(Math.max(x.size, 1));
      seg.style.background = x.color;
      seg.setAttribute('title', x.tip);
      seg.createSpan({ cls: 'bdb-report-sumbar-lbl', text: x.label });
    }
  };

  sumBar('Projects', groups.map(([name, arr]) => ({
    size: arr.length,
    color: projColor(name),
    label: `${name} ${arr.length}`,
    tip: `${name}: ${arr.length}t · ${fmtDur(arr.reduce((s, t) => s + t._active, 0))} active · ${arr.filter(t => t._done).length} done`,
  })));
  sumBar('Columns', [...colCount.entries()].sort((a, b) => b[1] - a[1]).map(([col, n]) => ({
    size: n,
    color: colColor(col),
    label: `${col} ${n}`,
    tip: `${col}: ${n}t · ${fmtDur(colTime.get(col) || 0)} active`,
  })));
}

async function drawReport(plugin, source, el, ctx, redraw, state) {
  ensureReportEscHandler();
  let dateStr = state?.dateStr || (source || '').trim().replace(/[^0-9]/g, '').substring(0, 8);
  if (!dateStr) { const m = ctx.sourcePath.match(/(\d{8})/); dateStr = m ? m[1] : null; }
  if (!dateStr) { const t = new Date(); dateStr = `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}`; }
  if (state) state.dateStr = dateStr;

  const DEFAULT_COLS = 'columns: Backlog~, Todo, Doing!, Parked~, Done=x, Cancelled=-';
  const config = parseKanbanConfig(source || '');
  const cols = config.columns.length ? config.columns : parseKanbanConfig(DEFAULT_COLS).columns;
  const activeNames = new Set(cols.filter(c => !c.state && !c.paused).map(c => c.name.toLowerCase()));
  const visibleKeys = new Set((config.only?.length ? config.only : ['todo', 'doing', 'parked', 'done', 'cancelled'])
    .map(s => String(s).toLowerCase()));
  // Paused columns (Idle, Backlog, Parked) render as gaps — the timeline shows
  // "doing", not "waiting"; the bar's rail shows through where nothing happened.
  const pausedNames = new Set(cols.filter(c => c.paused).map(c => c.name.toLowerCase()));
  // Terminal columns (Done, Cancelled) are events, not durations — render them as
  // an endpoint tick at completion time, never a bar stretched to end-of-day.
  const terminalNames = new Set(cols.filter(c => c.state).map(c => c.name.toLowerCase()));

  const wrap = el.createEl('div', { cls: 'bdb-report' });
  const head = wrap.createDiv({ cls: 'bdb-report-head' });
  const mode = state.mode || 'day';
  const range = reportRange({ mode, dateStr });
  const modeWrap = head.createDiv({ cls: 'bdb-report-modes' });
  for (const key of ['day', 'week', '7d']) {
    const btn = modeWrap.createEl('button', { cls: `bdb-report-mode${mode === key ? ' is-active' : ''}`, text: key === 'day' ? 'D' : key === 'week' ? 'W' : '7D', attr: { type: 'button' } });
    btn.addEventListener('click', async () => { state.mode = key; await redraw(); });
  }
  // Σ: collapse the detailed timeline into a compact day summary (totals,
  // per-column time, per-project breakdown). In-memory toggle, like kanban's.
  const sumBtn = modeWrap.createEl('button', { cls: `bdb-report-mode${state.summary ? ' is-active' : ''}`, text: 'Σ', attr: { type: 'button', 'aria-label': 'Toggle day summary' } });
  sumBtn.addEventListener('click', async () => { state.summary = !state.summary; await redraw(); });
  const dock = head.createDiv({ cls: 'bdb-report-dock' });
  const dateBtn = dock.createEl('button', { cls: 'bdb-report-title', text: fmtDateTitle(dateStr), attr: { type: 'button', 'aria-label': 'Pick report date' } });
  const metaEl = dock.createDiv({ cls: 'bdb-report-meta' });
  const picker = head.createEl('input', { attr: { type: 'date' } });
  picker.value = fmtDateTitle(dateStr);
  picker.style.position = 'absolute';
  picker.style.opacity = '0';
  picker.style.pointerEvents = 'none';
  const nav = dock.createDiv({ cls: 'bdb-report-nav' });
  const today = (() => {
    const t = new Date();
    return `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}`;
  })();
  dateBtn.addEventListener('click', () => picker.showPicker ? picker.showPicker() : picker.click());
  picker.addEventListener('change', async () => {
    const picked = picker.value.replace(/[^0-9]/g, '');
    if (picked.length === 8) { state.dateStr = picked; await redraw(); }
  });

  dateBtn.setText(mode === 'week' ? range.label : fmtDateTitle(dateStr));
  metaEl.setText(mode === 'week' ? weekNumberLabel(dateStr) : mode === '7d' ? 'Rolling 7 days' : dayOfWeekLabel(dateStr));
  nav.empty();
  const addJump = (label, delta, explicitDate = null) => {
    const btn = nav.createEl('button', { cls: 'bdb-report-navbtn', text: label, attr: { type: 'button' } });
    if (label === '•') btn.classList.add('is-today');
    btn.addEventListener('click', async () => {
      state.dateStr = explicitDate || shiftDateStr(dateStr, delta);
      await redraw();
    });
  };
  addJump('-Y', { years: -1 });
  addJump('-M', { months: -1 });
  addJump('-W', { days: -7 });
  if (mode !== 'week') addJump('-D', { days: -1 });
  addJump('•', {}, today);
  if (mode !== 'week') addJump('D+', { days: 1 });
  addJump('W+', { days: 7 });
  addJump('M+', { months: 1 });
  addJump('Y+', { years: 1 });
  if (state.summary) {
    await renderDaySummary(plugin, wrap, range.start, range.end, config, activeNames, pausedNames, terminalNames);
  } else if (mode === 'week' || mode === '7d') {
    await renderReportRangeSection(plugin, wrap, range.start, range.end, config, activeNames, pausedNames, terminalNames, redraw, {
      showSubtitle: false,
      label: range.label,
      interactive: false,
    });
  } else {
    await renderReportRangeSection(plugin, wrap, dateStr, dateStr, config, activeNames, pausedNames, terminalNames, redraw, {
      showSubtitle: false,
      label: fmtDateTitle(dateStr),
      interactive: true,
    });
  }
}

// Wrapper: redraw each minute so today's axis tracks the wall clock and
// in-progress bars grow. Lifecycle tied to the block via MarkdownRenderChild.
async function renderReportBlock(plugin, source, el, ctx) {
  const state = { dateStr: null, mode: 'day' };
  const child = new MarkdownRenderChild(el);
  ctx.addChild(child);
  const draw = async () => { el.empty(); try { await drawReport(plugin, source, el, ctx, draw, state); } catch (e) { console.error('bdb report', e); } };
  // Only the live view (one whose range spans today) advances with the clock.
  // Past/future views are static — skip the 60s teardown so they don't flicker.
  child.registerInterval(window.setInterval(() => {
    const today = toDateStr(new Date());
    const r = reportRange({ mode: state.mode || 'day', dateStr: state.dateStr || today });
    if (r.start <= today && today <= r.end) draw();
  }, 60000));
  await draw();
}

module.exports = { renderReportBlock, collectDayTasks: async (app, dateStr, paths) => (await collectReportData(app, dateStr, dateStr, paths, () => false)).tasks };
