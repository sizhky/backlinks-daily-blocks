// ```kanban``` block: drag-drop board over vault task lines.
// Columns map to #kb/<name> tags; terminal columns (Name=x) map to checkbox chars
// and stamp completion time as YYYYMMDDHHmm at end of line.

const { MarkdownRenderChild, Notice } = require('obsidian');
const { renderInteractive, openFileAtLine } = require('./core/render');

const KB_TAG_GLOBAL_RE = /#kb\/[\w-]+/g;
const KB_TAG_RE = /#kb\/([\w-]+)/;
const STAMP_RE = /\s+\d{12}\s*$/;
const TASK_RE = /^(\s*[-*]\s*\[)(.)(\]\s*)(.*)$/;
// Move history rides under the task as hidden comment lines:
//     %% kb 202606111530 Todo > Doing %%
// (regex tolerates the older no-space form)
const HIST_RE = /^\s*%%\s?kb (\d{12}) (.+?) > (.+?)\s?%%\s*$/;

// Column color: explicit config > named palette > position cycle.
const COL_PALETTE = {
  backlog: '#8a8f98', todo: '#d29922', doing: '#2d7ff9',
  parked: '#8d7ee7', review: '#b180d7', done: '#2ea043', cancelled: '#e93147',
};
const COL_CYCLE = ['#2d7ff9', '#d29922', '#b180d7', '#2ea043', '#e93147', '#8a8f98'];

function columnColor(config, col, index) {
  return config.colors?.[col.key] || COL_PALETTE[col.key] || COL_CYCLE[index % COL_CYCLE.length];
}

function colKey(name) {
  return name.toLowerCase().replace(/\s+/g, '-');
}

// "Doing > Parked" routes, split on newlines or commas.
function parseSweeps(text) {
  const out = [];
  for (const route of (text || '').split(/[,\n]/)) {
    const [from, to] = route.split('>').map(s => colKey(s.trim()));
    if (from && to) out.push({ from, to });
  }
  return out;
}

// "Doing=#2d7ff9" pairs, split on newlines or commas.
function parseColors(text) {
  const out = {};
  for (const part of (text || '').split(/[,\n]/)) {
    const [name, color] = part.split('=').map(s => s.trim());
    if (name && color) out[colKey(name)] = color;
  }
  return out;
}

// Keys take values inline or on indented lines below; sweep/colors accumulate:
//   sweep:
//     Doing > Parked
//     Parked > Todo
function parseKanbanConfig(src) {
  const config = { paths: [], columns: [], maxage: null, colors: {}, sweeps: [] };
  let lastKey = null;
  for (const rawLine of (src || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^(maxage|paths|columns|colors|sweep)\s*:\s*(.*)$/);
    const key = m ? m[1] : lastKey;
    const value = m ? m[2].trim() : line;
    lastKey = key;
    if (!key || !value) continue;

    if (key === 'maxage') {
      config.maxage = Number(value) || 0;
    } else if (key === 'sweep') {
      config.sweeps.push(...parseSweeps(value));
    } else if (key === 'colors') {
      Object.assign(config.colors, parseColors(value));
    } else if (key === 'paths') {
      config.paths.push(...value.split(',').map(s => s.trim()).filter(Boolean));
    } else if (key === 'columns') {
      config.columns.push(...value.split(',').map(s => s.trim()).filter(Boolean).map(part => {
        const [rawName, state] = part.split('=').map(s => s.trim());
        // Name~ marks a paused column: time there doesn't count as work.
        const paused = rawName.endsWith('~');
        const name = paused ? rawName.slice(0, -1).trim() : rawName;
        return { name, key: colKey(name), state: state || null, paused };
      }));
    }
  }
  return config;
}

// Scan vault for task lines, bucket them into configured columns.
async function scanKanbanTasks(app, config) {
  const open = config.columns.filter(c => !c.state);
  const byState = new Map(config.columns.filter(c => c.state).map(c => [c.state, c]));
  const byTag = new Map(open.map(c => [c.key, c]));
  const cards = new Map(config.columns.map(c => [c.key, []]));

  // Terminal cards older than maxage days (or unstamped) get hidden.
  const cutoff = config.maxage ? stampNow(new Date(Date.now() - config.maxage * 86400000)) : null;

  const files = app.vault.getMarkdownFiles().filter(f =>
    !config.paths.length || config.paths.some(p => f.path.startsWith(p)));

  for (const file of files) {
    const lines = (await app.vault.cachedRead(file)).split(/\r?\n/);
    // Ancestor chain by indent: tasks at any depth become cards; a history
    // line attaches to the deepest task above it with shallower indent.
    const stack = [];
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];

      const tm = text.match(TASK_RE);
      if (tm) {
        const indent = indentWidth(text);
        while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
        const parent = stack.length ? stack[stack.length - 1].card : null;
        const card = { file, line: i, body: tm[4], state: tm[2], parent, children: [], history: [] };
        if (parent) parent.children.push(card);
        stack.push({ indent, card });

        let col;
        if (card.state === ' ') col = byTag.get(card.body.match(KB_TAG_RE)?.[1]) || open[0];
        else {
          col = byState.get(card.state);
          if (col && cutoff && (card.body.match(STAMP_RE)?.[0]?.trim() || '') < cutoff) col = null;
        }
        if (col) cards.get(col.key).push(card);
        continue;
      }

      const hm = text.match(HIST_RE);
      if (hm) {
        const indent = indentWidth(text);
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s].indent < indent) {
            stack[s].card.history.push({ stamp: hm[1], from: hm[2], to: hm[3] });
            break;
          }
        }
        continue;
      }

      // Unindented non-task content ends the current tree.
      if (!/^\s/.test(text)) stack.length = 0;
    }
  }
  return cards;
}

