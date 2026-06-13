// Plugin settings: defaults for each code block, tabbed settings screen.

const { PluginSettingTab, Setting } = require('obsidian');

const DEFAULT_SETTINGS = {
  kanban: {
    columns: 'Backlog~\nTodo\nDoing!\nParked~\nDone=x\nCancelled=-',
    colors: '',
    paths: '',
    maxage: 7,
    sweep: 'Doing > Parked',
  },
  ei: {
    paths: '',
    from: '',
    doors: 'Do > Todo\nDelegate > Waiting +who\nDelete > Cancelled',
  },
  backlinks: {
    heading: 'Backlinks',
    sort: 'ctime',
    limit: 20,
    truncate: 400,
  },
  daily: {
    heading: 'Daily notes',
    order: 'desc',
    limit: 0,
    truncate: 800,
    includeCurrent: false,
  },
};

const TABS = ['Kanban', 'Ei', 'Backlinks', 'Daily', 'Views'];

class BdbSettingTab extends PluginSettingTab {
  constructor(plugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
    this.activeTab = 'Kanban';
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    const bar = containerEl.createDiv({ cls: 'bdb-settings-tabs' });
    for (const name of TABS) {
      const btn = bar.createEl('button', {
        text: name,
        cls: name === this.activeTab ? 'bdb-settings-tab bdb-settings-tab-active' : 'bdb-settings-tab',
      });
      btn.addEventListener('click', () => { this.activeTab = name; this.display(); });
    }

    const body = containerEl.createDiv();
    this[`render${this.activeTab}`](body);
  }

  // Bind a Setting text/textarea/number/toggle to settings[section][key], save on change.
  bind(setting, section, key, { number = false, area = false } = {}) {
    const s = this.plugin.settings[section];
    const save = async (value) => {
      s[key] = number ? (Number(value) || 0) : value;
      await this.plugin.saveSettings();
    };
    if (typeof s[key] === 'boolean') {
      setting.addToggle(t => t.setValue(s[key]).onChange(async v => { s[key] = v; await this.plugin.saveSettings(); }));
    } else if (area) {
      setting.setClass('bdb-setting-area');
      setting.addTextArea(t => t.setValue(String(s[key])).onChange(save));
    } else {
      setting.addText(t => t.setValue(String(s[key])).onChange(save));
    }
  }

  renderKanban(el) {
    this.bind(new Setting(el).setName('Default columns')
      .setDesc('One per line: Name[~N idle, ages amber past N days (default 1), red past 3N][! heartbeat][=x terminal char] [@color]. e.g. "Waiting~3", "Doing! @#2d7ff9", "Done=x @green". No @color = built-in palette.'),
      'kanban', 'columns', { area: true });
    this.bind(new Setting(el).setName('Default paths').setDesc('Comma list of path prefixes to scan; empty = whole vault.'), 'kanban', 'paths');
    this.bind(new Setting(el).setName('Max age (days)').setDesc('Hide terminal cards stamped older than this; 0 = show all.'), 'kanban', 'maxage', { number: true });
    this.bind(new Setting(el).setName('Sweep').setDesc('One "From > To" route per line; each adds a bulk-move button on its From column. Empty disables.'), 'kanban', 'sweep', { area: true });

    const preview = new Setting(el)
      .setName('Current config as block')
      .setDesc('Read-only. Paste into a kanban code block in any note to clone this board.')
      .setClass('bdb-setting-area');
    preview.addButton(b => b.setButtonText('Copy').onClick(async () => {
      await navigator.clipboard.writeText(this.kanbanBlockText());
      b.setButtonText('Copied');
      window.setTimeout(() => b.setButtonText('Copy'), 1200);
    }));
    preview.addTextArea(t => {
      t.inputEl.readOnly = true;
      t.inputEl.rows = 8;
      t.inputEl.classList.add('bdb-config-preview');
      const fill = () => t.setValue(this.kanbanBlockText());
      fill();
      t.inputEl.addEventListener('focus', () => { fill(); t.inputEl.select(); });
    });
  }

