const { ItemView, Menu, Notice, setIcon } = require('obsidian');
const {
  cleanText, resolveKanbanConfig, scanKanbanTasks, moveCard, stampToDate, columnColor,
} = require('../kanban');
const { renderInteractive, openFileAtLine } = require('../core/render');

const DOING_VIEW_TYPE = 'bdb-doing';

function elapsed(date) {
  const total = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (!date || !Number.isFinite(total)) return '--:--:--';
  const days = Math.floor(total / 86400);
  const hours = String(Math.floor(total / 3600) % 24).padStart(2, '0');
  const minutes = String(Math.floor(total / 60) % 60).padStart(2, '0');
  const seconds = String(total % 60).padStart(2, '0');
  return `${days ? `${days}d ` : ''}${hours}:${minutes}:${seconds}`;
}

function cardTime(card) {
  const last = card.history.slice().sort((a, b) => b.stamp.localeCompare(a.stamp))[0];
  if (last) return stampToDate(last.stamp);
  const daily = card.file.basename.match(/^(\d{8})-(\d{4})/);
  return daily ? stampToDate(daily[1] + daily[2]) : new Date(card.file.stat.ctime);
}

function taskEmojis(cards) {
  const found = new Set();
  const text = cards.map(item => item.card.body).join(' ');
  const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text);
  for (const { segment } of segments) {
    if (/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(segment)) found.add(segment);
  }
  return [...found].join(' ');
}

