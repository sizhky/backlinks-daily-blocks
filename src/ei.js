// ```ei``` block: triage chute over one kanban column. Tray (the `from`
// column, default first open) plus configurable doors, each a real board
// move — sweep grammar, per card:
//     doors:
//       Do > Todo
//       Delegate > Waiting +who
//       Delete > Cancelled
// +who asks for a person and appends a [[wikilink]] to the tag line.
// No priority labels: a triage decision that changes nothing is clutter.

const { MarkdownRenderChild, Notice, Modal } = require('obsidian');
const { renderInteractive, openFileAtLine } = require('./core/render');
const {
  scanKanbanTasks, moveCard, resolveKanbanConfig, editTags,
  openDescendants, columnColor, colKey, TASK_RE, STAMP_RE,
} = require('./kanban');

// "Do > Todo +who" specs, split on newlines or commas.
function parseDoors(text) {
  const out = [];
  for (const part of (text || '').split(/[,\n]/)) {
    let spec = part.trim();
    if (!spec) continue;
    const who = /\s\+who\b/.test(spec);
    spec = spec.replace(/\s\+who\b/, '').trim();
    const [name, target] = spec.split('>').map(s => s.trim());
    if (name && target) out.push({ name, target: colKey(target), who });
  }
  return out;
}

// Block keys: paths (overrides kanban paths), from (tray column, default
// first open), doors. Settings supply defaults; block wins.
function resolveEiConfig(plugin, src) {
  const config = { paths: [], from: null, doors: [] };
  let lastKey = null;
  for (const rawLine of (src || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^(paths|from|doors)\s*:\s*(.*)$/);
    const key = m ? m[1] : lastKey;
    const value = m ? m[2].trim() : line;
    lastKey = key;
    if (!key || !value) continue;
    if (key === 'from') config.from = value;
    else if (key === 'doors') config.doors.push(...parseDoors(value));
    else config.paths.push(...value.split(',').map(s => s.trim()).filter(Boolean));
  }
  const d = plugin.settings?.ei || {};
  if (!config.paths.length && d.paths) config.paths = d.paths.split(',').map(s => s.trim()).filter(Boolean);
  if (!config.from && d.from) config.from = d.from;
  if (!config.doors.length) config.doors = parseDoors(d.doors || 'Do > Todo\nDelegate > Waiting +who\nDelete > Cancelled');
  return config;
}

// Tag-line edit on one card: strip leftover #ei labels (pre-doors residue),
// optionally append a [[who]] wikilink.
async function editCardTags(app, card, who) {
  const lines = (await app.vault.read(card.file)).split(/\r?\n/);
  if (!TASK_RE.test(lines[card.line] || '')) return false;
  editTags(lines, card.line, tokens => {
    const out = tokens.filter(t => !t.startsWith('#ei/'));
    if (who && !out.includes(`[[${who}]]`)) out.push(`[[${who}]]`);
    return out;
  });
  await app.vault.modify(card.file, lines.join('\n'));
  return true;
}

function askWho(app) {
  return new Promise(resolve => {
    const modal = new Modal(app);
    let done = false;
    modal.titleEl.setText('Delegate to');
    const input = modal.contentEl.createEl('input', {
      type: 'text', attr: { placeholder: 'Person — becomes a [[wikilink]]' },
    });
    input.style.width = '100%';
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && input.value.trim()) {
        done = true;
        const v = input.value.trim();
        modal.close();
        resolve(v);
      }
    });
    modal.onClose = () => { if (!done) resolve(null); };
    modal.open();
    window.setTimeout(() => input.focus(), 0);
  });
}

async function renderEiBlock(plugin, src, el, ctx) {
  el.empty();
  const root = el.createDiv({ cls: 'bdb-ei' });
  const state = { dragging: false };
  const redraw = () => { if (!state.dragging) drawEi(plugin, root, src, state); };

  const child = new MarkdownRenderChild(el);
  ctx.addChild(child);
  child.registerInterval(window.setInterval(redraw, 60000));
  let pending = null;
  child.registerEvent(plugin.app.vault.on('modify', () => {
    window.clearTimeout(pending);
    pending = window.setTimeout(redraw, 500);
  }));

  await drawEi(plugin, root, src, state);
}

