const { Plugin, MarkdownRenderer, TFile, parseYaml, moment, ItemView, BasesView, setIcon } = require('obsidian');

const VIEW_TYPE = 'backlinks-daily-view';
const BASES_VIEW_TYPE = 'content-feed-bases-view';
const BASES_PROPERTIES_VIEW_TYPE = 'properties-aggregation-view';
const BASES_TASKS_VIEW_TYPE = 'tasks-aggregation-view';
const BASES_WINS_VIEW_TYPE = 'hashtags-aggregation-view';

class BacklinksDailyBlocksPlugin extends Plugin {
  async onload() {
    this.injectStyles();

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

    this.registerBasesView(BASES_PROPERTIES_VIEW_TYPE, {
      name: 'Properties Aggregation',
      icon: 'lucide-list-tree',
      factory: (controller, containerEl) => {
        return new PropertiesAggregationView(this, controller, containerEl);
      },
      options: () => ([
        {
          type: 'text',
          displayName: 'Exclude properties (comma-separated)',
          key: 'excludeProperties',
          default: 'file,journal,journal-date',
        },
      ]),
    });

    this.registerBasesView(BASES_TASKS_VIEW_TYPE, {
      name: 'Tasks',
      icon: 'lucide-check-square',
      factory: (controller, containerEl) => {
        return new TasksAggregationView(this, controller, containerEl);
      },
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
      ]),
    });

    this.registerBasesView(BASES_WINS_VIEW_TYPE, {
      name: 'Hashtag Feed',
      icon: 'lucide-flag',
      factory: (controller, containerEl) => {
        return new WinsAggregationView(this, controller, containerEl);
      },
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

  injectStyles() {
    const css = `
      .bdb-bases-entry ul { margin: 0.15em 0 0.15em 1.25em; padding-left: 1.25em; }
      .bdb-bases-entry li { margin: 0.05em 0; }
      .bdb-bases-entry p { margin: 0.15em 0; }
    `;
    const styleEl = document.createElement('style');
    styleEl.textContent = css;
    document.head.appendChild(styleEl);
    this.register(() => styleEl.remove());
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

  bindInternalLinks(container, sourcePath) {
    const anchors = container.querySelectorAll('a.internal-link');
    for (const anchor of anchors) {
      if (anchor.__bdbBound) continue;
      anchor.__bdbBound = true;
      anchor.addEventListener('click', (evt) => {
        evt.preventDefault();
        const link = anchor.getAttribute('href') || anchor.dataset?.href;
        if (!link) return;
        const modEvent = evt.ctrlKey || evt.metaKey;
        this.app.workspace.openLinkText(link, sourcePath || '', modEvent);
      });
    }
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

      const markdown = `${content}\n`;
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

    // Preserve zero to disable truncation; fall back only if the value is invalid
    let truncateLength = Number(config.get('truncateLength'));
    if (!Number.isFinite(truncateLength) || truncateLength < 0) {
      truncateLength = 0;
    }
    const titleProperty = String(config.get('titleProperty') || 'note.categories');

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

      const displayName = file.basename.endsWith('.excalidraw') 
        ? file.basename.replace('.excalidraw', '') 
        : file.basename;
      
      // For non-excalidraw files, check content first
      if (!file.basename.endsWith('.excalidraw')) {
        let content = '';
        let rawLines = [];
        try {
          content = await app.vault.cachedRead(file);
          rawLines = content.split(/\r?\n/);
        } catch (err) {
          console.warn('backlinks-daily-blocks: read failed', file.path, err);
        }

        if (stripFrontmatter) {
          content = this.plugin.stripFrontmatter(content || '');
        }
        content = this.plugin.truncateContent(content, truncateLength);
        
        // Skip empty notes
        if (!content.trim()) continue;
      }

      this.createWaveSeparator(this.containerEl, 'rgba(210, 60, 60, 0.85)');

      // Now create the section since we know it has content
      const section = this.containerEl.createDiv('bdb-bases-entry');
      
      const titleEl = section.createEl('h4');
      const linkEl = titleEl.createEl('a', { text: displayName, cls: 'bdb-bases-title-link' });
      linkEl.addEventListener('click', (evt) => {
        evt.preventDefault();
        const modEvent = evt.ctrlKey || evt.metaKey;
        app.workspace.openLinkText(file.path, '', modEvent);
      });

      // Get property value from entry metadata if configured
      if (titleProperty) {
        const propertyValue = entry.getValue(titleProperty);
        if (propertyValue && propertyValue.data && Array.isArray(propertyValue.data)) {
          const valueLinks = propertyValue.data
            .filter(val => val)
            .map(val => {
              if (val && val.path) {
                const displayName = val.display || val.path.split('/').pop().replace('.md', '');
                return `[[${val.path}|${displayName}]]`;
              }
              return String(val);
            });
          
          if (valueLinks.length > 0) {
            const valueStr = ` (${valueLinks.join(', ')})`;
            const propertySpan = titleEl.createSpan({ cls: 'bdb-bases-categories' });
            await MarkdownRenderer.renderMarkdown(valueStr, propertySpan, file.path, this.plugin);
          }
        }
      }

      if (file.basename.endsWith('.excalidraw')) {
        const embed = `![[${file.path}|100%]]`;
        await MarkdownRenderer.renderMarkdown(embed, section, file.path, this.plugin);
        continue;
      }

      // Re-read content for rendering (we already validated it's not empty)
      let content = '';
      let rawLines = [];
      try {
        content = await app.vault.cachedRead(file);
        rawLines = content.split(/\r?\n/);
      } catch (err) {
        console.warn('backlinks-daily-blocks: read failed', file.path, err);
      }

      if (stripFrontmatter) {
        content = this.plugin.stripFrontmatter(content || '');
      }
      content = this.plugin.truncateContent(content, truncateLength);

      const markdown = `${content}\n`;
      await MarkdownRenderer.renderMarkdown(markdown, section, file.path, this.plugin);

      // Ensure internal links open via Obsidian's navigation
      this.plugin.bindInternalLinks(section, file.path);

      // Make task checkboxes interactive for rendered markdown (best-effort text match)
      this.attachTaskCheckboxHandlers(section, file, rawLines);
    }

    // Trailing separator after the last entry
    this.createWaveSeparator(this.containerEl, 'rgba(210, 60, 60, 0.85)');
  }

  attachTaskCheckboxHandlers(container, file, rawLines) {
    if (!rawLines || !rawLines.length) return;
    const checkboxes = container.querySelectorAll('input.task-list-item-checkbox');
    if (!checkboxes?.length) return;

    const listItems = this.app.metadataCache.getFileCache(file)?.listItems || [];
    const taskItems = listItems.filter((item) => {
      const line = item?.position?.start?.line;
      if (line == null) return false;
      const raw = rawLines[line] || '';
      return /^\s*[-*]\s*\[[ xX]\]/.test(raw);
    });

    const count = Math.min(taskItems.length, checkboxes.length);

    for (let i = 0; i < count; i++) {
      const box = checkboxes[i];
      if (box.__bdbBound) continue;
      box.__bdbBound = true;

      const line = taskItems[i]?.position?.start?.line;
      if (line == null || line < 0 || line >= rawLines.length) continue;

      box.addEventListener('change', async () => {
        const original = rawLines[line];
        const updated = original.replace(/^(\s*[-*]\s*\[)( |x|X)(\])/, `$1${box.checked ? 'x' : ' '}$3`);
        if (updated === original) return;

        rawLines[line] = updated;
        try {
          await this.app.vault.modify(file, rawLines.join('\n'));
        } catch (err) {
          console.warn('backlinks-daily-blocks: toggle task (rendered) failed', file.path, err);
        }
      });
    }
  }

  createWaveSeparator(parentEl, strokeColor = 'rgba(210, 60, 60, 0.85)') {
    const sep = parentEl.createDiv({ cls: 'bdb-feed-separator' });
    sep.textContent = '';
    sep.style.height = '8px';
    sep.style.width = '100%';
    const svg = encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="8" viewBox="0 0 80 8" preserveAspectRatio="none"><path d="M0 4 Q10 0 20 4 T40 4 T60 4 T80 4" fill="none" stroke="${strokeColor}" stroke-width="1.5" stroke-linecap="round"/></svg>`
    );
    sep.style.backgroundImage = `url("data:image/svg+xml,${svg}")`;
    sep.style.backgroundRepeat = 'repeat-x';
    sep.style.backgroundSize = '80px 8px';
    sep.style.backgroundPosition = 'center';
    sep.style.opacity = '0.9';
    sep.style.margin = '0.55em 0 0.55em 0';
    sep.style.border = 'none';
    sep.style.padding = '0';
    sep.style.borderRadius = '999px';
    sep.style.filter = 'drop-shadow(0 0 2px rgba(0,0,0,0.08))';
    return sep;
  }
}

class PropertiesAggregationView extends BasesView {
  constructor(plugin, controller, container) {
    super(controller);
    this.type = BASES_PROPERTIES_VIEW_TYPE;
    this.plugin = plugin;
    this.containerEl = container.createDiv('bdb-properties-aggregation');
    this.frontmatterUpdating = false;
  }

  load() {
    // Required lifecycle method
  }

  unload() {
    // Required lifecycle method
  }

  resolveHostFile() {
    // Prefer explicit data-path on this container
    const ownHostPath = this.containerEl?.getAttribute?.('data-path');
    if (ownHostPath) {
      const file = this.app.vault.getAbstractFileByPath(ownHostPath);
      if (file instanceof TFile) return file;
    }

    // Fallback: closest ancestor data-path
    const hostEl = this.containerEl?.closest?.('[data-path]');
    const hostPath = hostEl?.getAttribute?.('data-path');
    if (hostPath) {
      const file = this.app.vault.getAbstractFileByPath(hostPath);
      if (file instanceof TFile) return file;
    }

    // Last resort: active file
    const active = this.app.workspace.getActiveFile();
    return active instanceof TFile ? active : null;
  }

  async updateFrontmatterWithAggregates(aggregatedData) {
    if (this.frontmatterUpdating) return;

    const targetFile = this.resolveHostFile();
    if (!(targetFile instanceof TFile)) return;

    // Skip templates or notes that explicitly opt out
    const filePath = targetFile.path || '';
    const frontmatter = this.app.metadataCache.getFileCache(targetFile)?.frontmatter || {};
    const optOut = frontmatter['bdb-disable-sync'] === true;
    const looksLikeTemplate = /\/Templates\//i.test(filePath) || /template/i.test(targetFile.basename);
    if (optOut || looksLikeTemplate) return;

    // Debug logging removed

    const updates = {};

    for (const [propertyKey, valueMap] of aggregatedData) {
      const values = Array.from(valueMap.values())
        .map((info) => {
          const display = (info?.displayName || info?.key || '').toString().trim();
          if (!display) return '';
          // Preserve link targets by emitting wiki-link syntax when available
          if (info?.linkPath) {
            return `[[${info.linkPath}|${display}]]`;
          }
          return display;
        })
        .filter(Boolean);

      if (!values.length) continue;

      // Deduplicate while preserving order
      const deduped = [];
      for (const val of values) {
        if (!deduped.includes(val)) deduped.push(val);
      }

      updates[propertyKey] = deduped.length === 1 ? deduped[0] : deduped;

      // Debug logging removed
    }

    if (!Object.keys(updates).length) return;

    this.frontmatterUpdating = true;
    try {
      await this.app.fileManager.processFrontMatter(targetFile, (frontmatter) => {
        for (const [key, val] of Object.entries(updates)) {
          const current = frontmatter[key];
          const bothArrays = Array.isArray(current) && Array.isArray(val);
          const sameArray =
            bothArrays &&
            current.length === val.length &&
            current.every((item, idx) => item === val[idx]);

          if (current === val || sameArray) continue;

          // Debug logging removed
          frontmatter[key] = val;
        }
      });
    } catch (err) {
      console.warn('backlinks-daily-blocks: update frontmatter failed', err);
    } finally {
      this.frontmatterUpdating = false;
    }
  }

  async onDataUpdated() {
    const { app } = this;
    const data = this.data;
    
    this.containerEl.empty();

    // Determine target file/date and tag container for downstream resolution
    const targetFile = this.resolveHostFile();
    if (targetFile) {
      this.containerEl.setAttribute('data-path', targetFile.path);
    }
    const targetDateMatch = targetFile?.basename?.match(/^(\d{8})/);
    const targetDatePrefix = targetDateMatch ? targetDateMatch[1] : null;
    if (!targetFile || !targetDatePrefix) {
      this.containerEl.createDiv({ text: 'No target note detected for properties sync.', cls: 'bdb-properties-empty' });
      return;
    }
    
    if (!data || !data.groupedData) {
      this.containerEl.createDiv({ text: 'No data available', cls: 'bdb-properties-empty' });
      return;
    }

    const config = this.config || {};
    const excludeProperties = (config.excludeProperties || 'file,journal,journal-date')
      .split(',')
      .map(p => p.trim())
      .filter(Boolean);

    // First pass: discover all unique property keys
    const allPropertyKeys = new Set();
    for (const group of data.groupedData) {
      for (const entry of group.entries) {
        const file = entry.file;
        if (!(file instanceof TFile)) continue;
        if (!file.basename.startsWith(targetDatePrefix)) continue;
        
        // Debug logging removed

        // Get all properties from the file's frontmatter
        const cache = app.metadataCache.getFileCache(file);
        if (cache?.frontmatter) {
          for (const key of Object.keys(cache.frontmatter)) {
            if (key !== 'position' && !excludeProperties.includes(key)) {
              allPropertyKeys.add(key);
            }
          }
        }
      }
    }

    if (allPropertyKeys.size === 0) {
      this.containerEl.createDiv({ text: 'No properties found', cls: 'bdb-properties-empty' });
      return;
    }

    // Second pass: aggregate values for each property
    const aggregatedData = new Map();

    for (const propertyKey of allPropertyKeys) {
      const propertyMap = new Map();
      const propertyInfo = app.metadataTypeManager?.getPropertyInfo(propertyKey);
      let isCheckbox = propertyInfo?.type === 'checkbox';
      
      // If not registered, check if all values are booleans
      if (!isCheckbox) {
        let allBoolean = true;
        for (const group of data.groupedData) {
          for (const entry of group.entries) {
            const file = entry.file;
            if (!(file instanceof TFile)) continue;
            const cache = app.metadataCache.getFileCache(file);
            if (!cache?.frontmatter) continue;
            const rawValue = cache.frontmatter[propertyKey];
            if (rawValue !== undefined && rawValue !== null && typeof rawValue !== 'boolean') {
              allBoolean = false;
              break;
            }
          }
          if (!allBoolean) break;
        }
        isCheckbox = allBoolean;
      }
      
      for (const group of data.groupedData) {
        for (const entry of group.entries) {
          const file = entry.file;
          if (!(file instanceof TFile)) continue;
          if (!file.basename.startsWith(targetDatePrefix)) continue;

          const cache = app.metadataCache.getFileCache(file);
          if (!cache?.frontmatter) continue;
          
          // Check if property exists in frontmatter
          const hasProperty = propertyKey in cache.frontmatter;
          if (!hasProperty) continue;
          
          const rawValue = cache.frontmatter[propertyKey];

          // Special handling for checkbox properties - just presence matters
          if (isCheckbox) {
            // Extract timestamp from filename (e.g., 20260128-0745 -> 0745)
            const timeMatch = file.basename.match(/\d{8}-(\d{4})/);
            const timestamp = timeMatch ? timeMatch[1] : file.basename;
            const key = `${file.path}`;  // Use full path as unique key
            const displayName = timestamp;
            const linkPath = file.path;
            
            if (!propertyMap.has(key)) {
              propertyMap.set(key, { displayName, linkPath, sources: [] });
            }
            
            propertyMap.get(key).sources.push({
              file: file,
              basename: file.basename
            });
            
            continue; // Skip to next file
          }

          // For non-checkbox properties, skip if value is null/undefined
          if (rawValue === undefined || rawValue === null) continue;

          const values = Array.isArray(rawValue) ? rawValue : [rawValue];
          
          for (const val of values) {
            let key, displayName, linkPath;
            
            if (val && typeof val === 'object' && val.path) {
              // It's already a link object from Obsidian
              key = val.path;
              linkPath = val.path;
              displayName = val.display || val.path.split('/').pop().replace('.md', '');
            } else {
              // It's a string, check if it contains wiki link syntax
              const strVal = String(val);
              const wikiLinkMatch = strVal.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/);
              
              if (wikiLinkMatch) {
                // It's a wiki link like [[Page]] or [[Page|Display]]
                linkPath = wikiLinkMatch[1];
                displayName = wikiLinkMatch[2] || wikiLinkMatch[1].split('/').pop();
                key = linkPath;
              } else {
                // Plain string value
                key = strVal;
                displayName = strVal;
                linkPath = null;
              }
            }
            
            if (!propertyMap.has(key)) {
              propertyMap.set(key, { displayName, linkPath, sources: [] });
            }
            
            propertyMap.get(key).sources.push({
              file: file,
              basename: file.basename
            });
          }
        }
      }
      
      if (propertyMap.size > 0) {
        aggregatedData.set(propertyKey, propertyMap);
      }
    }

    // Display aggregated properties
    if (aggregatedData.size === 0) {
      this.containerEl.createDiv({ text: 'No properties found', cls: 'bdb-properties-empty' });
      return;
    }

    // Push aggregated values into the current note's frontmatter
    await this.updateFrontmatterWithAggregates(aggregatedData);

    // Skip visual render to avoid redundancy with frontmatter
    this.containerEl.createDiv({ text: 'Properties synced to frontmatter.', cls: 'bdb-properties-synced' });
    return;

    for (const [propertyKey, valueMap] of aggregatedData) {
      const propertySection = this.containerEl.createDiv({ cls: 'bdb-property-section' });
      
      const headerEl = propertySection.createEl('div', { cls: 'bdb-property-header' });
      
      // Get property info from Obsidian's metadata
      const propertyInfo = app.metadataTypeManager?.getPropertyInfo(propertyKey);
      let iconName = 'text';
      
      if (propertyInfo?.type) {
        // Use Obsidian's known property type
        switch (propertyInfo.type) {
          case 'checkbox':
            iconName = 'check-square';
            break;
          case 'date':
          case 'datetime':
            iconName = 'calendar';
            break;
          case 'multitext':
          case 'tags':
            iconName = 'tags';
            break;
          case 'number':
            iconName = 'hash';
            break;
          case 'aliases':
            iconName = 'forward';
            break;
          default:
            iconName = 'text';
        }
      } else {
        // Fallback: guess from property name, value count, or first value
        const valueCount = valueMap.size;
        const firstValue = Array.from(valueMap.values())[0];
        
        // Multi-value properties should use list icon
        if (valueCount > 1 || propertyKey.toLowerCase().includes('categor') || 
            propertyKey.toLowerCase().includes('people') || propertyKey.toLowerCase().includes('topic') ||
            propertyKey.toLowerCase().includes('project') || propertyKey.toLowerCase().includes('org')) {
          iconName = 'list';
        } else if (firstValue && (firstValue.displayName === 'true' || firstValue.displayName === 'false')) {
          iconName = 'check-square';
        } else if (propertyKey === 'tags' || propertyKey.toLowerCase().includes('tag')) {
          iconName = 'tags';
        } else if (propertyKey.includes('date') || propertyKey.includes('time')) {
          iconName = 'calendar';
        } else if (firstValue?.linkPath) {
          iconName = 'link';
        } else {
          iconName = 'text';
        }
      }
      
      const iconEl = headerEl.createEl('span', { cls: 'bdb-property-icon' });
      setIcon(iconEl, iconName);
      
      headerEl.createEl('span', { 
        text: propertyKey.charAt(0).toUpperCase() + propertyKey.slice(1).replace(/-/g, ' '),
        cls: 'bdb-property-name'
      });

      const listEl = propertySection.createEl('div', { cls: 'bdb-property-list' });

      for (const [key, info] of valueMap) {
        const itemEl = listEl.createEl('div', { cls: 'bdb-property-item' });
        
        const valueEl = itemEl.createEl('span', { cls: 'bdb-property-value-wrapper' });
        
        if (info.linkPath) {
          // Render as markdown to get proper link formatting
          const markdown = `[[${info.linkPath}|${info.displayName}]]`;
          await MarkdownRenderer.renderMarkdown(markdown, valueEl, '', this.plugin);
        } else if (propertyKey === 'tags' || key.startsWith('#')) {
          // Display tags with # prefix
          const tagText = key.startsWith('#') ? key : `#${key}`;
          valueEl.createSpan({ text: tagText, cls: 'tag' });
        } else {
          valueEl.createSpan({ text: info.displayName });
        }
        
        const countEl = itemEl.createSpan({ 
          text: ` (${info.sources.length})`,
          cls: 'bdb-property-count'
        });

        // Add expandable list of source notes
        const sourcesEl = itemEl.createEl('div', { cls: 'bdb-property-sources' });
        sourcesEl.style.display = 'none';
        
        countEl.addEventListener('click', (evt) => {
          evt.stopPropagation();
          sourcesEl.style.display = sourcesEl.style.display === 'none' ? 'block' : 'none';
        });
        countEl.style.cursor = 'pointer';

        for (const source of info.sources) {
          const sourceItem = sourcesEl.createEl('div', { cls: 'bdb-property-source-item' });
          const sourceLink = sourceItem.createEl('a', {
            text: source.basename,
            cls: 'internal-link'
          });
          sourceLink.addEventListener('click', (evt) => {
            evt.preventDefault();
            const modEvent = evt.ctrlKey || evt.metaKey;
            app.workspace.openLinkText(source.file.path, '', modEvent);
          });
        }
      }
    }
  }
}

