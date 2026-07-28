const { Plugin, Notice, SuggestModal } = require('obsidian');
const { renderBacklinksBlock, renderDailyBlock } = require('./blocks');
const { renderKanbanBlock, parseKanbanConfig, moveCard, TASK_RE, HIST_RE } = require('./kanban');
const { renderEiBlock } = require('./ei');
const { renderReportBlock } = require('./report');
const { renderHabitsBlock, renderHabitPad } = require('./habits');
const { buildApi } = require('./api');
const { saveTemplateCommand } = require('./templates');
const { BdbSettingTab, mergeSettings } = require('./settings');
const { ChronicleView, CHRONICLE_VIEW_TYPE } = require('./views/chronicle');
const { AtlasView, ATLAS_VIEW_TYPE } = require('./views/atlas');
const { LedgerView, LEDGER_VIEW_TYPE } = require('./views/ledger');
const { BeaconView, BEACON_VIEW_TYPE } = require('./views/beacon');
const { DoingView, DOING_VIEW_TYPE } = require('./views/doing');
const { KanbanView, KANBAN_VIEW_TYPE } = require('./views/kanban');

function taskMeta(lines, line) {
  const histories = new Set();
  let tag = (lines[line].match(/#kb\/([\w-]+)/) || [])[1];
  for (let i = line + 1; i < lines.length && !TASK_RE.test(lines[i]); i++) {
    const history = lines[i].match(HIST_RE)?.[0];
    if (history) histories.add(history);
    tag ||= (lines[i].match(/#kb\/([\w-]+)/) || [])[1];
  }
  return { histories, tag };
}

class TaskColumnSuggest extends SuggestModal {
  constructor(plugin, file, line, config, fromCol) {
    super(plugin.app);
    this.file = file;
    this.line = line;
    this.config = config;
    this.fromCol = fromCol;
    this.setPlaceholder('Move task to…');
  }

  getSuggestions(query) {
    const q = query.trim().toLowerCase();
    return this.config.columns.filter(col => col.name.toLowerCase().includes(q));
  }

  renderSuggestion(col, el) {
    el.setText(col === this.fromCol ? `${col.name} (current)` : col.name);
  }

  async onChooseSuggestion(col) {
    if (col === this.fromCol) return;
    const moved = await moveCard(this.app, this.file, this.line, col, this.config, { fromCol: this.fromCol });
    new Notice(moved ? `Task moved to ${col.name}` : 'Task could not be moved');
  }
}

class BacklinksDailyBlocksPlugin extends Plugin {
  async onload() {
    this.settings = mergeSettings(await this.loadData());
    this.api = buildApi(this);
    globalThis.kb = this.api; // CLI shortcut: obsidian eval code='kb.active({limit:3})'
    this.addSettingTab(new BdbSettingTab(this));
    this.registerView(DOING_VIEW_TYPE, leaf => new DoingView(leaf, this));
    this.addCommand({
      id: 'open-doing-view',
      name: 'Open recent tasks',
      callback: async () => {
        const leaf = this.app.workspace.getLeavesOfType(DOING_VIEW_TYPE)[0] || this.app.workspace.getLeaf('tab');
        await leaf.setViewState({ type: DOING_VIEW_TYPE, active: true });
        this.app.workspace.revealLeaf(leaf);
      },
    });

    this.taskSnapshots = new Map();
    this.taskWrites = new Set();
    this.editorSnapshots = new WeakMap();
    const remember = async (file) => {
      if (file?.extension === 'md') this.taskSnapshots.set(file.path, await this.app.vault.read(file));
    };
    const rememberEditor = (leaf) => {
      if (leaf?.view?.editor) this.editorSnapshots.set(leaf.view.editor, leaf.view.editor.getValue());
    };
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      remember(leaf.view.file);
      rememberEditor(leaf);
    }
    this.registerEvent(this.app.workspace.on('file-open', file => remember(file)));
    this.registerEvent(this.app.workspace.on('active-leaf-change', rememberEditor));
    this.registerEvent(this.app.workspace.on('editor-change', (editor, info) => {
      this.closeEditorCheckedTasks(editor, info).catch(err => console.warn('backlinks-daily-blocks: close checked task failed', err));
    }));
    this.registerEvent(this.app.vault.on('modify', file => this.closeManuallyCheckedTasks(file)));

    this.addCommand({
      id: 'save-props-as-template',
      name: 'Save note properties as template',
      callback: () => saveTemplateCommand(this),
    });

    this.addCommand({
      id: 'move-task-under-cursor',
      name: 'Move task under cursor',
      hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'M' }],
      editorCallback: async (editor, view) => {
        const file = view.file;
        const line = editor.getCursor().line;
        const task = editor.getLine(line).match(TASK_RE);
        if (!file || !task) return new Notice('Cursor is not on a task');
        await view.save();
        const columns = this.settings.kanban.columns.split(/\r?\n/).map(x => `  ${x}`).join('\n');
        const config = parseKanbanConfig(`columns:\n${columns}`);
        const meta = taskMeta(editor.getValue().split(/\r?\n/), line);
        const fromCol = config.columns.find(col => col.state === task[2])
          || config.columns.find(col => col.key === meta.tag)
          || config.columns.find(col => !col.state);
        new TaskColumnSuggest(this, file, line, config, fromCol).open();
      },
    });

    // Normalize any groupBy entries stored as strings into object form
    // to avoid Bases parse errors. Runs once on load, rewrites affected .base files.
    this.normalizeBaseGroupBy().catch(err => console.warn('backlinks-daily-blocks: normalize groupBy failed', err));

    this.registerMarkdownCodeBlockProcessor('backlinks', (src, el, ctx) => {
      return renderBacklinksBlock(this, src, el, ctx);
    });

    this.registerMarkdownCodeBlockProcessor('daily', (src, el, ctx) => {
      return renderDailyBlock(this, src, el, ctx);
    });

    this.registerMarkdownCodeBlockProcessor('kanban', (src, el, ctx) => {
      return renderKanbanBlock(this, src, el, ctx);
    });

    this.registerMarkdownCodeBlockProcessor('ei', (src, el, ctx) => {
      return renderEiBlock(this, src, el, ctx);
    });

    this.registerMarkdownCodeBlockProcessor('report', (src, el, ctx) => {
      return renderReportBlock(this, src, el, ctx);
    });

    this.registerMarkdownCodeBlockProcessor('habits', (src, el, ctx) => {
      return renderHabitsBlock(this, src, el, ctx);
    });

    this.registerMarkdownCodeBlockProcessor('habit-pad', (src, el, ctx) => {
      return renderHabitPad(this, src, el, ctx);
    });

    this.registerBasesView(CHRONICLE_VIEW_TYPE, {
      name: 'Chronicle',
      icon: 'lucide-scroll-text',
      factory: (controller, containerEl) => new ChronicleView(this, controller, containerEl),
      options: () => ([
        {
          type: 'toggle',
          displayName: 'Strip frontmatter',
          key: 'stripFrontmatter',
          default: true,
        },
        {
          type: 'number',
          displayName: 'Truncate length',
          key: 'truncateLength',
          default: 0,
        },
        {
          type: 'text',
          displayName: 'Show property beside title',
          key: 'titleProperty',
          default: 'note.categories',
        },
      ]),
    });

    this.registerBasesView(ATLAS_VIEW_TYPE, {
      name: 'Atlas',
      icon: 'lucide-list-tree',
      factory: (controller, containerEl) => new AtlasView(this, controller, containerEl),
      options: () => ([
        {
          type: 'text',
          displayName: 'Property blacklist (comma-separated)',
          key: 'propertyBlacklist',
          default: 'file,journal,journal-date,aliases,captured-from',
        },
      ]),
    });

    this.registerBasesView(LEDGER_VIEW_TYPE, {
      name: 'Ledger',
      icon: 'lucide-check-square',
      factory: (controller, containerEl) => new LedgerView(this, controller, containerEl),
      options: () => ([
        {
          type: 'toggle',
          displayName: 'Include completed tasks',
          key: 'includeCompleted',
          default: true,
        },
        {
          type: 'text',
          displayName: 'Contains (case-insensitive)',
          key: 'contains',
          default: '',
        },
        {
          type: 'text',
          displayName: 'Group by property (optional)',
          key: 'taskGroupBy',
          default: '',
        },
        {
          type: 'toggle',
          displayName: 'Fold subgroups by default when grouped',
          key: 'foldSubgroups',
          default: true,
        },
      ]),
    });

    this.registerBasesView(KANBAN_VIEW_TYPE, {
      name: 'Kanban',
      icon: 'lucide-columns-3',
      factory: (controller, containerEl) => new KanbanView(this, controller, containerEl),
      options: () => ([]),
    });

    this.registerBasesView(BEACON_VIEW_TYPE, {
      name: 'Beacon',
      icon: 'lucide-flag',
      factory: (controller, containerEl) => new BeaconView(this, controller, containerEl),
      options: () => ([
        {
          type: 'text',
          displayName: 'Hashtags (comma-separated)',
          key: 'tags',
          default: '#win',
        },
      ]),
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
    for (const leaf of this.app.workspace.getLeavesOfType(DOING_VIEW_TYPE)) leaf.view.draw();
  }

  async closeManuallyCheckedTasks(file) {
    if (file?.extension !== 'md') return;
    const next = await this.app.vault.read(file);
    const previous = this.taskSnapshots.get(file.path);
    this.taskSnapshots.set(file.path, next);
    if (previous == null || this.taskWrites.has(file.path)) return;

    const before = previous.split(/\r?\n/);
    const after = next.split(/\r?\n/);
    const config = parseKanbanConfig(`columns:\n${this.settings.kanban.columns.split(/\r?\n/).map(x => `  ${x}`).join('\n')}`);
    const moves = [];
    for (let line = 0; line < Math.min(before.length, after.length); line++) {
      const oldTask = before[line].match(TASK_RE);
      const newTask = after[line].match(TASK_RE);
      const target = newTask && config.columns.find(col => col.state === newTask[2]);
      if (!oldTask || oldTask[2] !== ' ' || !target) continue;
      const oldMeta = taskMeta(before, line);
      const newMeta = taskMeta(after, line);
      if ([...newMeta.histories].some(history => !oldMeta.histories.has(history))) continue;
      const fromCol = config.columns.find(col => col.key === oldMeta.tag) || config.columns.find(col => !col.state);
      moves.push({ line, target, fromCol });
    }
    if (!moves.length) return;
    this.taskWrites.add(file.path);
    try {
      for (const move of moves.reverse()) await moveCard(this.app, file, move.line, move.target, config, { fromCol: move.fromCol });
      this.taskSnapshots.set(file.path, await this.app.vault.read(file));
    } finally {
      this.taskWrites.delete(file.path);
    }
  }

  async closeEditorCheckedTasks(editor, info) {
    const file = info?.file;
    const next = editor.getValue();
    const previous = this.editorSnapshots.get(editor);
    this.editorSnapshots.set(editor, next);
    if (!file || previous == null || this.taskWrites.has(file.path)) return;

    const before = previous.split(/\r?\n/);
    const after = next.split(/\r?\n/);
    const config = parseKanbanConfig(`columns:\n${this.settings.kanban.columns.split(/\r?\n/).map(x => `  ${x}`).join('\n')}`);
    const moves = [];
    for (let line = 0; line < Math.min(before.length, after.length); line++) {
      const oldTask = before[line].match(TASK_RE);
      const newTask = after[line].match(TASK_RE);
      const target = newTask && config.columns.find(col => col.state === newTask[2]);
      if (!oldTask || oldTask[2] !== ' ' || !target) continue;
      const oldMeta = taskMeta(before, line);
      const newMeta = taskMeta(after, line);
      if ([...newMeta.histories].some(history => !oldMeta.histories.has(history))) continue;
      const fromCol = config.columns.find(col => col.key === oldMeta.tag) || config.columns.find(col => !col.state);
      moves.push({ line, target, fromCol });
    }
    if (!moves.length || typeof info.save !== 'function') return;
    this.taskWrites.add(file.path);
    try {
      await info.save();
      for (const move of moves.reverse()) await moveCard(this.app, file, move.line, move.target, config, { fromCol: move.fromCol });
      this.taskSnapshots.set(file.path, await this.app.vault.read(file));
    } finally {
      this.taskWrites.delete(file.path);
    }
  }

  async normalizeBaseGroupBy(targetFile) {
    const files = targetFile ? [targetFile] : this.app.vault.getFiles().filter(f => f.extension === 'base');

    for (const file of files) {
      if (file.extension !== 'base') continue;

      let content;
      try {
        content = await this.app.vault.read(file);
      } catch (err) {
        console.warn('backlinks-daily-blocks: read base failed', file.path, err);
        continue;
      }

      // Match single-line groupBy scalars (not already objects/arrays), conservative to avoid mangling existing objects
      const updated = content.replace(/(^[ \t]*)groupBy:\s*([A-Za-z0-9_.\/:-]+)\s*$/gm, (match, indent, prop) => {
        const property = (prop || '').trim();
        if (!property) return match;
        return `${indent}groupBy:\n${indent}  property: ${property}\n${indent}  direction: ASC`;
      });

      if (updated !== content) {
        try {
          await this.app.vault.modify(file, updated);
        } catch (err) {
          console.warn('backlinks-daily-blocks: write base failed', file.path, err);
        }
      }
    }
  }
}

module.exports = BacklinksDailyBlocksPlugin;