class DoingView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.collapsed = new Set();
  }

  getViewType() { return DOING_VIEW_TYPE; }
  getDisplayText() { return 'Tasks'; }
  getIcon() { return 'list-checks'; }

  async onOpen() {
    this.registerEvent(this.app.vault.on('modify', () => this.draw()));
    this.registerEvent(this.app.vault.on('create', () => this.draw()));
    this.registerEvent(this.app.vault.on('delete', () => this.draw()));
    this.registerEvent(this.app.vault.on('rename', () => this.draw()));
    this.registerInterval(window.setInterval(() => this.tick(), 1000));
    this.registerInterval(window.setInterval(() => this.draw(), 60000));
    await this.draw();
  }

  tick() {
    for (const clock of this.clocks || []) clock.el.setText(elapsed(clock.date));
  }

  config() {
    const config = resolveKanbanConfig(this.plugin, '', null);
    config.maxage = 0;
    return config;
  }

  async recentGroups(config) {
    const byCol = await scanKanbanTasks(this.app, config);
    const hours = Math.max(1, Number(this.plugin.settings.views.recentHours) || 24);
    const cutoff = Date.now() - hours * 3600000;
    const doing = config.columns.find(col => col.key === 'doing');
    const columns = doing ? [doing, ...config.columns.filter(col => col !== doing)] : config.columns;
    return {
      hours,
      groups: columns.map((col, index) => ({
        col,
        index,
        cards: (byCol.get(col.key) || [])
          .map(card => ({ card, date: cardTime(card) }))
          .filter(item => item.date.getTime() >= cutoff)
          .sort((a, b) => b.date - a.date),
      })),
    };
  }

  async moveTask(card, fromCol, toCol, config) {
    if (!card || fromCol === toCol) return false;
    const moved = await moveCard(this.app, card.file, card.line, toCol, config, { fromCol });
    new Notice(moved ? `Task moved to ${toCol.name}` : 'Task could not be moved');
    if (moved) this.collapsed.delete(toCol.key);
    await this.draw();
    return moved;
  }

  showMoveMenu(event, card, fromCol, config) {
    event.preventDefault();
    const menu = new Menu().setUseNativeMenu(false);
    for (const col of config.columns.filter(col => col !== fromCol)) {
      menu.addItem(item => item
        .setTitle(`Move to ${col.name}`)
        .setIcon(col.state ? 'check-circle-2' : 'arrow-right')
        .onClick(() => this.moveTask(card, fromCol, col, config)));
    }
    menu.showAtMouseEvent(event);
  }

  startDrag(event, task, card, fromCol) {
    this.dragged = { card, fromCol };
    task.addClass('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', `${card.file.path}::${card.line}::${fromCol.key}`);
    const ghost = task.cloneNode(true);
    ghost.addClass('bdb-task-drag-ghost');
    ghost.style.width = `${Math.round(task.getBoundingClientRect().width)}px`;
    task.ownerDocument.body.appendChild(ghost);
    event.dataTransfer.setDragImage(ghost, 22, 22);
    window.setTimeout(() => ghost.remove(), 0);
  }

  wireDropTarget(section, toCol, config) {
    const accepts = () => this.dragged && this.dragged.fromCol !== toCol;
    section.addEventListener('dragover', event => {
      if (!accepts()) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      section.addClass('is-drop-target');
    });
    section.addEventListener('dragleave', event => {
      if (!section.contains(event.relatedTarget)) section.removeClass('is-drop-target');
    });
    section.addEventListener('drop', async event => {
      event.preventDefault();
      section.removeClass('is-drop-target');
      const dragged = this.dragged;
      this.dragged = null;
      if (dragged && dragged.fromCol !== toCol) {
        await this.moveTask(dragged.card, dragged.fromCol, toCol, config);
      }
    });
  }

  collapseButton(toolbar, groups) {
    const keys = groups.filter(group => group.col.key !== 'doing').map(group => group.col.key);
    const allCollapsed = keys.every(key => this.collapsed.has(key));
    const button = toolbar.createEl('button', {
      cls: 'clickable-icon bdb-task-collapse-all',
      attr: { 'aria-label': allCollapsed ? 'Expand all sections' : 'Collapse all sections' },
    });
    setIcon(button, allCollapsed ? 'unfold-vertical' : 'fold-vertical');
    button.addEventListener('click', () => {
      for (const key of keys) allCollapsed ? this.collapsed.delete(key) : this.collapsed.add(key);
      this.draw();
    });
  }

  sectionHeader(section, group) {
    const { col, cards } = group;
    const doing = col.key === 'doing';
    const head = section.createDiv({
      cls: `bdb-task-section-head${doing ? ' is-doing' : ''}`,
      attr: doing ? {} : {
        role: 'button', tabindex: '0',
        'aria-expanded': String(!this.collapsed.has(col.key)),
      },
    });
    const caret = head.createSpan({
      cls: `bdb-task-section-caret${doing ? ' is-spacer' : ''}`,
      attr: doing ? { 'aria-hidden': 'true' } : {},
    });
    if (!doing) {
      setIcon(caret, this.collapsed.has(col.key) ? 'chevron-right' : 'chevron-down');
    }
    head.createSpan({ cls: 'bdb-task-section-title', text: col.name });
    head.createSpan({ cls: 'bdb-doing-count', text: String(cards.length) });
    const meta = head.createSpan({ cls: 'bdb-task-section-meta' });
    const emojis = taskEmojis(cards);
    if (emojis) meta.createSpan({ cls: 'bdb-task-section-emojis', text: emojis });
    if (doing) {
      const live = meta.createSpan({ cls: 'bdb-doing-live' });
      live.createSpan({ cls: 'bdb-doing-live-dot' });
      live.createSpan({ text: 'LIVE' });
    } else {
      const toggle = () => {
        this.collapsed.has(col.key) ? this.collapsed.delete(col.key) : this.collapsed.add(col.key);
        this.draw();
      };
      head.addEventListener('click', toggle);
      head.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        toggle();
      });
    }
  }

  async taskCard(parent, item, col, config, drawVersion) {
    const { card, date } = item;
    const task = parent.createDiv({
      cls: 'bdb-doing-item',
      attr: { role: 'button', tabindex: '0', draggable: 'true' },
    });
    task.setAttr('title', 'Drag or right-click to move');
    await renderInteractive(this.plugin, cleanText(card.body), task.createDiv({ cls: 'bdb-doing-task' }), card.file.path);
    if (drawVersion !== this.drawVersion) return false;
    if (col.key === 'doing') {
      const clock = task.createSpan({ cls: 'bdb-doing-clock', text: elapsed(date) });
      clock.setAttr('aria-label', 'Time in Doing');
      clock.setAttr('title', `In Doing since ${date.toLocaleString()}`);
      this.clocks.push({ el: clock, date });
    }
    const open = event => openFileAtLine(this.app, card.file, card.line, event.metaKey || event.ctrlKey);
    task.addEventListener('click', event => { if (!event.target.closest('a')) open(event); });
    task.addEventListener('contextmenu', event => this.showMoveMenu(event, card, col, config));
    task.addEventListener('dragstart', event => this.startDrag(event, task, card, col));
    task.addEventListener('dragend', () => {
      task.removeClass('is-dragging');
      this.dragged = null;
      for (const target of this.contentEl.querySelectorAll('.is-drop-target')) target.removeClass('is-drop-target');
    });
    task.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      open(event);
    });
    return true;
  }

  async draw() {
    const drawVersion = (this.drawVersion || 0) + 1;
    this.drawVersion = drawVersion;
    const config = this.config();
    const { hours, groups } = await this.recentGroups(config);
    if (drawVersion !== this.drawVersion) return;
    const root = this.contentEl;
    root.empty();
    root.addClass('bdb-doing-view');
    this.clocks = [];

    const toolbar = root.createDiv({ cls: 'bdb-task-toolbar' });
    toolbar.createSpan({ text: `Last ${hours}h` });
    this.collapseButton(toolbar, groups);

    for (const group of groups) {
      const section = root.createDiv({ cls: 'bdb-task-section' });
      section.style.setProperty('--bdb-section-color', columnColor(config, group.col, group.index));
      this.wireDropTarget(section, group.col, config);
      this.sectionHeader(section, group);
      if (group.col.key !== 'doing' && this.collapsed.has(group.col.key)) continue;
      const body = section.createDiv({ cls: 'bdb-task-section-body' });
      if (!group.cards.length) body.createDiv({ cls: 'bdb-doing-empty', text: 'No recent tasks' });
      for (const item of group.cards) {
        if (!await this.taskCard(body, item, group.col, config, drawVersion)) return;
      }
    }
  }
}

module.exports = { DoingView, DOING_VIEW_TYPE };