class TasksAggregationView extends BasesView {
  constructor(plugin, controller, container) {
    super(controller);
    this.type = BASES_TASKS_VIEW_TYPE;
    this.plugin = plugin;
    this.containerEl = container.createDiv('bdb-tasks-aggregation');
  }

  load() {
    // Required lifecycle method
  }

  unload() {
    // Required lifecycle method
  }

  buildTaskLink(filePath, lineNumber) {
    // Use Obsidian URI with line param to jump to the exact task line
    const vaultName = encodeURIComponent(this.app?.vault?.getName() || '');
    const encodedPath = encodeURIComponent(filePath);
    const line = Math.max(1, (lineNumber || 0) + 1); // Convert to 1-based
    return `obsidian://open?vault=${vaultName}&file=${encodedPath}&line=${line}`;
  }

  openFileAtLine(file, lineNumber, modEvent) {
    const { app } = this;
    const targetLine = Math.max(0, lineNumber || 0);
    app.workspace.openLinkText(file.path, '', modEvent);
    // Let the workspace open the leaf, then move the cursor/scroll.
    window.setTimeout(() => {
      const leaf = app.workspace.getMostRecentLeaf?.() || app.workspace.activeLeaf;
      const view = leaf?.view;
      const editor = view?.editor;
      if (editor?.setCursor) {
        editor.setCursor({ line: targetLine, ch: 0 });
        if (editor.scrollIntoView) {
          editor.scrollIntoView({
            from: { line: targetLine, ch: 0 },
            to: { line: targetLine + 1, ch: 0 },
          }, true);
        }
      }
    }, 60);
  }

