// ```kanban``` block: drag-drop board over vault task lines.
// Columns map to #kb/<name> tags; terminal columns (Name=x) map to checkbox chars
// and stamp completion time as YYYYMMDDHHmm at end of line.

const { MarkdownRenderChild, Notice, Platform, setIcon } = require('obsidian');
const { renderInteractive, openFileAtLine } = require('./core/render');

// Persisted marker for "no lanes selected". Kept distinct from a cleared
// `lanes:` line (= all) and from the "(none)" no-frontmatter pool lane.
const LANE_NONE = '__none__';

const KB_TAG_GLOBAL_RE = /#kb\/[\w-]+/g;
const KB_TAG_RE = /#kb\/([\w-]+)/;
const STAMP_RE = /\s+\d{8}-?\d{4}\s*$/;
const TASK_RE = /^(\s*[-*]\s*\[)(.)(\]\s*)(.*)$/;
// Move history rides under the task as hidden comment lines:
//     %% kb 20260611-1530 Todo > Doing %%
// (regex tolerates the older no-space and unhyphenated forms)
const HIST_RE = /^\s*%%\s?kb (\d{8}-?\d{4}) (.+?) > (.+?)\s?%%\s*$/;
// Eisenhower triage stamps (written by the ei block):
//     %% ei 20260612-0850 sched %%
const EI_HIST_RE = /^\s*%%\s?ei (\d{8}-?\d{4}) ([\w-]+)\s?%%\s*$/;
// Per-card color override (under the task): %% kbcolor #e06c8b %%. Beats frontmatter.
const COLOR_RE = /^\s*%%\s?kbcolor (#[0-9a-fA-F]{3,8}|[a-zA-Z]+)\s?%%\s*$/;
// Per-card Iconify icon: %% kbicon mdi:shower %%. Beats frontmatter `icon`.
const ICON_RE = /^\s*%%\s?kbicon ([a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*)\s?%%\s*$/i;
// Per-card metric override: %% kbmetric count %%. Beats frontmatter `metric`.
const METRIC_RE = /^\s*%%\s?kbmetric (count|sum)\s?%%\s*$/i;
// Per-card click-to-record flag: %% kbtap %%. One tap = one zero-duration span.
const TAP_RE = /^\s*%%\s?kbtap\s?%%\s*$/i;
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
function fmValues(cache, key) {
  let v = cache?.frontmatter?.[key];
  if (v == null) return [];
  if (!Array.isArray(v)) v = [v];
  return v.filter(x => x != null)
    .map(x => String(x).replace(/^\[\[|\]\]$/g, '').trim()).filter(Boolean);
}

function passesFilter(cache, f) {
  const vals = fmValues(cache, f.key);
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
  const config = { paths: [], columns: [], maxage: null, colors: {}, sweeps: [], filters: [], lane: null, groupby: null, lanes: [], open: [], hidedonelanes: false, lanesort: null, mode: null, only: [], autoFold: null };
  let lastKey = null;
  for (const rawLine of (src || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^(maxage|paths|columns|colors|sweep|filter|lane|groupby|lanes|open|hidedonelanes|lanesort|mode|only|auto-fold|fold)\s*:\s*(.*)$/);
    const key = m ? m[1] : lastKey;
    const value = m ? m[2].trim() : line;
    lastKey = key;
    if (!key || !value) continue;

    if (key === 'maxage') {
      config.maxage = Number(value) || 0;
    } else if (key === 'mode') {
      config.mode = value.toLowerCase();
    } else if (key === 'auto-fold' || key === 'fold') {
      config.autoFold = value !== 'false';
    } else if (key === 'hidedonelanes') {
      config.hidedonelanes = value !== 'false';
    } else if (key === 'lanesort') {
      config.lanesort = colKey(value);
    } else if (key === 'filter') {
      config.filters.push(...parseFilters(value));
    } else if (key === 'lane') {
      config.lane = value;
    } else if (key === 'groupby') {
      config.groupby = value;
    } else if (key === 'lanes') {
      // Selected swimlanes shown as cards, in order. Empty/absent = all
      // (back-compat). Written back by the lane picker; survives restart.
      config.lanes.push(...value.split(',').map(s => s.trim()).filter(Boolean));
    } else if (key === 'open') {
      // Expanded lanes: rendered as full boards inline, not collapsed cards.
      // Written back when a card is clicked open; survives restart.
      config.open.push(...value.split(',').map(s => s.trim()).filter(Boolean));
    } else if (key === 'only') {
      // Display filter: render only these columns. Bucketing is unchanged, so
      // untagged tasks still land in the real inbox (first column) and just
      // don't show here. Lets a board show a single column without making it
      // the catch-all. Matched by colKey against the full column set.
      config.only.push(...value.split(',').map(s => colKey(s.trim())).filter(Boolean));
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
async function scanKanbanTasks(app, config, opts = {}) {
  const open = config.columns.filter(c => !c.state);
  const byState = new Map(config.columns.filter(c => c.state).map(c => [c.state, c]));
  const byTag = new Map(open.map(c => [c.key, c]));
  const cards = new Map(config.columns.map(c => [c.key, []]));

  // Terminal cards older than maxage days (or unstamped) get hidden.
  const cutoff = config.maxage ? stampNow(new Date(Date.now() - config.maxage * 86400000)) : null;

  const files = app.vault.getMarkdownFiles().filter(f => {
    if (config.paths.length && !config.paths.some(p => f.path.startsWith(p))) return false;
    const cache = app.metadataCache.getFileCache(f);
    if (!cache?.listItems?.some(it => it.task != null)) return false;
    const cacheFilter = opts.cacheFilter || config.cacheFilter;
    if (cacheFilter && !cacheFilter(cache, f)) return false;
    return config.filters.every(fl => passesFilter(cache, fl));
  });

  for (const file of files) {
    const cache = app.metadataCache.getFileCache(file);
    const lane = config.lane ? (fmValues(cache, config.lane)[0] || null) : null;
    const laneGroup = config.groupby ? (fmValues(cache, config.groupby)[0] || null) : null;
    const lines = (await app.vault.cachedRead(file)).split(/\r?\n/);
    // Ancestor chain by indent: tasks at any depth become cards; history,
    // ei stamps and tag lines attach to the deepest task above them with
    // shallower indent. Column membership is decided after the file is read
    // because the tag line arrives after its task.
    const fileCards = [];
    const stack = [];
    let group = null; // last open `- [!]` header; flat-parents the tasks below it
    const owner = (text) => {
      const indent = indentWidth(text);
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s].indent < indent) return stack[s].card;
      }
      return null;
    };
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];

      // A `---` thematic break closes the open `- [!]` group: following
      // top-level tasks are standalone again until the next `- [!]`.
      if (/^-{3,}\s*$/.test(text)) { group = null; continue; }

      const tm = text.match(TASK_RE);
      if (tm) {
        const indent = indentWidth(text);
        while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
        let parent = stack.length ? stack[stack.length - 1].card : null;
        const isGroup = tm[2] === '!';
        // A top-level task under an open `- [!]` group flat-parents to it;
        // indentation still nests deeper tasks under their own ancestor.
        if (!parent && !isGroup && group) parent = group;
        const card = {
          file, line: i, body: tm[4], state: tm[2], parent, lane, group: laneGroup, isGroup,
          children: [], history: [], eiHistory: [], tags: [], who: [], color: null, icon: null,
        };
        if (parent) parent.children.push(card);
        stack.push({ indent, card });
        fileCards.push(card);
        if (isGroup) group = card; // resets on the next `- [!]`
        continue;
      }

      const hm = text.match(HIST_RE);
      if (hm) {
        owner(text)?.history.push({ stamp: stampDigits(hm[1]), from: hm[2], to: hm[3] });
        continue;
      }

      const em = text.match(EI_HIST_RE);
      if (em) {
        owner(text)?.eiHistory.push({ stamp: stampDigits(em[1]), label: em[2] });
        continue;
      }

      const cm = text.match(COLOR_RE);
      if (cm) {
        const card = owner(text);
        if (card) card.color = cm[1];
        continue;
      }

      const im = text.match(ICON_RE);
      if (im) {
        const card = owner(text);
        if (card) card.icon = im[1];
        continue;
      }

      const mm = text.match(METRIC_RE);
      if (mm) {
        const card = owner(text);
        if (card) card.metric = mm[1].toLowerCase();
        continue;
      }

      const tpm = text.match(TAP_RE);
      if (tpm) {
        const card = owner(text);
        if (card) card.tap = true;
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
      if (card.state === ' ' || card.state === '!') { // `!` = group header, lives like an open card
        const key = card.tags.find(t => t.startsWith('#kb/'))?.match(KB_TAG_RE)?.[1]
          || card.body.match(KB_TAG_RE)?.[1];
        col = byTag.get(key) || open[0];
      } else {
        col = byState.get(card.state);
        if (col && cutoff && terminalStamp(card, col) < cutoff) col = null;
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

// Keep task metadata ordered as: pinned config, freeform note lines, hidden
// logs, then any child tasks. Returns where the next kb log should go.
function normalizeTaskMeta(lines, line) {
  const base = indentWidth(lines[line]);
  let i = line + 1;
  while (i < lines.length) {
    const t = lines[i];
    if (!t.trim() || indentWidth(t) <= base) break;
    i++;
  }
  const end = i;
  const prefix = [], notes = [], logs = [];
  let restAt = end;
  for (i = line + 1; i < end; i++) {
    const t = lines[i];
    if (TAGLINE_RE.test(t) || COLOR_RE.test(t) || ICON_RE.test(t) || METRIC_RE.test(t) || TAP_RE.test(t)) prefix.push(t);
    else if (HIST_RE.test(t) || EI_HIST_RE.test(t)) logs.push(t);
    else if (TASK_RE.test(t)) { restAt = i; break; }
    else notes.push(t);
  }
  lines.splice(line + 1, end - (line + 1), ...prefix, ...notes, ...logs, ...lines.slice(restAt, end));
  return line + 1 + prefix.length + notes.length;
}

function commentInsertAt(lines, line) {
  return normalizeTaskMeta(lines, line);
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

// A copy icon on a swimlane/group header that copies just the group title.
// Stops propagation so it never toggles the lane fold underneath it.
function addTitleCopy(titleEl, text) {
  const btn = titleEl.createSpan({ cls: 'bdb-title-copy', attr: { 'aria-label': 'Copy title' } });
  setIcon(btn, 'copy');
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    e.preventDefault();
    await navigator.clipboard.writeText(text);
    setIcon(btn, 'check');
    btn.classList.add('bdb-title-copied');
    window.setTimeout(() => { setIcon(btn, 'copy'); btn.classList.remove('bdb-title-copied'); }, 1200);
  });
  return btn;
}

function stampNow(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

// Stamps live in notes as yyyymmdd-hhmm but are stored and compared as bare
// digits, so slice() offsets and lexical ordering stay valid.
function stampDigits(s) {
  return String(s).replace(/\D/g, '');
}

function stampWrite(s) {
  const d = stampDigits(s);
  return `${d.slice(0, 8)}-${d.slice(8, 12)}`;
}

function stampToDate(s) {
  s = stampDigits(s);
  return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12));
}

function terminalStamp(card, col) {
  const line = card.body.match(STAMP_RE)?.[0]?.trim();
  return (line && stampDigits(line))
    || card.history.reduce((latest, ev) => (
      ev.to === col.name && ev.stamp > latest ? ev.stamp : latest
    ), '');
}

function hhmmMs(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function fmtDur(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d${h % 24 ? `${h % 24}h` : ''}`;
}

function fmtDurCompact(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? `${m % 60}m` : ''}`;
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
    lines[line] = `${pre}${targetCol.state}${close}${body}`;
  } else {
    // Keep a group header's `!` so moving it between columns doesn't dissolve the group.
    lines[line] = `${pre}${m[2] === '!' ? '!' : ' '}${close}${body}`;
  }
  // State tag lives on the tag line under the task; inline tags were
  // stripped from the body above (legacy boards migrate move by move).
  const tag = (!targetCol.state && targetCol !== firstOpen) ? `#kb/${targetCol.key}` : null;
  editTags(lines, line, tokens => {
    const rest = tokens.filter(t => !t.startsWith('#kb/'));
    return tag ? [tag, ...rest] : rest;
  });
  // Record the move under note lines but above any child tasks.
  const indent = lines[line].match(/^\s*/)[0];
  lines.splice(normalizeTaskMeta(lines, line), 0, `${indent}  %% kb ${stampWrite(stampNow())} ${fromCol?.name || '?'} > ${targetCol.name} %%`);
  await app.vault.modify(file, lines.join('\n'));
  return true;
}

// Tap-to-record: append ONE closed Idle>Doing>Idle span in a single write.
// end = start + 1min so the pair sorts unambiguously (same-minute stamps would
// read as an open span). The card never changes column — no flicker, no tag churn.
async function logTapSpan(app, file, line) {
  const content = await app.vault.read(file);
  const lines = content.split(/\r?\n/);
  if (!TASK_RE.test(lines[line] || '')) return false;
  // Stamps are minute-precision: taps in the same minute would share a stamp and
  // the pair logic in spans() would collapse them. Step each tap past the card's
  // latest stamp so every tap is its own clean closed span.
  const base = indentWidth(lines[line]);
  let maxMs = 0;
  for (let i = line + 1; i < lines.length; i++) {
    if (lines[i].trim() && indentWidth(lines[i]) <= base) break;
    const h = lines[i].match(HIST_RE);
    if (h) maxMs = Math.max(maxMs, stampToDate(h[1]).getTime());
  }
  const startMs = Math.max(Date.now(), maxMs + 60000);
  const start = stampWrite(stampNow(new Date(startMs)));
  const end = stampWrite(stampNow(new Date(startMs + 60000)));
  const indent = lines[line].match(/^\s*/)[0];
  // newest-first (matches log convention): close stamp on top, open below.
  lines.splice(normalizeTaskMeta(lines, line), 0,
    `${indent}  %% kb ${end} Doing > Idle %%`,
    `${indent}  %% kb ${start} Idle > Doing %%`);
  await app.vault.modify(file, lines.join('\n'));
  return true;
}

// True if the file at `path` holds at least one checkbox task.
function fileHasTask(app, path) {
  const f = path && app.vault.getAbstractFileByPath(path);
  const li = f && app.metadataCache.getFileCache(f)?.listItems;
  return !!li && li.some(it => it.task != null);
}

// Block config wins; settings screen supplies defaults. Resolved fresh on
// every redraw so settings edits reach already-rendered boards.
// A block that declares no `paths:` auto-scopes off its host note (sourcePath):
// note has tasks -> scope to that note; note has none -> whole vault. One block,
// both local and global use.
function resolveKanbanConfig(plugin, src, sourcePath) {
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
  if (!config.paths.length && sourcePath) {
    // Bare block: local when the host note has tasks, else vault-wide.
    if (fileHasTask(plugin.app, sourcePath)) config.paths = [sourcePath];
  } else if (!config.paths.length && defaults.paths) {
    config.paths = defaults.paths.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (config.maxage == null) config.maxage = defaults.maxage != null ? defaults.maxage : 7;
  if (config.autoFold == null) config.autoFold = defaults.autoFold === true || defaults.fold === true;
  if (!config.sweeps.length && defaults.sweep) {
    config.sweeps = parseSweeps(defaults.sweep);
  }
  if (config.lanesort == null && defaults.lanesort) config.lanesort = defaults.lanesort;
  return config;
}

// Rewrite this block's own `lanes:` (visible cards) and `open:` (expanded
// boards) lines in the host note so the picker survives a restart. Empty list
// => remove that line. Live rendering reads state, not the file, so a missing
// sectionInfo is benign (live-only, just won't persist).
async function persistLaneState(plugin, ctx, el, selectedNames, openNames, state) {
  const info = ctx.getSectionInfo?.(el);
  if (!info) return; // embedded/unknown context: live-only, can't persist
  const file = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
  if (!file) return;
  const lines = (await plugin.app.vault.read(file)).split('\n');
  const bodyStart = info.lineStart + 1; // first line after the ```kanban fence
  const body = lines.slice(bodyStart, info.lineEnd); // up to, not incl, closing fence
  const out = [];
  for (let i = 0; i < body.length; i++) {
    if (/^\s*(lanes|open)\s*:/.test(body[i])) {
      while (i + 1 < body.length && /^\s+\S/.test(body[i + 1])) i++; // drop indented continuation
      continue;
    }
    out.push(body[i]);
  }
  if (selectedNames.length) out.push(`lanes: ${selectedNames.join(', ')}`);
  if (openNames.length) out.push(`open: ${openNames.join(', ')}`);
  state.selfWriteAt = Date.now(); // our own write — skip the echoed vault-modify redraw
  lines.splice(bodyStart, info.lineEnd - bodyStart, ...out);
  await plugin.app.vault.modify(file, lines.join('\n'));
}

async function renderKanbanBlock(plugin, src, el, ctx) {
  el.empty();
  const config = resolveKanbanConfig(plugin, src, ctx.sourcePath);
  const states = config.columns.filter(c => c.state).map(c => c.state);
  if (new Set(states).size !== states.length) {
    el.createDiv({ text: 'kanban: two columns share the same state char' });
    return;
  }
  const board = el.createDiv({ cls: 'bdb-kanban' });
  const state = { dragging: false };
  // Lane selection: Set of lowercased lane names, empty Set = none, null = all
  // (back-compat). Seeded from the block's `lanes:` line. A cleared line means
  // "all", so "none" persists as an explicit sentinel (LANE_NONE) to stay distinct.
  state.selectedLanes = config.lanes.length
    ? (config.lanes.length === 1 && config.lanes[0].toLowerCase() === LANE_NONE
        ? new Set()
        : new Set(config.lanes.map(n => n.toLowerCase())))
    : null;
  // Expanded lanes (rendered as full boards). Empty = all collapsed to cards.
  state.openLanes = new Set(config.open.map(n => n.toLowerCase()));
  let persistTimer = null;
  state.persist = (selectedNames, openNames) => {
    window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => persistLaneState(plugin, ctx, el, selectedNames, openNames, state), 400);
  };
  const redraw = () => { if (!state.dragging) drawBoard(plugin, board, resolveKanbanConfig(plugin, src, ctx.sourcePath), state); };
  // Clock tick: patch the running-card times in place — no teardown, no flash.
  const tick = () => { if (!state.dragging) (state.timeUpdaters || []).forEach(fn => fn()); };

  // Live refresh: minute tick keeps journey times honest, debounced vault
  // events follow note edits. Lifecycle tied to the rendered block.
  const child = new MarkdownRenderChild(el);
  ctx.addChild(child);
  child.registerInterval(window.setInterval(tick, 60000));
  let pending = null;
  const scheduleRedraw = (file) => {
    // A move we just made echoes back as a modify; we already redrew in place.
    if (state.selfWriteAt && Date.now() - state.selfWriteAt < 1500) return;
    // Ignore churn outside this board's scope — non-markdown files (.base/.json)
    // and notes in other folders shouldn't trigger a full rebuild (the "jitter").
    if (file && file.extension !== 'md') return;
    if (file && config.paths.length && !config.paths.some(p => file.path.startsWith(p))) return;
    window.clearTimeout(pending);
    pending = window.setTimeout(redraw, 500);
  };
  child.registerEvent(plugin.app.vault.on('modify', scheduleRedraw));
  // Shift-click on any board's collapse button broadcasts here; every board folds
  // its own empty/terminal columns. state.collapse is refreshed each drawBoard.
  child.registerDomEvent(window, 'bdb-kanban-collapse-all', () => state.collapse?.());

  await drawBoard(plugin, board, config, state);
}

function emptyColMap(config) {
  return new Map(config.columns.map(c => [c.key, []]));
}

function laneMetrics(config, cards) {
  const openKeys = config.columns.filter(c => !c.state).map(c => c.key);
  const termKeys = config.columns.filter(c => c.state).map(c => c.key);
  const actKeys = config.columns.filter((c, i) => !c.state && !c.paused && i !== 0).map(c => c.key);
  return {
    n: [...cards.values()].flat().length,
    done: termKeys.reduce((s, k) => s + cards.get(k).length, 0),
    open: openKeys.reduce((s, k) => s + cards.get(k).length, 0),
    actionable: actKeys.reduce((s, k) => s + cards.get(k).length, 0),
  };
}

function aggregateCards(config, lanes) {
  const cards = emptyColMap(config);
  for (const lane of lanes) {
    for (const [key, list] of lane.cards) cards.get(key).push(...list);
  }
  return cards;
}

function compareNames(a, b) {
  const noneLast = (a === '(none)') - (b === '(none)');
  return noneLast || String(a).localeCompare(String(b));
}

// Split the column map into lanes by card.lane, optionally under card.group.
// Empty lanes never render; no-value cards pool in "(none)", last.
// Without lane/group config: one anonymous lane, board renders as before.
function laneSplit(config, cards) {
  if (!config.lane && !config.groupby) return [{ name: null, group: null, cards, ...laneMetrics(config, cards) }];
  const lanes = new Map();
  for (const [key, list] of cards) {
    for (const card of list) {
      const group = config.groupby ? (card.group || '(none)') : null;
      const name = config.lane ? (card.lane || '(none)') : null;
      const id = `${group ?? ''}\u0000${name ?? ''}`;
      if (!lanes.has(id)) lanes.set(id, { group, name, cards: emptyColMap(config) });
      lanes.get(id).cards.get(key).push(card);
    }
  }
  // hidedonelanes: a lane with nothing left in an open column is finished
  // work, not a lane — drop it. Off by default; all non-empty lanes show.
  const openKeys = config.columns.filter(c => !c.state).map(c => c.key);
  return [...lanes.values()]
    .map(l => ({ ...l, ...laneMetrics(config, l.cards) }))
    .filter(l => !config.hidedonelanes || openKeys.some(k => l.cards.get(k).length))
    // lanesort: "<key>-<dir>", key = total|open|name, dir = desc|asc (default
    // desc; bare "total"/"open" still parse). For numeric keys (none) sorts by
    // its value, losing ties to real lanes; for name sorts it always pins last.
    .sort((a, b) => {
      const [skey, dir = 'desc'] = (config.lanesort || 'total').split('-');
      const sign = dir === 'asc' ? 1 : -1;
      const byGroup = compareNames(a.group || '', b.group || '');
      if (byGroup) return byGroup;
      if (skey === 'name') return sign * compareNames(a.name, b.name);
      const byKey = sign * ((skey === 'open' ? a.open : a.n) - (skey === 'open' ? b.open : b.n));
      return byKey || compareNames(a.name, b.name);
    });
}

function laneGroupSplit(config, lanes) {
  if (!config.groupby) {
    const cards = aggregateCards(config, lanes);
    return [{ name: null, lanes, cards, ...laneMetrics(config, cards) }];
  }
  const groups = new Map();
  for (const lane of lanes) {
    const name = lane.group || '(none)';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(lane);
  }
  return [...groups.entries()]
    .map(([name, groupLanes]) => {
      const cards = aggregateCards(config, groupLanes);
      return { name, lanes: groupLanes, cards, ...laneMetrics(config, cards) };
    })
    .sort((a, b) => (b.open - a.open) || compareNames(a.name, b.name));
}

async function drawBoard(plugin, board, config, state = { dragging: false }) {
  // Scan BEFORE clearing: the vault read is slow, and an empty board collapses
  // to height 0 mid-await, jumping the page scroll. Build the data first, then
  // tear down and refill in the same synchronous stretch.
  const cards = await scanKanbanTasks(plugin.app, config);
  board.empty();
  const cardEls = new Map(); // card object -> element, for breadcrumb jumps
  // Per-card in-place clock updaters; the minute tick runs these instead of a
  // full teardown. Reset every full redraw so stale element refs drop out.
  state.timeUpdaters = [];
  state.folded ??= new Set();
  state.groupFold ??= new Set();
  state.colFold ??= new Map();

  const lanes = laneSplit(config, cards);

  // Top action bar: common board-wide actions. First action collapses every
  // empty column and every lane with no pending (open-column) cards.
  const bar = board.createDiv({ cls: 'bdb-kanban-toolbar' });
  const collapseBtn = bar.createEl('button', { cls: 'bdb-kanban-tool', attr: { 'aria-label': 'Collapse empty/terminal columns (Shift: all boards)' } });
  setIcon(collapseBtn, 'fold-vertical');
  // Stored on state so the window broadcast (Shift-click on any board) can fold
  // this board too; refreshed each draw with the current lanes.
  const collapse = async () => {
    for (const group of laneGroupSplit(config, lanes)) {
      if (config.groupby && group.open === 0) state.groupFold.add(group.name);
    }
    for (const lane of lanes) {
      if (lane.name != null && lane.open === 0) state.folded.add(lane.name);
      for (const col of config.columns) {
        // Fold empty columns and terminal columns (Done/Cancelled) regardless of count.
        if (!lane.cards.get(col.key).length || col.state) state.colFold.set(`${lane.group ?? ''}::${lane.name ?? ''}::${col.key}`, true);
      }
    }
    await drawBoard(plugin, board, config, state);
  };
  state.collapse = collapse;
  collapseBtn.addEventListener('click', (e) => {
    if (e.shiftKey) window.dispatchEvent(new CustomEvent('bdb-kanban-collapse-all'));
    else collapse();
  });
  for (const route of config.sweeps) {
    const fromCol = config.columns.find(c => c.key === route.from);
    const toCol = config.columns.find(c => c.key === route.to);
    if (!fromCol || !toCol) continue;
    const btn = bar.createEl('button', {
      cls: 'bdb-kanban-tool bdb-kanban-sweep',
      text: `${fromCol.name} > ${toCol.name}`,
      attr: { 'aria-label': `Sweep all ${fromCol.name} cards to ${toCol.name}` },
    });
    btn.addEventListener('click', async () => {
      await sweepColumn(plugin.app, config, fromCol, toCol, cards.get(fromCol.key) || []);
      await drawBoard(plugin, board, config, state);
    });
  }

  // Lane selection + expansion. selectedLanes = which lanes show as cards
  // (null = all); openLanes = which are expanded to full boards. Both persist.
  const norm = (n) => String(n ?? '').toLowerCase();
  state.openLanes ??= new Set();
  const visibleLanes = state.selectedLanes
    ? lanes.filter(l => state.selectedLanes.has(norm(l.name)))
    : lanes;
  const laneGroups = laneGroupSplit(config, visibleLanes);
  // Persist args: selection uses a sentinel for "none" (a cleared line = all);
  // open is plain (cleared = nothing expanded).
  const selNames = () => !state.selectedLanes ? []
    : state.selectedLanes.size === 0 ? [LANE_NONE]
    : state.selectedLanes.size === lanes.length ? []
    : lanes.filter(l => state.selectedLanes.has(norm(l.name))).map(l => l.name);
  const openNames = () => lanes.filter(l => state.openLanes.has(norm(l.name))).map(l => l.name);
  const persistNow = () => state.persist?.(selNames(), openNames());
  const applyOpen = (name, isOpen) => {
    isOpen ? state.openLanes.add(norm(name)) : state.openLanes.delete(norm(name));
    persistNow();
    drawBoard(plugin, board, config, state);
  };
  const applyGroupOpen = (name, isOpen) => {
    isOpen ? state.groupFold.delete(name) : state.groupFold.add(name);
    drawBoard(plugin, board, config, state);
  };
  // Slim header: lane count. The lanes themselves render in the body as cards
  // (collapsed) or full boards (expanded).
  if (config.lane && lanes.length > 1) {
    const picker = board.createDiv({ cls: 'bdb-kanban-picker' });
    const head = picker.createDiv({ cls: 'bdb-kanban-picker-head' });
    const selN = state.selectedLanes ? state.selectedLanes.size : lanes.length;
    head.createSpan({ cls: 'bdb-kanban-picker-title', text: `Lanes ${selN}/${lanes.length}` });
  }

  // Body holds the lanes/columns. With lanes, it's a vertical list: one clickable
  // row per lane; clicking a row expands its board directly below it.
  const body = board.createDiv({ cls: 'bdb-kanban-body' });
  body.classList.toggle('bdb-kanban-lanelist', !!config.lane || !!config.groupby);

  // A lane row: hide checkbox, caret, name, next/open/done counts, stalled flag,
  // and a per-column distribution. Click toggles its board open/closed below.
  const renderAggregateRow = (parent, item, opts = {}) => {
    const on = opts.group ? !state.groupFold.has(item.name) : state.openLanes.has(norm(item.name));
    const stalled = item.open > 0 && item.actionable === 0;
    const row = parent.createDiv({ cls: opts.cls + (on ? ' is-open' : '') + (stalled ? ' is-stalled' : '') });
    const caret = row.createSpan({ cls: 'bdb-kanban-lanerow-caret' });
    setIcon(caret, on ? 'chevron-down' : 'chevron-right');
    row.createSpan({ cls: 'bdb-kanban-lanerow-name', text: item.name });
    const meta = row.createSpan({ cls: 'bdb-kanban-lanerow-meta' });
    if (stalled) meta.createSpan({ cls: 'bdb-kanban-picker-warn', text: 'stalled' });
    else meta.createSpan({ cls: 'bdb-kanban-lanerow-ok', text: `${item.actionable} next` });
    meta.createSpan({ cls: 'bdb-kanban-lanerow-tot', text: `${item.open} open${item.done ? ` · ${item.done} done` : ''}` });
    const dist = row.createDiv({ cls: 'bdb-kanban-lanerow-dist' });
    dist.style.setProperty('--bdb-kanban-lane-cols', String(config.columns.length));
    for (const [index, col] of config.columns.entries()) {
      const n = item.cards.get(col.key).length;
      const chip = dist.createSpan({ cls: 'bdb-kanban-lanerow-chip' + (n ? '' : ' is-zero') });
      chip.createSpan({ cls: 'bdb-kanban-lanerow-dot' }).style.background = columnColor(config, col, index);
      chip.createSpan({ text: `${col.name} ${n}` });
    }
    row.addEventListener('click', () => opts.group ? applyGroupOpen(item.name, !on) : applyOpen(item.name, !on));
  };
  const renderLaneRow = (parent, lane) => {
    const on = state.openLanes.has(norm(lane.name));
    const stalled = lane.open > 0 && lane.actionable === 0;
    const row = parent.createDiv({ cls: 'bdb-kanban-lanerow' + (on ? ' is-open' : '') + (stalled ? ' is-stalled' : '') });
    const caret = row.createSpan({ cls: 'bdb-kanban-lanerow-caret' });
    setIcon(caret, on ? 'chevron-down' : 'chevron-right');
    row.createSpan({ cls: 'bdb-kanban-lanerow-name', text: lane.name });
    const meta = row.createSpan({ cls: 'bdb-kanban-lanerow-meta' });
    if (stalled) meta.createSpan({ cls: 'bdb-kanban-picker-warn', text: 'stalled' });
    else meta.createSpan({ cls: 'bdb-kanban-lanerow-ok', text: `${lane.actionable} next` });
    meta.createSpan({ cls: 'bdb-kanban-lanerow-tot', text: `${lane.open} open${lane.done ? ` · ${lane.done} done` : ''}` });
    const dist = row.createDiv({ cls: 'bdb-kanban-lanerow-dist' });
    dist.style.setProperty('--bdb-kanban-lane-cols', String(config.columns.length));
    for (const [index, col] of config.columns.entries()) {
      const n = lane.cards.get(col.key).length;
      const chip = dist.createSpan({ cls: 'bdb-kanban-lanerow-chip' + (n ? '' : ' is-zero') });
      chip.createSpan({ cls: 'bdb-kanban-lanerow-dot' }).style.background = columnColor(config, col, index);
      chip.createSpan({ text: `${col.name} ${n}` });
    }
    row.addEventListener('click', () => applyOpen(lane.name, !on));
  };

  // Shared move path for HTML5 drop and mobile tap-to-move. Returns true if a
  // move happened. Enforces the terminal-column blocker rule for both.
  const tryDrop = async (path, lineStr, fromKey, col, foldKey) => {
    if (!path || fromKey === col.key) return false;
    const file = plugin.app.vault.getAbstractFileByPath(path);
    if (!file) return false;
    state.dragging = false;
    if (col.state) {
      const dragged = [...cards.values()].flat().find(c => c.file.path === path && c.line === Number(lineStr));
      const blockers = dragged ? openDescendants(dragged) : 0;
      if (blockers) {
        new Notice(`kanban: ${blockers} open sub-task${blockers > 1 ? 's' : ''} — close them first`);
        return false;
      }
    }
    await moveCard(plugin.app, file, Number(lineStr), col, config, {
      fromCol: config.columns.find(c => c.key === fromKey),
    });
    state.selfWriteAt = Date.now(); // our own write — skip the echoed vault-modify redraw
    state.colFold.delete(foldKey); // a drop reopens the column; refolding is the user's call
    return true;
  };

  for (const group of laneGroups) {
    if (config.groupby) renderAggregateRow(body, group, { cls: 'bdb-kanban-lanerow bdb-kanban-grouprow', group: true });
    if (config.groupby && state.groupFold.has(group.name)) continue;
    for (const lane of group.lanes) {
      if (config.lane) renderLaneRow(body, lane); // the clickable row (always shown)
      // Collapsed lane: row only. Expanded lane (or the anonymous no-lane board)
      // renders its columns full-width directly below the row.
      if (config.lane && !state.openLanes.has(norm(lane.name))) continue;
      const host = lane.name != null || config.groupby
        ? body.createDiv({ cls: 'bdb-kanban-lane-open bdb-kanban-lane-row' })
        : body;

      for (const [index, col] of config.columns.entries()) {
      if (config.only.length && !config.only.includes(col.key)) continue;
      const colCards = lane.cards.get(col.key);
      const colEl = host.createDiv({ cls: 'bdb-kanban-col' });
      if (col.live) colEl.classList.add('bdb-kanban-col-live');
      colEl.style.setProperty('--kb-col-color', columnColor(config, col, index));

      // Fold: column collapses to a vertical strip (still a drop target).
      // Empty columns auto-fold; a manual toggle overrides until the next
      // drop into the column clears it. Keyed per lane.
      const foldKey = `${lane.group ?? ''}::${lane.name ?? ''}::${col.key}`;
      const folded = state.colFold.get(foldKey) ?? (config.autoFold && !colCards.length);
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
        // Terminal columns refuse parents with open children (handled in tryDrop).
        if (await tryDrop(path, lineStr, fromKey, col, foldKey)) await drawBoard(plugin, board, config, state);
      });

      // Mobile has no HTML5 drag events: tap a picked card here to drop it.
      if (Platform.isMobile) colEl.addEventListener('click', async (e) => {
        if (!state.picked || e.target.closest('.bdb-kanban-card')) return;
        const p = state.picked;
        const moved = await tryDrop(p.path, p.line, p.fromKey, col, foldKey);
        if (moved) state.picked = null;
        if (moved) await drawBoard(plugin, board, config, state);
      });

      // Parents float to the top, children and singles below one separator.
      const parents = folded ? [] : colCards.filter(c => c.children.length);
      const leaves = folded ? [] : colCards.filter(c => !c.children.length);
      for (const card of [...parents, ...leaves]) {
        if (parents.length && leaves.length && card === leaves[0]) list.createDiv({ cls: 'bdb-kanban-sep' });
        const cardEl = list.createDiv({ cls: 'bdb-kanban-card', attr: { draggable: 'true' } });
        const kbcolor = card.color || app.metadataCache.getFileCache(card.file)?.frontmatter?.kbcolor;
        if (kbcolor) { cardEl.classList.add('bdb-kanban-card-tinted'); cardEl.style.setProperty('--kb-card-color', kbcolor); }
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

        // Copy the clean task text without leaving the board.
        const copyBtn = cardEl.createSpan({ cls: 'bdb-kanban-card-copy', attr: { 'aria-label': 'Copy task' } });
        setIcon(copyBtn, 'copy');
        copyBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await navigator.clipboard.writeText(cleanText(card.body));
          setIcon(copyBtn, 'check');
          copyBtn.classList.add('bdb-kanban-card-copied');
          window.setTimeout(() => { setIcon(copyBtn, 'copy'); copyBtn.classList.remove('bdb-kanban-card-copied'); }, 1200);
        });

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

        if (config.mode === 'habits') {
          const { habitStats, fmtHours } = require('./habits');
          const fm = app.metadataCache.getFileCache(card.file)?.frontmatter || {};
          const metric = fm.metric === 'count' ? 'count' : 'sum';
          const st = habitStats(card.history, metric, new Date());
          const foot = cardEl.createDiv({ cls: 'bdb-kanban-card-habit' });
          if (!st) { foot.createSpan({ text: 'no logs yet' }); }
          else {
            const f = (v) => metric === 'count'
              ? (Number.isInteger(v) ? `${v}` : v.toFixed(1)) + 'x'
              : fmtHours(v);
            const arrow = st.trend > 0.05 ? '↑' : st.trend < -0.05 ? '↓' : '→';
            foot.setAttribute('title',
              `min ${f(st.min)} · mean ${f(st.mean)} · max ${f(st.max)} · ${st.days}d logged`);
            foot.createSpan({ cls: 'bdb-kanban-habit-trend', text: arrow });
            if (st.open) foot.createSpan({ cls: 'bdb-kanban-habit-live', text: '● live' });
            foot.createSpan({ cls: 'bdb-kanban-habit-stat', text: `today ${f(st.today)}` });
            foot.createSpan({ cls: 'bdb-kanban-habit-sep', text: '·' });
            foot.createSpan({ cls: 'bdb-kanban-habit-stat', text: `7d ${f(st.avg7)}` });
            foot.createSpan({ cls: 'bdb-kanban-habit-sep', text: '·' });
            foot.createSpan({ cls: 'bdb-kanban-habit-stat', text: `${st.streak}d streak` });
          }
        } else if (card.history.length) {
          const es = card.history.slice().sort((a, b) => a.stamp.localeCompare(b.stamp));
          const colorOf = new Map(config.columns.map((c, i) => [c.name, columnColor(config, c, i)]));
          const idle = new Set(config.columns.filter(c => c.paused).map(c => c.name));
          const terminal = !!col.state; // terminal clocks freeze: done is done, not "still doing done"

          // A task is born when its note is: YYYYMMDD-HHmm filename convention.
          const birthM = card.file.name.match(/^(\d{8})-(\d{4})/);
          const birth = birthM ? stampToDate(birthM[1] + birthM[2]) : null;

          // Visits: every stay in a column, starting at birth when known.
          const visits = [];
          if (birth) {
            const start = birth.getTime();
            const end = stampToDate(es[0].stamp).getTime();
            visits.push({ name: es[0].from, start, end, dur: Math.max(end - start, 0) });
          }
          for (let i = 0; i < es.length; i++) {
            const isLast = i === es.length - 1;
            if (isLast && terminal) break;
            const start = stampToDate(es[i].stamp).getTime();
            const end = (isLast ? new Date() : stampToDate(es[i + 1].stamp)).getTime();
            visits.push({ name: es[i].to, start, end, dur: end - start });
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

          // Single bar: full timeline (idle included). Each span = one column stay.
          const bars = flow.createDiv({ cls: 'bdb-kanban-card-bars' });
          const bar = bars.createDiv({ cls: 'bdb-kanban-card-bar' });
          for (const v of visits) {
            const span = bar.createSpan();
            span.style.flexGrow = String(Math.max(v.dur, 1));
            span.style.background = colorOf.get(v.name) || 'var(--background-modifier-border)';
            span.setAttribute('title', `${v.name}: ${hhmmMs(v.start)}-${hhmmMs(v.end)} · ${fmtDurCompact(v.dur)}`);
            if (v === liveVisit) span.classList.add('bdb-kanban-live-span');
          }

          const nowEl = flow.createSpan({
            cls: 'bdb-kanban-card-now',
            text: terminal
              ? `${fmtDur(active)} spent · ${fmtDur(total)} total`
              : (since == null ? col.name : `${col.name} ${fmtDur(since)} · ${fmtDur(active)} spent`),
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
            const activeBase = active - (idle.has(col.name) ? 0 : liveVisit.dur);
            state.timeUpdaters.push(() => {
              const ms = Date.now() - startMs;
              const act = activeBase + (idle.has(col.name) ? 0 : ms);
              nowEl.textContent = `${col.name} ${fmtDur(ms)} · ${fmtDur(act)} spent`;
              for (const sp of cardEl.querySelectorAll('.bdb-kanban-live-span')) {
                sp.style.flexGrow = String(Math.max(ms, 1));
                sp.setAttribute('title', `${col.name}: ${hhmmMs(startMs)}-${hhmmMs(Date.now())} · ${fmtDurCompact(ms)}`);
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

        // Mobile tap-to-move: tap card to pick, tap again to cancel, tap a
        // column to drop. Ignore taps on links/meta/crumb so they still work.
        if (Platform.isMobile) cardEl.addEventListener('click', (e) => {
          if (e.target.closest('a, .bdb-kanban-card-meta, .bdb-kanban-card-crumb')) return;
          e.stopPropagation();
          const wasPicked = state.picked && state.picked.el === cardEl;
          board.querySelectorAll('.bdb-kanban-picked').forEach(el => el.classList.remove('bdb-kanban-picked'));
          if (wasPicked) { state.picked = null; return; }
          state.picked = { el: cardEl, path: card.file.path, line: card.line, fromKey: col.key };
          state.card = card;
          cardEl.classList.add('bdb-kanban-picked');
        });
        cardEl.querySelector('.bdb-kanban-card-meta').addEventListener('click', (e) => {
          openFileAtLine(plugin.app, card.file, card.line, e.ctrlKey || e.metaKey);
        });
      }
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
    // Adjusting column heights reflows the note; capture the page scroll so the
    // re-fit (and the 400ms/2s refits) don't yank the viewport — the "jump".
    const scroller = board.closest('.markdown-preview-view, .cm-scroller, .view-content');
    const savedTop = scroller ? scroller.scrollTop : null;
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
    if (scroller && savedTop != null) scroller.scrollTop = savedTop;
  };
  // SUNSET: the dynamic percentile-fit (above) caused reflow jitter. Columns now
  // use a fixed max-height from CSS (--bdb-kanban-col-h). `fit` is kept for
  // reference / a future opt-in but is no longer called.
  void fit;
}

module.exports = {
  parseKanbanConfig, scanKanbanTasks, moveCard, logTapSpan, renderKanbanBlock, drawBoard,
  resolveKanbanConfig, editTags, tagLineAt, commentInsertAt,
  openDescendants, cleanText, addTitleCopy, stampNow, stampToDate, stampDigits, stampWrite, fmtDur, TASK_RE, STAMP_RE,
  TAGLINE_RE, COLOR_RE, HIST_RE, EI_HIST_RE, terminalStamp,
  columnColor, colKey,
};