  // Settings rendered as ```kanban``` block syntax.
  kanbanBlockText() {
    const k = this.plugin.settings.kanban;
    const multi = (key, text) => [`${key}:`, ...text.split(/[,\n]/).map(s => s.trim()).filter(Boolean).map(s => `  ${s}`)];
    const lines = multi('columns', k.columns);
    if (k.paths) lines.push(`paths: ${k.paths}`);
    lines.push(`maxage: ${k.maxage}`);
    if (k.sweep) lines.push(...multi('sweep', k.sweep));
    if (k.colors) lines.push(...multi('colors', k.colors));
    return lines.join('\n');
  }

  renderEi(el) {
    this.bind(new Setting(el).setName('Default paths')
      .setDesc('Comma list of path prefixes to scan; empty = kanban default paths.'), 'ei', 'paths');
    this.bind(new Setting(el).setName('Tray column')
      .setDesc('Open kanban column the tray shows; empty = first open column.'), 'ei', 'from');
    this.bind(new Setting(el).setName('Doors')
      .setDesc('One "Name > TargetColumn [+who]" per line. +who asks for a person and appends a [[wikilink]]. Target must exist on the kanban.'), 'ei', 'doors', { area: true });

    const preview = new Setting(el)
      .setName('Current config as block')
      .setDesc('Read-only. Paste into an ei code block in any note to clone this chute.')
      .setClass('bdb-setting-area');
    preview.addButton(b => b.setButtonText('Copy').onClick(async () => {
      await navigator.clipboard.writeText(this.eiBlockText());
      b.setButtonText('Copied');
      window.setTimeout(() => b.setButtonText('Copy'), 1200);
    }));
    preview.addTextArea(t => {
      t.inputEl.readOnly = true;
      t.inputEl.rows = 6;
      t.inputEl.classList.add('bdb-config-preview');
      const fill = () => t.setValue(this.eiBlockText());
      fill();
      t.inputEl.addEventListener('focus', () => { fill(); t.inputEl.select(); });
    });
  }

  // Settings rendered as ```ei``` block syntax.
  eiBlockText() {
    const e = this.plugin.settings.ei;
    const lines = ['doors:', ...e.doors.split(/[,\n]/).map(s => s.trim()).filter(Boolean).map(s => `  ${s}`)];
    if (e.from) lines.unshift(`from: ${e.from}`);
    if (e.paths) lines.push(`paths: ${e.paths}`);
    return lines.join('\n');
  }

  renderBacklinks(el) {
    this.bind(new Setting(el).setName('Heading'), 'backlinks', 'heading');
    new Setting(el).setName('Sort').setDesc('Newest first by created or modified time.')
      .addDropdown(d => d.addOptions({ ctime: 'ctime', mtime: 'mtime' })
        .setValue(this.plugin.settings.backlinks.sort)
        .onChange(async v => { this.plugin.settings.backlinks.sort = v; await this.plugin.saveSettings(); }));
    this.bind(new Setting(el).setName('Limit').setDesc('Max notes shown; 0 = no limit.'), 'backlinks', 'limit', { number: true });
    this.bind(new Setting(el).setName('Truncate').setDesc('Characters per note preview.'), 'backlinks', 'truncate', { number: true });
  }

  renderDaily(el) {
    this.bind(new Setting(el).setName('Heading'), 'daily', 'heading');
    new Setting(el).setName('Order')
      .addDropdown(d => d.addOptions({ desc: 'desc', asc: 'asc' })
        .setValue(this.plugin.settings.daily.order)
        .onChange(async v => { this.plugin.settings.daily.order = v; await this.plugin.saveSettings(); }));
    this.bind(new Setting(el).setName('Limit').setDesc('Max notes shown; 0 = no limit.'), 'daily', 'limit', { number: true });
    this.bind(new Setting(el).setName('Truncate').setDesc('Characters per note preview.'), 'daily', 'truncate', { number: true });
    this.bind(new Setting(el).setName('Include current note'), 'daily', 'includeCurrent');
  }

  renderViews(el) {
    el.createEl('p', {
      text: 'Chronicle, Atlas, Ledger and Beacon are Bases views: configure each one from the view options menu in the Bases toolbar.',
      cls: 'setting-item-description',
    });
  }
}

function mergeSettings(loaded) {
  const out = {};
  for (const [section, defaults] of Object.entries(DEFAULT_SETTINGS)) {
    out[section] = { ...defaults, ...(loaded?.[section] || {}) };
  }
  return out;
}

module.exports = { DEFAULT_SETTINGS, BdbSettingTab, mergeSettings };
