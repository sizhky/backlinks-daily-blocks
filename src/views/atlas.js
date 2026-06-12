// Atlas: aggregates frontmatter properties across the filtered files
// and syncs them into the host note's frontmatter.

const { TFile } = require('obsidian');
const { BdbBasesView } = require('./base');

const ATLAS_VIEW_TYPE = 'properties-aggregation-view';

class AtlasView extends BdbBasesView {
  constructor(plugin, controller, parentEl) {
    super(plugin, controller, parentEl, ATLAS_VIEW_TYPE, 'bdb-properties-aggregation');
    this.frontmatterUpdating = false;
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

    const updates = {};

    for (const [propertyKey, valueMap] of aggregatedData) {
      const values = Array.from(valueMap.values())
        .map((info) => {
          const display = (info?.displayName || info?.key || '').toString().trim();
          if (!display) return '';
          // Preserve link targets by emitting wiki-link syntax when available
          if (info?.linkPath) {
            const targetName = info.linkPath.split('/').pop()?.replace(/\.md$/i, '') || '';
            const normalizedDisplay = display.replace(/\.md$/i, '');
            if (targetName && normalizedDisplay === targetName) {
              return `[[${info.linkPath}]]`;
            }
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

    if (!this.data?.groupedData) {
      this.containerEl.createDiv({ text: 'No data available', cls: 'bdb-properties-empty' });
      return;
    }

    const blacklistRaw = this.getOption('propertyBlacklist') ?? 'file,journal,journal-date,aliases,captured-from';
    const excludeProperties = String(blacklistRaw)
      .split(',')
      .map(p => p.trim())
      .filter(Boolean);
    if (!excludeProperties.includes('aliases')) excludeProperties.push('aliases');

    const dateEntries = Array.from(this.fileEntries())
      .filter(entry => entry.file.basename.startsWith(targetDatePrefix));

    // First pass: discover all unique property keys
    const allPropertyKeys = new Set();
    for (const entry of dateEntries) {
      const cache = app.metadataCache.getFileCache(entry.file);
      if (!cache?.frontmatter) continue;
      for (const key of Object.keys(cache.frontmatter)) {
        if (key !== 'position' && !excludeProperties.includes(key)) {
          allPropertyKeys.add(key);
        }
      }
    }

    if (!allPropertyKeys.size) {
      this.containerEl.createDiv({ text: 'No properties found', cls: 'bdb-properties-empty' });
      return;
    }

    // Second pass: aggregate values for each property
    const aggregatedData = new Map();

    for (const propertyKey of allPropertyKeys) {
      const propertyMap = this.aggregateProperty(propertyKey, dateEntries);
      if (propertyMap.size > 0) {
        aggregatedData.set(propertyKey, propertyMap);
      }
    }

    if (!aggregatedData.size) {
      this.containerEl.createDiv({ text: 'No properties found', cls: 'bdb-properties-empty' });
      return;
    }

    // Push aggregated values into the current note's frontmatter
    await this.updateFrontmatterWithAggregates(aggregatedData);

    // Skip visual render to avoid redundancy with frontmatter
    this.containerEl.createDiv({ text: 'Properties synced to frontmatter.', cls: 'bdb-properties-synced' });
  }

  isPresenceOnlyProperty(propertyKey) {
    const propertyInfo = this.app.metadataTypeManager?.getPropertyInfo(propertyKey);
    if (propertyInfo?.type === 'checkbox') return true;

    // If not registered, infer "presence-only" properties.
    // Treat boolean and empty-string values as presence markers so keys like
    // `wash-dishes: ''` can still be aggregated/synced.
    for (const entry of this.fileEntries()) {
      const cache = this.app.metadataCache.getFileCache(entry.file);
      if (!cache?.frontmatter) continue;
      const rawValue = cache.frontmatter[propertyKey];
      const isPresenceLike =
        rawValue === undefined ||
        rawValue === null ||
        typeof rawValue === 'boolean' ||
        rawValue === '';
      if (!isPresenceLike) return false;
    }
    return true;
  }

  aggregateProperty(propertyKey, dateEntries) {
    const propertyMap = new Map();
    const isCheckbox = this.isPresenceOnlyProperty(propertyKey);

    for (const entry of dateEntries) {
      const file = entry.file;
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache?.frontmatter) continue;
      if (!(propertyKey in cache.frontmatter)) continue;

      const rawValue = cache.frontmatter[propertyKey];

      // Presence-only properties: the source note itself is the value,
      // displayed as its HHmm timestamp.
      if (isCheckbox) {
        const timeMatch = file.basename.match(/\d{8}-(\d{4})/);
        const timestamp = timeMatch ? timeMatch[1] : file.basename;
        this.addToPropertyMap(propertyMap, file.path, timestamp, file.path, file);
        continue;
      }

      if (rawValue === undefined || rawValue === null) continue;

      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      for (const val of values) {
        const parsed = this.parsePropertyValue(val);
        if (!parsed) continue;
        this.addToPropertyMap(propertyMap, parsed.key, parsed.displayName, parsed.linkPath, file);
      }
    }

    return propertyMap;
  }

  parsePropertyValue(val) {
    if (val && typeof val === 'object' && val.path) {
      // It's already a link object from Obsidian
      return {
        key: val.path,
        linkPath: val.path,
        displayName: val.display || val.path.split('/').pop().replace('.md', ''),
      };
    }

    const strVal = String(val);
    const wikiLinkMatch = strVal.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/);
    if (wikiLinkMatch) {
      return {
        key: wikiLinkMatch[1],
        linkPath: wikiLinkMatch[1],
        displayName: wikiLinkMatch[2] || wikiLinkMatch[1].split('/').pop(),
      };
    }

    return { key: strVal, linkPath: null, displayName: strVal };
  }

  addToPropertyMap(propertyMap, key, displayName, linkPath, file) {
    if (!propertyMap.has(key)) {
      propertyMap.set(key, { displayName, linkPath, sources: [] });
    }
    propertyMap.get(key).sources.push({ file, basename: file.basename });
  }
}

module.exports = { AtlasView, ATLAS_VIEW_TYPE };
