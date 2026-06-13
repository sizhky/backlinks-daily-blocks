const { Plugin } = require('obsidian');
const { renderBacklinksBlock, renderDailyBlock } = require('./blocks');
const { renderKanbanBlock } = require('./kanban');
const { renderEiBlock } = require('./ei');
const { BdbSettingTab, mergeSettings } = require('./settings');
const { ChronicleView, CHRONICLE_VIEW_TYPE } = require('./views/chronicle');
const { AtlasView, ATLAS_VIEW_TYPE } = require('./views/atlas');
const { LedgerView, LEDGER_VIEW_TYPE } = require('./views/ledger');
const { BeaconView, BEACON_VIEW_TYPE } = require('./views/beacon');

class BacklinksDailyBlocksPlugin extends Plugin {
  async onload() {
    this.settings = mergeSettings(await this.loadData());
    this.addSettingTab(new BdbSettingTab(this));

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
