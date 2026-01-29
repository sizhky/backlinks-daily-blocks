const { Plugin, MarkdownRenderer, TFile, parseYaml, moment, ItemView, BasesView } = require('obsidian');

const VIEW_TYPE = 'backlinks-daily-view';
const BASES_VIEW_TYPE = 'backlinks-daily-bases-view';

class BacklinksDailyBlocksPlugin extends Plugin {
  async onload() {
    this.registerMarkdownCodeBlockProcessor('backlinks', (src, el, ctx) => {
      return this.renderBacklinksBlock(src, el, ctx);
    });

    this.registerMarkdownCodeBlockProcessor('daily', (src, el, ctx) => {
      return this.renderDailyBlock(src, el, ctx);
    });

    this.viewInstances = new Set();

    this.registerView(VIEW_TYPE, (leaf) => new BacklinksDailyView(leaf, this));

    this.addCommand({
      id: 'open-backlinks-daily-view',
      name: 'Open Backlinks & Daily view',
      callback: () => this.activateView()
    });

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        this.refreshOpenViews();
      })
    );

    this.registerBasesView(BASES_VIEW_TYPE, {
      name: 'Content Feed',
      icon: 'lucide-scroll-text',
      factory: (controller, containerEl) => {
        return new BacklinksDailyBasesView(this, controller, containerEl);
      },
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
          default: 800,
        },
      ]),
    });
  }

  async activateView() {
    const leaf = this.app.workspace.getRightLeaf(false) || this.app.workspace.getRightLeaf(true);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  refreshOpenViews() {
    for (const view of this.viewInstances) {
      view.render();
    }
  }

  parseOptions(source, defaults) {
    const raw = (source || '').trim();
    const base = { ...defaults };
    if (!raw) return base;

    let parsed = null;
    if (raw.startsWith('{') || raw.includes(':')) {
      try {
        parsed = parseYaml(raw);
      } catch (err) {
        console.warn('backlinks-daily-blocks: could not parse options', err);
      }
    }

    if (parsed && typeof parsed === 'object') {
      return { ...base, ...parsed };
    }

    const fallbackKey = defaults.hasOwnProperty('target') ? 'target' : defaults.hasOwnProperty('date') ? 'date' : 'value';
    return { ...base, [fallbackKey]: raw };
  }

  stripFrontmatter(text) {
    return text.replace(/^---\n[\s\S]*?\n---\n/, '');
  }

  truncateContent(text, limit) {
    let output = text;
    const moreIndex = output.indexOf('%% more %%');
    if (moreIndex !== -1) {
      output = output.substring(0, moreIndex).trim() + '\n\n*Content truncated...*';
    }

    if (limit && output.length > limit) {
      output = output.substring(0, limit).trimEnd() + '...';
    }

    return output;
  }

  resolveTargetFile(target, fromPath) {
    if (!target) return null;
    return this.app.metadataCache.getFirstLinkpathDest(target, fromPath || '');
  }

  async renderBacklinksBlock(source, el, ctx) {
    const options = this.parseOptions(source, {
      target: null,
      sort: 'ctime',
      limit: 20,
      truncate: 400,
      heading: 'Backlinks'
    });

    const currentPath = ctx.sourcePath;
    const targetFile = options.target ? this.resolveTargetFile(options.target, currentPath) : this.app.vault.getAbstractFileByPath(currentPath);

    if (!(targetFile instanceof TFile)) {
      el.createEl('div', { text: `Target note not found: ${options.target || '(current file)'}` });
      return;
    }

    const backlinks = this.app.metadataCache.getBacklinksForFile(targetFile);
    const entries = [];

    if (backlinks?.data) {
      for (const [path] of backlinks.data.entries()) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          entries.push(file);
        }
      }
    }

    if (!entries.length) {
      el.createEl('div', { text: `No backlinks to ${targetFile.basename}.` });
      return;
    }

    const sortKey = (options.sort || 'ctime').toLowerCase();
    entries.sort((a, b) => {
      const aStat = a.stat || {};
      const bStat = b.stat || {};
      if (sortKey === 'mtime') return (bStat.mtime || 0) - (aStat.mtime || 0);
      return (bStat.ctime || 0) - (aStat.ctime || 0);
    });

    const limited = options.limit ? entries.slice(0, options.limit) : entries;

    el.createEl('h3', { text: `${options.heading} (${limited.length})` });

    for (const file of limited) {
      const section = el.createEl('div', { cls: 'bdb-backlink' });
      section.createEl('h4', { text: file.basename });

      let content = '';
      try {
        content = await this.app.vault.cachedRead(file);
      } catch (err) {
        console.warn('backlinks-daily-blocks: read failed', file.path, err);
      }

      content = this.truncateContent(this.stripFrontmatter(content || ''), options.truncate);
      if (!content.trim()) content = '(empty note)';

      const markdown = `> [[${file.path}|${file.basename}]]\n>\n> ${content.replace(/\n/g, '\n> ')}`;
      await MarkdownRenderer.renderMarkdown(markdown, section, ctx.sourcePath, this);
    }
  }

  async renderDailyBlock(source, el, ctx) {
    const options = this.parseOptions(source, {
      date: null,
      order: 'desc',
      size: '100%',
      limit: null,
      truncate: 800,
      includeCurrent: false,
      heading: 'Daily notes'
    });

    let targetDate = (options.date || '').replace(/[^0-9]/g, '');
    if (!targetDate) {
      const match = ctx.sourcePath.match(/(\d{8})-\d{4}/);
      targetDate = match ? match[1] : moment().format('YYYYMMDD');
    }
    targetDate = targetDate.substring(0, 8);

    const pattern = /^\d{8}-\d{4}(?:\.excalidraw)?\.md$/;
    const files = this.app.vault.getFiles().filter((file) => {
      if (!pattern.test(file.name)) return false;
      if (!options.includeCurrent && file.path === ctx.sourcePath) return false;
      return file.name.startsWith(targetDate);
    });

    if (!files.length) {
      el.createEl('div', { text: `No notes found for ${targetDate}.` });
      return;
    }

    const order = (options.order || 'desc').toLowerCase();
    files.sort((a, b) => {
      return order === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
    });

    const limited = options.limit ? files.slice(0, options.limit) : files;

    el.createEl('h3', { text: `${options.heading} (${limited.length})` });

    for (const file of limited) {
      const section = el.createEl('div', { cls: 'bdb-daily' });
      const displayName = file.basename.endsWith('.excalidraw') ? file.basename.replace('.excalidraw', '') : file.basename;
      section.createEl('h4', { text: displayName });

      if (file.basename.endsWith('.excalidraw')) {
        const embed = `![[${file.path}${options.size ? '|' + options.size : ''}]]`;
        await MarkdownRenderer.renderMarkdown(embed, section, ctx.sourcePath, this);
        continue;
      }

      let content = '';
      try {
        content = await this.app.vault.cachedRead(file);
      } catch (err) {
        console.warn('backlinks-daily-blocks: read failed', file.path, err);
      }

      content = this.truncateContent(this.stripFrontmatter(content || ''), options.truncate);
      if (!content.trim()) content = '(empty note)';

      const markdown = `${content}\n\n---`;
      await MarkdownRenderer.renderMarkdown(markdown, section, ctx.sourcePath, this);
    }
  }
}

