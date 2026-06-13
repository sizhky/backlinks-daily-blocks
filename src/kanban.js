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
// Eisenhower triage stamps (written by the ei block):
//     %% ei 202606120850 sched %%
const EI_HIST_RE = /^\s*%%\s?ei (\d{12}) ([\w-]+)\s?%%\s*$/;
// Tag line: tags and wikilinks only, indented under a task. Holds #kb state,
// #ei priority and [[who]] so the task line itself stays clean. Tags on the
// task line are still read (legacy); all writes target the tag line.
const TAGLINE_RE = /^\s*((?:#[\w/-]+|\[\[[^\]]+\]\])(?:[ \t]+(?:#[\w/-]+|\[\[[^\]]+\]\]))*)[ \t]*$/;

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

// Frontmatter conditions, AND across entries:
//   filter: org=Divami        value match (brackets/case ignored)
//   filter: org!=Divami       no value matches (notes without the key pass too)
//   filter: projects=Arka|GenHRX   any of (| = OR within a key)
//   filter: org               key present (non-empty)
//   filter: !org              key absent
function parseFilters(text) {
  const out = [];
  for (const part of (text || '').split(/[,\n]/)) {
    let s = part.trim();
    if (!s) continue;
    const absent = s.startsWith('!');
    if (absent) s = s.slice(1).trim();
    const neq = s.includes('!=');
    const [key, value] = s.split(/!?=/).map(x => x.trim());
    const values = (value || '').split('|')
      .map(x => x.trim().replace(/^\[\[|\]\]$/g, '').toLowerCase()).filter(Boolean);
    if (key) out.push({ key: key.replace(/^\[\[|\]\]$/g, ''), values, absent, neq });
  }
  return out;
}

// Frontmatter values for a key, normalized: always a list, [[brackets]] off.
function fmValues(app, file, key) {
  let v = app.metadataCache.getFileCache(file)?.frontmatter?.[key];
  if (v == null) return [];
  if (!Array.isArray(v)) v = [v];
  return v.filter(x => x != null)
    .map(x => String(x).replace(/^\[\[|\]\]$/g, '').trim()).filter(Boolean);
}

function passesFilter(app, file, f) {
  const vals = fmValues(app, file, f.key);
  if (f.absent) return !vals.length;
  if (!f.values.length) return vals.length > 0;
  const hit = vals.some(v => f.values.includes(v.toLowerCase()));
  return f.neq ? !hit : hit;
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
  const config = { paths: [], columns: [], maxage: null, colors: {}, sweeps: [], filters: [], lane: null };
  let lastKey = null;
  for (const rawLine of (src || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^(maxage|paths|columns|colors|sweep|filter|lane)\s*:\s*(.*)$/);
    const key = m ? m[1] : lastKey;
    const value = m ? m[2].trim() : line;
    lastKey = key;
    if (!key || !value) continue;

    if (key === 'maxage') {
      config.maxage = Number(value) || 0;
    } else if (key === 'filter') {
      config.filters.push(...parseFilters(value));
    } else if (key === 'lane') {
      config.lane = value;
    } else if (key === 'sweep') {
      config.sweeps.push(...parseSweeps(value));
    } else if (key === 'colors') {
      Object.assign(config.colors, parseColors(value));
    } else if (key === 'paths') {
      config.paths.push(...value.split(',').map(s => s.trim()).filter(Boolean));
    } else if (key === 'columns') {
      config.columns.push(...value.split(',').map(s => s.trim()).filter(Boolean).map(part => {
        // Column spec: Name[~N][!][=state] [@color]
        // ~ = paused (idle time), aging threshold N days (default 1):
        // amber past N, red past 3N. ! = live (heartbeat), =x = terminal char.
        const [spec, color] = part.split('@').map(s => s.trim());
        let [name, state] = spec.split('=').map(s => s.trim());
        let paused = false;
        let live = false;
        let age = null;
        let am;
        while ((am = name.match(/(~(\d+(?:\.\d+)?)?|!)$/))) {
          if (am[1][0] === '~') { paused = true; age = am[2] ? Number(am[2]) : 1; }
          else live = true;
          name = name.slice(0, name.length - am[1].length).trim();
        }
        if (color) config.colors[colKey(name)] = color;
        return { name, key: colKey(name), state: state || null, paused, live, age };
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
    (!config.paths.length || config.paths.some(p => f.path.startsWith(p)))
    && config.filters.every(fl => passesFilter(app, f, fl)));

  for (const file of files) {
    const lane = config.lane ? (fmValues(app, file, config.lane)[0] || null) : null;
    const lines = (await app.vault.cachedRead(file)).split(/\r?\n/);
    // Ancestor chain by indent: tasks at any depth become cards; history,
    // ei stamps and tag lines attach to the deepest task above them with
    // shallower indent. Column membership is decided after the file is read
    // because the tag line arrives after its task.
    const fileCards = [];
    const stack = [];
    const owner = (text) => {
      const indent = indentWidth(text);
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s].indent < indent) return stack[s].card;
      }
      return null;
    };
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];

      const tm = text.match(TASK_RE);
      if (tm) {
        const indent = indentWidth(text);
        while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
        const parent = stack.length ? stack[stack.length - 1].card : null;
        const card = {
          file, line: i, body: tm[4], state: tm[2], parent, lane,
          children: [], history: [], eiHistory: [], tags: [], who: [],
        };
        if (parent) parent.children.push(card);
        stack.push({ indent, card });
        fileCards.push(card);
        continue;
      }

      const hm = text.match(HIST_RE);
      if (hm) {
        owner(text)?.history.push({ stamp: hm[1], from: hm[2], to: hm[3] });
        continue;
      }

      const em = text.match(EI_HIST_RE);
      if (em) {
        owner(text)?.eiHistory.push({ stamp: em[1], label: em[2] });
        continue;
      }

      const gm = text.match(TAGLINE_RE);
      if (gm) {
        const card = owner(text);
        if (card) {
          for (const tok of gm[1].split(/\s+/)) {
            if (tok.startsWith('#')) card.tags.push(tok);
            else card.who.push(tok.slice(2, -2));
          }
        }
        continue;
      }

      // Unindented non-task content ends the current tree.
      if (!/^\s/.test(text)) stack.length = 0;
    }

    for (const card of fileCards) {
      let col;
      if (card.state === ' ') {
        const key = card.tags.find(t => t.startsWith('#kb/'))?.match(KB_TAG_RE)?.[1]
          || card.body.match(KB_TAG_RE)?.[1];
        col = byTag.get(key) || open[0];
      } else {
        col = byState.get(card.state);
        if (col && cutoff && (card.body.match(STAMP_RE)?.[0]?.trim() || '') < cutoff) col = null;
      }
      if (col) cards.get(col.key).push(card);
    }
  }
  return cards;
}

// The tag line sits directly under its task, one level deeper.
function tagLineAt(lines, line) {
  const next = lines[line + 1];
  if (next == null || !TAGLINE_RE.test(next)) return null;
  if (indentWidth(next) <= indentWidth(lines[line])) return null;
  return line + 1;
}

// Rewrite a task's tag line through fn(tokens) -> tokens. Creates the line
// when tokens appear, deletes it when they all go. Mutates `lines` in place;
// only ever touches lines below the task, so the task index stays valid.
function editTags(lines, line, fn) {
  const at = tagLineAt(lines, line);
  const tokens = at != null ? lines[at].trim().split(/\s+/) : [];
  const out = fn(tokens).filter(Boolean);
  const indent = lines[line].match(/^\s*/)[0] + '  ';
  if (at != null && !out.length) lines.splice(at, 1);
  else if (at != null) lines[at] = indent + out.join(' ');
  else if (out.length) lines.splice(line + 1, 0, indent + out.join(' '));
}

// History and ei stamps insert below the tag line when one exists.
function commentInsertAt(lines, line) {
  return tagLineAt(lines, line) != null ? line + 2 : line + 1;
}

// Indent depth in visual columns, tab = 4. Char counts lie when tabs and
// spaces mix in the same list.
// Discrete lower percentile: returns an actual observed value, never a
// number interpolated into the gap between the cluster and an outlier.
function pct(values, q) {
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) * q)];
}

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
    lines[line] = `${pre} ${close}${body}`;
  }
  // State tag lives on the tag line under the task; inline tags were
  // stripped from the body above (legacy boards migrate move by move).
  const tag = (!targetCol.state && targetCol !== firstOpen) ? `#kb/${targetCol.key}` : null;
  editTags(lines, line, tokens => {
    const rest = tokens.filter(t => !t.startsWith('#kb/'));
    return tag ? [tag, ...rest] : rest;
  });
  // Record the move as a hidden comment right under the task, one level deeper.
  const indent = lines[line].match(/^\s*/)[0];
  lines.splice(commentInsertAt(lines, line), 0, `${indent}  %% kb ${stampNow()} ${fromCol?.name || '?'} > ${targetCol.name} %%`);
  await app.vault.modify(file, lines.join('\n'));
  return true;
}