// Indent depth in visual columns, tab = 4. Char counts lie when tabs and
// spaces mix in the same list.
function indentWidth(text) {
  let w = 0;
  for (const ch of text.match(/^\s*/)[0]) w += ch === '\t' ? 4 : 1;
  return w;
}

function openDescendants(card) {
  let n = 0;
  for (const child of card.children) {
    if (child.state === ' ') n++;
    n += openDescendants(child);
  }
  return n;
}

function countDescendants(card) {
  return card.children.reduce((n, child) => n + 1 + countDescendants(child), 0);
}

function cleanText(body) {
  return body.replace(KB_TAG_GLOBAL_RE, '').replace(STAMP_RE, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
}

function stampNow(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

function stampToDate(s) {
  return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12));
}

function fmtDur(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d${h % 24 ? `${h % 24}h` : ''}`;
}

// Bulk-move every card in a column. Same-file cards go bottom-up so the
// history line each move inserts can't shift the next card's line number.
async function sweepColumn(app, config, fromCol, toCol, colCards) {
  const ordered = colCards.slice().sort((a, b) =>
    a.file.path === b.file.path ? b.line - a.line : a.file.path.localeCompare(b.file.path));
  let moved = 0;
  let blocked = 0;
  for (const card of ordered) {
    if (toCol.state && openDescendants(card) > 0) { blocked++; continue; }
    if (await moveCard(app, card.file, card.line, toCol, config, { fromCol })) moved++;
  }
  new Notice(`kanban: swept ${moved} to ${toCol.name}${blocked ? `, ${blocked} blocked` : ''}`);
}

// Rewrite one task line for its new column. Verifies the line is still a task.
async function moveCard(app, file, line, targetCol, config, { fromCol } = {}) {
  const content = await app.vault.read(file);
  const lines = content.split(/\r?\n/);
  const m = lines[line]?.match(TASK_RE);
  if (!m) return false;

  const [, pre, , close] = m;
  const body = m[4].replace(KB_TAG_GLOBAL_RE, '').replace(STAMP_RE, '').replace(/\s{2,}/g, ' ').trim();
  const firstOpen = config.columns.find(c => !c.state);

  if (targetCol.state) {
    lines[line] = `${pre}${targetCol.state}${close}${body} ${stampNow()}`;
  } else {
    const tag = targetCol === firstOpen ? '' : ` #kb/${targetCol.key}`;
    lines[line] = `${pre} ${close}${body}${tag}`;
  }
  // Record the move as a hidden comment right under the task, one level deeper.
  const indent = lines[line].match(/^\s*/)[0];
  lines.splice(line + 1, 0, `${indent}  %% kb ${stampNow()} ${fromCol?.name || '?'} > ${targetCol.name} %%`);
  await app.vault.modify(file, lines.join('\n'));
  return true;
}