class BacklinksDailyBasesView extends BasesView {
  constructor(plugin, controller, parentEl) {
    super(controller);
    this.type = BASES_VIEW_TYPE;
    this.plugin = plugin;
    this.containerEl = parentEl.createDiv('bases-content-feed-container');
  }

  load() {
    // Required lifecycle method
  }

  unload() {
    // Required lifecycle method
  }

  async onDataUpdated() {
    const { app } = this;
    const config = this.config;
    
    this.containerEl.empty();

    if (!this.data) {
      this.containerEl.createDiv({ text: 'Loading...' });
      return;
    }

    const stripFrontmatter = config.get('stripFrontmatter') !== false;
    const truncateLength = Number(config.get('truncateLength')) || 800;

    // Collect all entries from grouped data
    const allEntries = [];
    if (this.data.groupedData) {
      for (const group of this.data.groupedData) {
        allEntries.push(...group.entries);
      }
    }

    if (allEntries.length === 0) {
      this.containerEl.createDiv({ text: 'No entries found.' });
      return;
    }

    // Use all entries for a simple linear feed
    for (const entry of allEntries) {
      const file = entry.file;
      
      if (!(file instanceof TFile)) continue;

      const section = this.containerEl.createDiv('bdb-bases-entry');
      const displayName = file.basename.endsWith('.excalidraw') 
        ? file.basename.replace('.excalidraw', '') 
        : file.basename;
      
      const titleEl = section.createEl('h4');
      const linkEl = titleEl.createEl('a', { text: displayName, cls: 'bdb-bases-title-link' });
      linkEl.addEventListener('click', (evt) => {
        evt.preventDefault();
        const modEvent = evt.ctrlKey || evt.metaKey;
        app.workspace.openLinkText(file.path, '', modEvent);
      });

      if (file.basename.endsWith('.excalidraw')) {
        const embed = `![[${file.path}|100%]]`;
        await MarkdownRenderer.renderMarkdown(embed, section, file.path, this.plugin);
        continue;
      }

      let content = '';
      try {
        content = await app.vault.cachedRead(file);
      } catch (err) {
        console.warn('backlinks-daily-blocks: read failed', file.path, err);
      }

      if (stripFrontmatter) {
        content = this.plugin.stripFrontmatter(content || '');
      }
      content = this.plugin.truncateContent(content, truncateLength);
      if (!content.trim()) content = '(empty note)';

      const markdown = `${content}\n\n---`;
      await MarkdownRenderer.renderMarkdown(markdown, section, file.path, this.plugin);
    }
  }
}

module.exports = BacklinksDailyBlocksPlugin;
