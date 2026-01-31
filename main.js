const { Plugin, MarkdownRenderer, TFile, parseYaml, moment, ItemView, BasesView, setIcon } = require('obsidian');

const VIEW_TYPE = 'backlinks-daily-view';
const BASES_VIEW_TYPE = 'content-feed-bases-view';
const BASES_PROPERTIES_VIEW_TYPE = 'properties-aggregation-view';
const BASES_TASKS_VIEW_TYPE = 'tasks-aggregation-view';

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
    const truncateLength = Number(config.get('truncateLength')) || 800;
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
        try {
          content = await app.vault.cachedRead(file);
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
      try {
        content = await app.vault.cachedRead(file);
      } catch (err) {
        console.warn('backlinks-daily-blocks: read failed', file.path, err);
      }

      if (stripFrontmatter) {
        content = this.plugin.stripFrontmatter(content || '');
      }
      content = this.plugin.truncateContent(content, truncateLength);

      const markdown = `${content}\n`;
      await MarkdownRenderer.renderMarkdown(markdown, section, file.path, this.plugin);
    }
  }
}

class PropertiesAggregationView extends BasesView {
  constructor(plugin, controller, container) {
    super(controller);
    this.type = BASES_PROPERTIES_VIEW_TYPE;
    this.plugin = plugin;
    this.containerEl = container.createDiv('bdb-properties-aggregation');
  }

  load() {
    // Required lifecycle method
  }

  unload() {
    // Required lifecycle method
  }

  async onDataUpdated() {
    const { app } = this;
    const data = this.data;
    
    this.containerEl.empty();
    
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

          const completed = item.task.toLowerCase() === 'x';
          if (!includeCompleted && completed) continue;

          // Only keep markdown task list items like - [ ] or - [x]
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
          if (!/^\s*[-*]\s*\[[ xX]\]/.test(rawLine)) continue;

          const taskText = rawLine.replace(/^\s*[-*]\s*\[[ xX]\]\s*/, '').trim();
          if (contains && !taskText.toLowerCase().includes(contains)) continue;

          tasks.push({
            file,
            line: pos.line,
            text: taskText || '(empty task)',
            completed,
          });
        }
      }
    }

    if (!tasks.length) {
      this.containerEl.createDiv({ text: 'No tasks found', cls: 'bdb-tasks-empty' });
      return;
    }

    tasks.sort((a, b) => {
      const pathCompare = a.file.path.localeCompare(b.file.path);
      if (pathCompare !== 0) return pathCompare;
      return a.line - b.line;
    });

    const incomplete = tasks.filter(t => !t.completed);
    const complete = tasks.filter(t => t.completed);

    const renderGroup = async (title, items, collapsedByDefault) => {
      const details = this.containerEl.createEl('details', { cls: 'bdb-task-group' });
      if (!collapsedByDefault) details.setAttr('open', 'open');
      const summary = details.createEl('summary', { text: `${title} (${items.length})`, cls: 'bdb-task-group-title' });
      const listEl = details.createDiv({ cls: 'bdb-tasks-list' });

      for (const task of items) {
        const itemEl = listEl.createDiv({ cls: 'bdb-task-item' });

        const checkbox = itemEl.createEl('input', {
          type: 'checkbox',
          cls: 'bdb-task-checkbox',
        });
        checkbox.checked = task.completed;
        checkbox.addEventListener('change', async () => {
          checkbox.disabled = true;
          await this.toggleTask(task, checkbox.checked);
          checkbox.disabled = false;
        });

        itemEl.createSpan({
          text: task.text,
          cls: 'bdb-task-link',
        });

        const metaEl = itemEl.createEl('a', {
          text: ` · ${task.file.basename}:${task.line + 1}`,
          cls: 'bdb-task-meta',
          href: '#',
        });
        metaEl.addEventListener('click', (evt) => {
          evt.preventDefault();
          const modEvent = evt.ctrlKey || evt.metaKey;
          this.app.workspace.openLinkText(task.file.path, '', modEvent);
        });
      }

      return details;
    };

    await renderGroup('Incomplete', incomplete, false);
    if (complete.length) {
      await renderGroup('Complete', complete, true);
    }
  }
}

module.exports = BacklinksDailyBlocksPlugin;