// Block config wins; settings screen supplies defaults. Resolved fresh on
// every redraw so settings edits reach already-rendered boards.
function resolveKanbanConfig(plugin, src) {
  const config = parseKanbanConfig(src);
  const defaults = plugin.settings?.kanban || {};
  if (!config.columns.length) {
    config.columns = parseKanbanConfig(`columns: ${defaults.columns || 'Backlog~, Todo, Doing, Parked~, Done=x, Cancelled=-'}`).columns;
  }
  if (!Object.keys(config.colors).length && defaults.colors) {
    config.colors = parseColors(defaults.colors);
  }
  if (!config.paths.length && defaults.paths) {
    config.paths = defaults.paths.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (config.maxage == null) config.maxage = defaults.maxage != null ? defaults.maxage : 7;
  if (!config.sweeps.length && defaults.sweep) {
    config.sweeps = parseSweeps(defaults.sweep);
  }
  return config;
}

async function renderKanbanBlock(plugin, src, el, ctx) {
  el.empty();
  const config = resolveKanbanConfig(plugin, src);
  const states = config.columns.filter(c => c.state).map(c => c.state);
  if (new Set(states).size !== states.length) {
    el.createDiv({ text: 'kanban: two columns share the same state char' });
    return;
  }
  const board = el.createDiv({ cls: 'bdb-kanban' });
  const state = { dragging: false };
  const redraw = () => { if (!state.dragging) drawBoard(plugin, board, resolveKanbanConfig(plugin, src), state); };

  // Live refresh: minute tick keeps journey times honest, debounced vault
  // events follow note edits. Lifecycle tied to the rendered block.
  const child = new MarkdownRenderChild(el);
  ctx.addChild(child);
  child.registerInterval(window.setInterval(redraw, 60000));
  let pending = null;
  child.registerEvent(plugin.app.vault.on('modify', () => {
    window.clearTimeout(pending);
    pending = window.setTimeout(redraw, 500);
  }));

  await drawBoard(plugin, board, config, state);
}

async function drawBoard(plugin, board, config, state = { dragging: false }) {
  board.empty();
  const cards = await scanKanbanTasks(plugin.app, config);
  const cardEls = new Map(); // card object -> element, for breadcrumb jumps

  for (const [index, col] of config.columns.entries()) {
    const colCards = cards.get(col.key);
    const colEl = board.createDiv({ cls: 'bdb-kanban-col' });
    colEl.style.setProperty('--kb-col-color', columnColor(config, col, index));
    const titleEl = colEl.createDiv({ cls: 'bdb-kanban-col-title', text: `${col.name} (${colCards.length})` });

    for (const route of config.sweeps.filter(s => s.from === col.key)) {
      const sweepTo = config.columns.find(c => c.key === route.to);
      if (!sweepTo) continue;
      const btn = titleEl.createEl('button', {
        cls: 'bdb-kanban-sweep', text: `⤳ ${sweepTo.name}`,
        attr: { 'aria-label': `Sweep all to ${sweepTo.name}` },
      });
      btn.addEventListener('click', async () => {
        await sweepColumn(plugin.app, config, col, sweepTo, colCards);
        await drawBoard(plugin, board, config, state);
      });
    }
    const list = colEl.createDiv({ cls: 'bdb-kanban-cards' });

    const rejects = () => col.state && state.card && openDescendants(state.card) > 0;
    colEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (rejects()) {
        e.dataTransfer.dropEffect = 'none';
        colEl.classList.add('bdb-kanban-reject');
      } else {
        colEl.classList.add('bdb-kanban-over');
      }
    });
    colEl.addEventListener('dragleave', () => colEl.classList.remove('bdb-kanban-over', 'bdb-kanban-reject'));
    colEl.addEventListener('drop', async (e) => {
      e.preventDefault();
      colEl.classList.remove('bdb-kanban-over', 'bdb-kanban-reject');
      const [path, lineStr, fromKey] = (e.dataTransfer.getData('text/plain') || '').split('::');
      if (!path || fromKey === col.key) return;
      const file = plugin.app.vault.getAbstractFileByPath(path);
      if (!file) return;
      state.dragging = false;
      // Terminal columns refuse parents with open children.
      if (col.state) {
        const dragged = [...cards.values()].flat().find(c => c.file.path === path && c.line === Number(lineStr));
        const blockers = dragged ? openDescendants(dragged) : 0;
        if (blockers) {
          new Notice(`kanban: ${blockers} open sub-task${blockers > 1 ? 's' : ''} — close them first`);
          return;
        }
      }
      await moveCard(plugin.app, file, Number(lineStr), col, config, {
        fromCol: config.columns.find(c => c.key === fromKey),
      });
      await drawBoard(plugin, board, config, state);
    });

    for (const card of colCards) {
      const cardEl = list.createDiv({ cls: 'bdb-kanban-card', attr: { draggable: 'true' } });
      if (card.children.length) cardEl.classList.add('bdb-kanban-card-parent');
      cardEls.set(card, cardEl);
      if (card.parent) {
        const crumb = cardEl.createDiv({ cls: 'bdb-kanban-card-crumb', text: `${cleanText(card.parent.body)} ▸` });
        crumb.addEventListener('click', (e) => {
          const parentEl = cardEls.get(card.parent);
          if (!parentEl) return openFileAtLine(plugin.app, card.parent.file, card.parent.line, e.ctrlKey || e.metaKey);
          parentEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          parentEl.classList.remove('bdb-kanban-glow');
          void parentEl.offsetWidth; // restart animation on repeat clicks
          parentEl.classList.add('bdb-kanban-glow');
        });
      }
      const display = card.body.replace(KB_TAG_GLOBAL_RE, '').replace(STAMP_RE, '').trim();
      const textEl = cardEl.createDiv({ cls: 'bdb-kanban-card-text' });
      await renderInteractive(plugin, display, textEl, card.file.path);

      // Rollup: derived child progress, never mutates parent state.
      // Lives inline at the end of the title text.
      const total = countDescendants(card);
      if (total) {
        const closed = total - openDescendants(card);
        const host = textEl.querySelector('p') || textEl;
        const pill = host.createSpan({ cls: 'bdb-kanban-card-rollup', text: `${closed}/${total}` });
        if (closed === total) pill.classList.add('bdb-kanban-card-rollup-full');
      }

      if (card.history.length) {
        const es = card.history.slice().sort((a, b) => a.stamp.localeCompare(b.stamp));
        const colorOf = new Map(config.columns.map((c, i) => [c.name, columnColor(config, c, i)]));
        const idle = new Set(config.columns.filter(c => c.paused).map(c => c.name));
        const terminal = !!col.state; // terminal clocks freeze: done is done, not "still doing done"

        // A task is born when its note is: YYYYMMDD-HHmm filename convention.
        const birthM = card.file.name.match(/^(\d{8})-(\d{4})/);
        const birth = birthM ? stampToDate(birthM[1] + birthM[2]) : null;

        // Visits: every stay in a column, starting at birth when known.
        const visits = [];
        if (birth) visits.push({ name: es[0].from, dur: Math.max(stampToDate(es[0].stamp) - birth, 0) });
        for (let i = 0; i < es.length; i++) {
          const isLast = i === es.length - 1;
          if (isLast && terminal) break;
          const dur = (isLast ? new Date() : stampToDate(es[i + 1].stamp)) - stampToDate(es[i].stamp);
          visits.push({ name: es[i].to, dur });
        }
        const active = visits.filter(v => !idle.has(v.name)).reduce((sum, v) => sum + v.dur, 0);
        const journeyStart = birth || stampToDate(es[0].stamp);
        const journeyEnd = terminal ? stampToDate(es[es.length - 1].stamp) : new Date();
        const total = Math.max(journeyEnd - journeyStart, 0);

        const parts = visits.map(v => `${v.name} ${fmtDur(v.dur)}`);
        if (!birth) parts.unshift(es[0].from);
        if (terminal) parts.push(col.name);

        // Label trusts the column the card actually sits in; history only
        // supplies the duration when it agrees (off-board edits write no history).
        const last = es[es.length - 1];
        const inSync = last.to === col.name;
        const lineStamp = card.body.match(STAMP_RE)?.[0]?.trim();
        let since = null;
        if (terminal && lineStamp) since = new Date() - stampToDate(lineStamp);
        else if (inSync) since = new Date() - stampToDate(last.stamp);

        const flow = cardEl.createDiv({ cls: 'bdb-kanban-card-flow', attr: { title: parts.join(' → ') } });

        // Two bars: full timeline (idle included), active-only below it.
        const bars = flow.createDiv({ cls: 'bdb-kanban-card-bars' });
        for (const subset of [visits, visits.filter(v => !idle.has(v.name))]) {
          const bar = bars.createDiv({ cls: 'bdb-kanban-card-bar' });
          for (const v of subset) {
            const span = bar.createSpan();
            span.style.flexGrow = String(Math.max(v.dur, 1));
            span.style.background = colorOf.get(v.name) || 'var(--background-modifier-border)';
          }
        }

        flow.createSpan({
          cls: 'bdb-kanban-card-now',
          text: terminal
            ? `${fmtDur(active)} work · ${fmtDur(total)} total`
            : (since == null ? col.name : `${col.name} ${fmtDur(since)}`),
        });

        // Aging WIP: paused cards rot visibly (not the first column — a
        // backlog is allowed to be old). Amber past 2 days, red past 7.
        if (!terminal && col.paused && col !== config.columns[0] && since != null) {
          if (since > 7 * 86400000) cardEl.classList.add('bdb-kanban-age-red');
          else if (since > 2 * 86400000) cardEl.classList.add('bdb-kanban-age-amber');
        }
      }

      const stamp = card.body.match(STAMP_RE)?.[0]?.trim();
      cardEl.createDiv({ cls: 'bdb-kanban-card-meta', text: stamp ? `${card.file.basename} · ${stamp}` : card.file.basename });

      cardEl.addEventListener('dragstart', (e) => {
        state.dragging = true;
        state.card = card;
        e.dataTransfer.setData('text/plain', `${card.file.path}::${card.line}::${col.key}`);
        e.dataTransfer.effectAllowed = 'move';
      });
      cardEl.addEventListener('dragend', () => { state.dragging = false; state.card = null; });
      cardEl.querySelector('.bdb-kanban-card-meta').addEventListener('click', (e) => {
        openFileAtLine(plugin.app, card.file, card.line, e.ctrlKey || e.metaKey);
      });
    }
  }
}

module.exports = { parseKanbanConfig, scanKanbanTasks, moveCard, renderKanbanBlock };