  async toggleTask(task, newCompleted) {
    const { app } = this;
    try {
      const content = await app.vault.read(task.file);
      const lines = content.split(/\r?\n/);
      const lineIdx = task.line;
      if (lineIdx < 0 || lineIdx >= lines.length) return;

      const original = lines[lineIdx];
      const updated = original.replace(/^(\s*[-*]\s*\[)( |x|X)(\])/, `$1${newCompleted ? 'x' : ' '}$3`);

      if (updated === original) return;
      lines[lineIdx] = updated;
      await app.vault.modify(task.file, lines.join('\n'));
    } catch (err) {
      console.warn('backlinks-daily-blocks: toggle task failed', task.file?.path, err);
    } finally {
      // Refresh to reflect new state
      this.onDataUpdated();
    }
  }

  createTaskSeparator(parentEl) {
    const sep = parentEl.createDiv({ cls: 'bdb-task-item-sep' });
    sep.textContent = '';
    sep.style.height = '8px';
    sep.style.width = '100%';
    // Sine-like wave via inline SVG; repeats horizontally to fill width
    const svg = encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="8" viewBox="0 0 80 8" preserveAspectRatio="none"><path d="M0 4 Q10 0 20 4 T40 4 T60 4 T80 4" fill="none" stroke="rgba(46, 160, 67, 0.85)" stroke-width="1.5" stroke-linecap="round"/></svg>`
    );
    sep.style.backgroundImage = `url("data:image/svg+xml,${svg}")`;
    sep.style.backgroundRepeat = 'repeat-x';
    sep.style.backgroundSize = '80px 8px';
    sep.style.backgroundPosition = 'center';
    sep.style.opacity = '0.9';
    sep.style.margin = '0.45em 0 0.45em 0';
    sep.style.border = 'none';
    sep.style.padding = '0';
    sep.style.borderRadius = '999px';
    sep.style.filter = 'drop-shadow(0 0 2px rgba(0,0,0,0.08))';
    return sep;
  }

  async onDataUpdated() {
    const { app } = this;
    const data = this.data;

    this.containerEl.empty();

    if (!data || !data.groupedData) {
      this.containerEl.createDiv({ text: 'No data available', cls: 'bdb-tasks-empty' });
      return;
    }

    const config = this.config || {};
    const includeCompleted = config.get ? config.get('includeCompleted') !== false : config.includeCompleted !== false;
    const containsRaw = config.get ? config.get('contains') : config.contains;
    const contains = (containsRaw || '').toString().trim().toLowerCase();

    const tasks = [];

    for (const group of data.groupedData) {
      for (const entry of group.entries) {
        const file = entry.file;
        if (!(file instanceof TFile)) continue;

        const cache = app.metadataCache.getFileCache(file);
        const listItems = cache?.listItems || [];
        if (!listItems.length) continue;

        let fileLines = null;

        for (const item of listItems) {
          if (!item || typeof item.task !== 'string') continue;

          const pos = item.position?.start;
          if (!pos || pos.line == null) continue;

          if (!fileLines) {
            try {
              const content = await app.vault.cachedRead(file);
              fileLines = content.split(/\r?\n/);
            } catch (err) {
              console.warn('backlinks-daily-blocks: task read failed', file.path, err);
              break;
            }
          }

          const rawLine = fileLines[pos.line] || '';
          const statusMatch = rawLine.match(/^\s*[-*]\s*\[([^\]])\]/);
          if (!statusMatch) continue;

          const status = statusMatch[1] || ' ';
          const completed = status.toLowerCase() === 'x' || status === '-';
          if (!includeCompleted && completed) continue;

          const taskText = rawLine.replace(/^\s*[-*]\s*\[[^\]]\]\s*/, '').trim();
          if (contains && !taskText.toLowerCase().includes(contains)) continue;

          tasks.push({
            file,
            line: pos.line,
            text: taskText || '(empty task)',
            completed,
            status,
            rawLine,
          });
        }
      }
    }

    if (!tasks.length) {
      this.containerEl.createDiv({ text: 'No tasks found', cls: 'bdb-tasks-empty' });
      return;
    }

    // Respect Base-defined sorters if present; otherwise fall back to path+line.
    const hasBaseSorters = Array.isArray(this.data?.sorters) && this.data.sorters.length > 0;
    if (!hasBaseSorters) {
      tasks.sort((a, b) => {
        const pathCompare = a.file.path.localeCompare(b.file.path);
        if (pathCompare !== 0) return pathCompare;
        return a.line - b.line;
      });
    }

    const incomplete = tasks.filter(t => !t.completed);
    const complete = tasks.filter(t => t.completed);

    const renderGroup = async (title, items, collapsedByDefault) => {
      const details = this.containerEl.createEl('details', { cls: 'bdb-task-group' });
      if (!collapsedByDefault) details.setAttr('open', 'open');
      const summary = details.createEl('summary', { text: `${title} (${items.length})`, cls: 'bdb-task-group-title' });
      const listEl = details.createDiv({ cls: 'bdb-tasks-list' });

        for (const task of items) {
          this.createTaskSeparator(listEl);

          const itemEl = listEl.createDiv({ cls: 'bdb-task-item' });
          itemEl.style.display = 'flex';
          itemEl.style.alignItems = 'center';
          itemEl.style.columnGap = '0.5em';
          itemEl.style.rowGap = '0.15em';
          itemEl.style.flexWrap = 'nowrap';

          const status = (task.status || '').trim();
          const isToggleable = status === '' || status === ' ' || status.toLowerCase() === 'x';

          const textEl = itemEl.createSpan({ cls: 'bdb-task-link' });
          textEl.style.display = 'inline-block';
          textEl.style.margin = '0';
          textEl.style.flex = '1';
          textEl.style.minWidth = '0';
          textEl.style.whiteSpace = 'normal';

          // Render the original line so checkbox/status styling matches core/Tasks
          await MarkdownRenderer.renderMarkdown(task.rawLine || task.text, textEl, task.file.path, this.plugin);

          // Ensure internal links inside task text are clickable
          this.plugin.bindInternalLinks(textEl, task.file.path);

          // Attach checkbox handler if toggleable
          const renderedBox = textEl.querySelector('input.task-list-item-checkbox');
          if (renderedBox) {
            if (isToggleable) {
              renderedBox.checked = task.completed;
              renderedBox.addEventListener('change', async () => {
                renderedBox.disabled = true;
                await this.toggleTask(task, renderedBox.checked);
                renderedBox.disabled = false;
              });
            } else {
              renderedBox.disabled = true;
            }
          }

          const metaEl = itemEl.createEl('a', {
            text: ` · ${task.file.basename}:${task.line + 1}`,
            cls: 'bdb-task-meta',
            href: '#',
          });
          metaEl.style.marginLeft = '0.35em';
          metaEl.style.whiteSpace = 'nowrap';
          metaEl.addEventListener('click', (evt) => {
            evt.preventDefault();
            const modEvent = evt.ctrlKey || evt.metaKey;
              this.openFileAtLine(task.file, task.line, modEvent);
          });
        }
        this.createTaskSeparator(listEl);
      return details;
    };

    await renderGroup('Incomplete', incomplete, false);
    if (complete.length) {
      const sep = this.containerEl.createDiv({ cls: 'bdb-task-separator' });
      await renderGroup('Complete', complete, true);
    }
  }
}

class WinsAggregationView extends BasesView {
  constructor(plugin, controller, container) {
    super(controller);
    this.type = BASES_WINS_VIEW_TYPE;
    this.plugin = plugin;
    this.containerEl = container.createDiv('bdb-wins-aggregation');
  }

  load() {
    // Required lifecycle method
  }

  unload() {
    // Required lifecycle method
  }

  openFileAtLine(file, lineNumber, modEvent) {
    const { app } = this;
    const targetLine = Math.max(0, lineNumber || 0);
    app.workspace.openLinkText(file.path, '', modEvent);
    window.setTimeout(() => {
      const leaf = app.workspace.getMostRecentLeaf?.() || app.workspace.activeLeaf;
      const view = leaf?.view;
      const editor = view?.editor;
      if (editor?.setCursor) {
        editor.setCursor({ line: targetLine, ch: 0 });
        if (editor.scrollIntoView) {
          editor.scrollIntoView({
            from: { line: targetLine, ch: 0 },
            to: { line: targetLine + 1, ch: 0 },
          }, true);
        }
      }
    }, 60);
  }

  async onDataUpdated() {
    const { app } = this;
    const data = this.data;

    this.containerEl.empty();

    const config = this.config || {};
    const rawTags = config.get ? config.get('tags') : config.tags;
    const tagList = (rawTags || '#win')
      .split(',')
      .map(t => t.trim())
      .filter(Boolean)
      .map(t => (t.startsWith('#') ? t : `#${t}`));

    const heading = this.containerEl.createEl('h3', { text: tagList.join(', '), cls: 'bdb-wins-heading' });
    heading.style.marginTop = '0';
    heading.style.marginBottom = '0.4em';

    if (!data || !data.groupedData) {
      this.containerEl.createDiv({ text: 'No data available', cls: 'bdb-wins-empty' });
      return;
    }

    const wins = [];

    // Build regex to match any configured hashtag (word-boundary after tag)
    const escapedTags = tagList.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const winRegex = new RegExp(`(${escapedTags.join('|')})\\b`, 'gi');

    for (const group of data.groupedData) {
      for (const entry of group.entries) {
        const file = entry.file;
        if (!(file instanceof TFile)) continue;

        let content = '';
        let lines = [];
        try {
          content = await app.vault.cachedRead(file);
          lines = content.split(/\r?\n/);
        } catch (err) {
          console.warn('backlinks-daily-blocks: read failed', file.path, err);
          continue;
        }

        lines.forEach((line, idx) => {
          winRegex.lastIndex = 0;
          if (winRegex.test(line)) {
            const text = line.trim();
            wins.push({ file, line: idx, text: text || '(win)', raw: line });
          }
        });
      }
    }

    if (!wins.length) {
      this.containerEl.createDiv({ text: 'No records found', cls: 'bdb-wins-empty' });
      return;
    }

    const list = this.containerEl.createDiv({ cls: 'bdb-wins-list' });

    for (const win of wins) {
      this.createWaveSeparator(list, 'rgba(46, 160, 67, 0.85)');
      const li = list.createDiv({ cls: 'bdb-wins-item' });

      // Lay out text and meta similar to tasks view
      const row = li.createDiv({ cls: 'bdb-wins-row' });
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.columnGap = '0.5em';
      row.style.rowGap = '0.15em';
      row.style.flexWrap = 'nowrap';

      // Render win text as markdown so links and tasks are preserved
      const textEl = row.createDiv({ cls: 'bdb-wins-text' });
      textEl.style.cursor = 'pointer';
      textEl.style.flex = '1';
      textEl.style.minWidth = '0';
      await MarkdownRenderer.renderMarkdown(win.raw || win.text, textEl, win.file.path, this.plugin);
      this.plugin.bindInternalLinks(textEl, win.file.path);

      // Make rendered checkboxes toggle the underlying line
      const checkboxes = textEl.querySelectorAll('input.task-list-item-checkbox');
      checkboxes.forEach((box) => {
        if (box.__bdbBound) return;
        box.__bdbBound = true;
        box.addEventListener('change', async () => {
          box.disabled = true;
          try {
            const content = await app.vault.read(win.file);
            const fileLines = content.split(/\r?\n/);
            if (win.line < 0 || win.line >= fileLines.length) return;
            const original = fileLines[win.line];
            const updated = original.replace(/^(\s*[-*]\s*\[)( |x|X)(\])/, `$1${box.checked ? 'x' : ' '}$3`);
            if (updated !== original) {
              fileLines[win.line] = updated;
              await app.vault.modify(win.file, fileLines.join('\n'));
            }
          } catch (err) {
            console.warn('backlinks-daily-blocks: toggle task (wins) failed', win.file.path, err);
          } finally {
            box.disabled = false;
          }
        });
      });

      // Highlight configured hashtags after markdown rendering
      this.highlightHashtags(textEl, winRegex);

      textEl.addEventListener('click', (evt) => {
        const targetEl = evt.target;
        if (targetEl?.closest && targetEl.closest('a, input, button, textarea, select')) return;
        evt.preventDefault();
        const modEvent = evt.ctrlKey || evt.metaKey;
        this.openFileAtLine(win.file, win.line, modEvent);
      });

      // Render meta as an internal link and highlight
      const meta = row.createSpan({ cls: 'bdb-wins-meta' });
      meta.style.marginLeft = '0.35em';
      meta.style.cursor = 'pointer';
      meta.style.color = 'var(--text-accent, #2ea043)';
      meta.style.whiteSpace = 'nowrap';
      const markdown = `[[${win.file.path}|${win.file.basename}:${win.line + 1}]]`;
      await MarkdownRenderer.renderMarkdown(markdown, meta, win.file.path, this.plugin);
      this.plugin.bindInternalLinks(meta, win.file.path);
    }
  }