async function drawEi(plugin, root, src, state) {
  root.empty();
  const app = plugin.app;
  const ei = resolveEiConfig(plugin, src);
  const kb = resolveKanbanConfig(plugin, '');
  if (ei.paths.length) kb.paths = ei.paths;

  const open = kb.columns.filter(c => !c.state);
  const first = ei.from
    ? open.find(c => c.key === colKey(ei.from))
    : open[0];
  if (!first) {
    root.createDiv({ text: `ei: no open kanban column${ei.from ? ` named "${ei.from}"` : ''}` });
    return;
  }
  const doors = ei.doors.map(d => ({ ...d, col: kb.columns.find(c => c.key === d.target) || null }));

  const backlog = (await scanKanbanTasks(app, kb)).get(first.key) || [];

  const tray = root.createDiv({ cls: 'bdb-ei-zone bdb-ei-tray' });
  tray.style.setProperty('--ei-color', columnColor(kb, first, kb.columns.indexOf(first)));
  tray.createDiv({ cls: 'bdb-ei-zone-title', text: `${first.name} (${backlog.length})` });
  const trayList = tray.createDiv({ cls: 'bdb-ei-cards' });
  tray.createDiv({ cls: 'bdb-ei-hint', text: 'drag right to decide' });
  for (const card of backlog) await eiCard(plugin, trayList, card, state);

  const grid = root.createDiv({ cls: 'bdb-ei-grid' });
  for (const door of doors) {
    const zoneEl = grid.createDiv({ cls: 'bdb-ei-zone' });
    zoneEl.style.setProperty('--ei-color',
      door.col ? columnColor(kb, door.col, kb.columns.indexOf(door.col)) : 'var(--text-faint)');
    zoneEl.createDiv({ cls: 'bdb-ei-zone-title', text: door.name });
    zoneEl.createDiv({ cls: 'bdb-ei-cards' });
    zoneEl.createDiv({
      cls: 'bdb-ei-hint',
      text: door.col
        ? `${door.who ? 'who? ' : ''}→ ${door.col.name}${door.col.state ? ` [${door.col.state}]` : ''}`
        : `no "${door.target}" column on the kanban`,
    });

    zoneEl.addEventListener('dragover', e => {
      e.preventDefault();
      zoneEl.classList.add('bdb-ei-over');
    });
    zoneEl.addEventListener('dragleave', () => zoneEl.classList.remove('bdb-ei-over'));
    zoneEl.addEventListener('drop', async e => {
      e.preventDefault();
      zoneEl.classList.remove('bdb-ei-over');
      state.dragging = false;
      const [path, lineStr] = (e.dataTransfer.getData('text/plain') || '').split('::');
      const card = backlog.find(c => c.file.path === path && c.line === Number(lineStr));
      if (!card) return;
      if (!door.col) { new Notice(`ei: add a "${door.target}" column to your kanban first`); return; }
      if (door.col.state && openDescendants(card) > 0) {
        new Notice('ei: open sub-tasks — close them first');
        return;
      }
      let who = null;
      if (door.who) {
        who = await askWho(app);
        if (who == null) return;
      }
      await editCardTags(app, card, who);
      await moveCard(app, card.file, card.line, door.col, kb, { fromCol: first });
      await drawEi(plugin, root, src, state);
    });
  }
}

async function eiCard(plugin, list, card, state) {
  const cardEl = list.createDiv({ cls: 'bdb-ei-card', attr: { draggable: 'true' } });
  const display = card.body.replace(/#[\w/-]+/g, '').replace(STAMP_RE, '').replace(/\s{2,}/g, ' ').trim();
  await renderInteractive(plugin, display, cardEl.createDiv({ cls: 'bdb-kanban-card-text' }), card.file.path);

  if (card.who.length) {
    const whoEl = cardEl.createDiv({ cls: 'bdb-ei-who' });
    for (const name of card.who) whoEl.createSpan({ cls: 'bdb-ei-who-pill', text: name });
  }

  const meta = cardEl.createDiv({ cls: 'bdb-kanban-card-meta', text: card.file.basename });
  meta.addEventListener('click', e => openFileAtLine(plugin.app, card.file, card.line, e.ctrlKey || e.metaKey));

  cardEl.addEventListener('dragstart', e => {
    state.dragging = true;
    e.dataTransfer.setData('text/plain', `${card.file.path}::${card.line}`);
    e.dataTransfer.effectAllowed = 'move';
  });
  cardEl.addEventListener('dragend', () => { state.dragging = false; });
}

module.exports = { renderEiBlock, resolveEiConfig, parseDoors };