// Block config wins; settings screen supplies defaults. Resolved fresh on
// every redraw so settings edits reach already-rendered boards.
function resolveKanbanConfig(plugin, src) {
  const config = parseKanbanConfig(src);
  const defaults = plugin.settings?.kanban || {};
  if (!config.columns.length) {
    const d = parseKanbanConfig(`columns: ${defaults.columns || 'Backlog~, Todo, Doing!, Parked~, Done=x, Cancelled=-'}`);
    config.columns = d.columns;
    config.colors = { ...d.colors, ...config.colors }; // block colors still win
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
  // Clock tick: patch the running-card times in place — no teardown, no flash.
  const tick = () => { if (!state.dragging) (state.timeUpdaters || []).forEach(fn => fn()); };

  // Live refresh: minute tick keeps journey times honest, debounced vault
  // events follow note edits. Lifecycle tied to the rendered block.
  const child = new MarkdownRenderChild(el);
  ctx.addChild(child);
  child.registerInterval(window.setInterval(tick, 60000));
  let pending = null;
  child.registerEvent(plugin.app.vault.on('modify', () => {
    window.clearTimeout(pending);
    pending = window.setTimeout(redraw, 500);
  }));

  await drawBoard(plugin, board, config, state);
}

// Split the column map into lanes by card.lane. Lanes exist only where cards
// do (empty lanes never render); no-value cards pool in "(none)", last.
// Without lane config: one anonymous lane, board renders as before.
function laneSplit(config, cards) {
  if (!config.lane) return [{ name: null, cards, n: 0 }];
  const lanes = new Map();
  for (const [key, list] of cards) {
    for (const card of list) {
      const name = card.lane || '(none)';
      if (!lanes.has(name)) lanes.set(name, new Map(config.columns.map(c => [c.key, []])));
      lanes.get(name).get(key).push(card);
    }
  }
  // A lane with nothing left to do is finished work, not a lane — hide it.
  const openKeys = config.columns.filter(c => !c.state).map(c => c.key);
  return [...lanes.entries()]
    .map(([name, m]) => ({ name, cards: m, n: [...m.values()].flat().length }))
    .filter(l => openKeys.some(k => l.cards.get(k).length))
    .sort((a, b) => (a.name === '(none)') - (b.name === '(none)')
      || b.n - a.n || a.name.localeCompare(b.name));
}

async function drawBoard(plugin, board, config, state = { dragging: false }) {
  board.empty();
  const cards = await scanKanbanTasks(plugin.app, config);
  const cardEls = new Map(); // card object -> element, for breadcrumb jumps
  // Per-card in-place clock updaters; the minute tick runs these instead of a
  // full teardown. Reset every full redraw so stale element refs drop out.
  state.timeUpdaters = [];
  board.classList.toggle('bdb-kanban-stacked', !!config.lane);

  for (const lane of laneSplit(config, cards)) {
    let host = board;
    if (lane.name != null) {
      // Native <details>/<summary> fold; folded lanes survive redraws via state.
      state.folded ??= new Set();
      const laneEl = board.createEl('details', { cls: 'bdb-kanban-lane' });
      if (!state.folded.has(lane.name)) laneEl.setAttribute('open', '');
      laneEl.addEventListener('toggle', () => {
        if (laneEl.open) state.folded.delete(lane.name);
        else state.folded.add(lane.name);
      });
      laneEl.createEl('summary', { cls: 'bdb-kanban-lane-title', text: `${lane.name} (${lane.n})` });
      host = laneEl.createDiv({ cls: 'bdb-kanban-lane-row' });
    }

    for (const [index, col] of config.columns.entries()) {
      const colCards = lane.cards.get(col.key);
      const colEl = host.createDiv({ cls: 'bdb-kanban-col' });
      if (col.live) colEl.classList.add('bdb-kanban-col-live');
      colEl.style.setProperty('--kb-col-color', columnColor(config, col, index));

      // Fold: column collapses to a vertical strip (still a drop target).
      // Empty columns auto-fold; a manual toggle overrides until the next
      // drop into the column clears it. Keyed per lane.
      state.colFold ??= new Map();
      const foldKey = `${lane.name ?? ''}::${col.key}`;
      const folded = state.colFold.get(foldKey) ?? !colCards.length;
      if (folded) colEl.classList.add('bdb-kanban-col-folded');

      const titleEl = colEl.createDiv({ cls: 'bdb-kanban-col-title', text: `${col.name} (${colCards.length})` });
      titleEl.addEventListener('click', async (e) => {
        if (e.target.closest('button')) return;
        state.colFold.set(foldKey, !folded);
        await drawBoard(plugin, board, config, state);
      });

      if (!folded) for (const route of config.sweeps.filter(s => s.from === col.key)) {
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
        state.colFold.delete(foldKey); // a drop reopens the column; refolding is the user's call
        await drawBoard(plugin, board, config, state);
      });

      // Parents float to the top, children and singles below one separator.
      const parents = folded ? [] : colCards.filter(c => c.children.length);
      const leaves = folded ? [] : colCards.filter(c => !c.children.length);
      for (const card of [...parents, ...leaves]) {
        if (parents.length && leaves.length && card === leaves[0]) list.createDiv({ cls: 'bdb-kanban-sep' });
        const cardEl = list.createDiv({ cls: 'bdb-kanban-card', attr: { draggable: 'true' } });
        if (card.children.length) cardEl.classList.add('bdb-kanban-card-parent');
        if (col.live) cardEl.classList.add('bdb-kanban-card-live');
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

        // Delegation: [[who]] wikilinks from the tag line show as pills, so a
        // waiting column reads as a list of heads work is sitting on.
        if (card.who.length) {
          const whoEl = cardEl.createDiv({ cls: 'bdb-ei-who' });
          for (const name of card.who) whoEl.createSpan({ cls: 'bdb-ei-who-pill', text: name });
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

          // The current stay grows each minute; its span(s) carry a marker so
          // the clock tick can resize them without rebuilding the board.
          const liveVisit = (!terminal && inSync) ? visits[visits.length - 1] : null;

          // Two bars: full timeline (idle included), active-only below it.
          const bars = flow.createDiv({ cls: 'bdb-kanban-card-bars' });
          for (const subset of [visits, visits.filter(v => !idle.has(v.name))]) {
            const bar = bars.createDiv({ cls: 'bdb-kanban-card-bar' });
            for (const v of subset) {
              const span = bar.createSpan();
              span.style.flexGrow = String(Math.max(v.dur, 1));
              span.style.background = colorOf.get(v.name) || 'var(--background-modifier-border)';
              if (v === liveVisit) span.classList.add('bdb-kanban-live-span');
            }
          }

          const nowEl = flow.createSpan({
            cls: 'bdb-kanban-card-now',
            text: terminal
              ? `${fmtDur(active)} work · ${fmtDur(total)} total`
              : (since == null ? col.name : `${col.name} ${fmtDur(since)}`),
          });

          // Aging WIP: paused cards rot visibly (not the first column — a
          // backlog is allowed to be old). Threshold per column via ~N
          // (default 1 day): amber past N, red past 3N.
          const ages = !terminal && col.paused && col !== config.columns[0];
          const ageT = (col.age || 1) * 86400000;
          const applyAge = (ms) => {
            if (!ages || ms == null) return;
            cardEl.classList.toggle('bdb-kanban-age-red', ms > 3 * ageT);
            cardEl.classList.toggle('bdb-kanban-age-amber', ms > ageT && ms <= 3 * ageT);
          };
          applyAge(since);

          // Register the minute updater only for cards whose clock is running.
          if (liveVisit) {
            const startMs = stampToDate(last.stamp).getTime();
            state.timeUpdaters.push(() => {
              const ms = Date.now() - startMs;
              nowEl.textContent = `${col.name} ${fmtDur(ms)}`;
              for (const sp of cardEl.querySelectorAll('.bdb-kanban-live-span')) {
                sp.style.flexGrow = String(Math.max(ms, 1));
              }
              applyAge(ms);
            });
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

  // Board height: H minimizing (empty space below short columns) + 3 ×
  // (content hidden in tall ones) — the weighted-L1 optimum is the 75th
  // percentile of natural column heights. Guards: never induce a scroll
  // for crumbs (≤20% over H), never exceed 70% of the viewport.
  // Block processors render into a detached element where every height
  // reads 0 — wait for attachment before measuring.
  const fit = (tries = 0) => {
    if (!board.isConnected) {
      if (tries < 120) window.requestAnimationFrame(() => fit(tries + 1));
      return;
    }
    // Folded lanes and folded columns hide their lists (height 0) —
    // measure visible ones only.
    const lists = [...board.querySelectorAll('.bdb-kanban-cards')]
      .filter(l => (l.closest('details')?.open ?? true) && !l.closest('.bdb-kanban-col-folded'));
    if (!lists.length) return;
    // align-items: stretch inflates every list to the tallest column, and
    // scrollHeight can't read below the stretched height — un-stretch for
    // one frame to measure natural content height.
    for (const l of lists) { l.style.flex = '0 0 auto'; l.style.maxHeight = 'none'; }
    const heights = lists.map(l => l.offsetHeight);
    for (const l of lists) l.style.flex = '';
    let H = pct(heights, 0.75);
    const hMax = Math.max(...heights);
    if (hMax <= H * 1.2) H = hMax;
    H = Math.max(H, 280);
    H = Math.min(H, Math.round(window.innerHeight * 0.7));
    for (const [i, l] of lists.entries()) {
      l.style.maxHeight = `${Math.round(H)}px`;
      l.classList.toggle('bdb-kanban-clipped', heights[i] > H + 4);
    }
  };
  // Right after attach (notably on app reload) styles and pane layout may
  // not have settled, so the first measure can read junk — refit twice on
  // a timer; the measurement is idempotent.
  fit();
  window.setTimeout(fit, 400);
  window.setTimeout(fit, 2000);
}

module.exports = {
  parseKanbanConfig, scanKanbanTasks, moveCard, renderKanbanBlock,
  resolveKanbanConfig, editTags, tagLineAt, commentInsertAt,
  openDescendants, cleanText, stampNow, stampToDate, fmtDur, TASK_RE, STAMP_RE,
  columnColor, colKey,
};