  createWaveSeparator(parentEl, strokeColor = 'rgba(46, 160, 67, 0.85)') {
    const sep = parentEl.createDiv({ cls: 'bdb-wins-separator' });
    sep.textContent = '';
    sep.style.height = '8px';
    sep.style.width = '100%';
    const svg = encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="8" viewBox="0 0 80 8" preserveAspectRatio="none"><path d="M0 4 Q10 0 20 4 T40 4 T60 4 T80 4" fill="none" stroke="${strokeColor}" stroke-width="1.5" stroke-linecap="round"/></svg>`
    );
    sep.style.backgroundImage = `url("data:image/svg+xml,${svg}")`;
    sep.style.backgroundRepeat = 'repeat-x';
    sep.style.backgroundSize = '80px 8px';
    sep.style.backgroundPosition = 'center';
    sep.style.opacity = '0.9';
    sep.style.margin = '0.4em 0 0.4em 0';
    sep.style.border = 'none';
    sep.style.padding = '0';
    sep.style.borderRadius = '999px';
    sep.style.filter = 'drop-shadow(0 0 2px rgba(0,0,0,0.08))';
    return sep;
  }

  highlightHashtags(container, tagRegex) {
    if (!tagRegex) return;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (const node of nodes) {
      const text = node.nodeValue || '';
      tagRegex.lastIndex = 0;
      if (!tagRegex.test(text)) continue;
      tagRegex.lastIndex = 0;

      const frag = document.createDocumentFragment();
      let lastIndex = 0;
      let match;
      while ((match = tagRegex.exec(text)) !== null) {
        if (match.index > lastIndex) {
          frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }
        const span = document.createElement('span');
        span.textContent = match[1];
        span.className = 'bdb-wins-tag';
        span.style.color = 'var(--text-accent, #2ea043)';
        span.style.fontWeight = '700';
        frag.appendChild(span);
        lastIndex = tagRegex.lastIndex;
      }
      if (lastIndex < text.length) {
        frag.appendChild(document.createTextNode(text.slice(lastIndex)));
      }
      const parent = node.parentNode;
      if (parent) parent.replaceChild(frag, node);
    }
  }
}

module.exports = BacklinksDailyBlocksPlugin;
