// Beacon: surfaces lines tagged with configured hashtags (e.g. #win),
// plus open tasks from notes carrying the plural form of a tag.

const { BdbBasesView } = require('./base');
const { renderInteractive, wireTaskCheckboxes, openFileAtLine } = require('../core/render');

const BEACON_VIEW_TYPE = 'hashtags-aggregation-view';

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class BeaconView extends BdbBasesView {
  constructor(plugin, controller, parentEl) {
    super(plugin, controller, parentEl, BEACON_VIEW_TYPE, 'bdb-wins-aggregation');
  }

  buildPluralTagList(tagList) {
    const out = new Set();
    for (const tag of tagList) {
      const base = (tag || '').replace(/^#/, '').trim().toLowerCase();
      if (!base) continue;
      const add = (value) => {
        if (value && value !== base) out.add(`#${value}`);
      };
      if (!base.endsWith('s')) add(`${base}s`);
      if (base.endsWith('y') && base.length > 1) add(`${base.slice(0, -1)}ies`);
      if (/(s|x|z|ch|sh)$/.test(base)) add(`${base}es`);
    }
    return Array.from(out);
  }

  async collectWins(winRegex, pluralTagRegex) {
    const { app } = this;
    const wins = [];

    for (const entry of this.fileEntries()) {
      const file = entry.file;

      let lines = [];
      try {
        const content = await app.vault.cachedRead(file);
        lines = content.split(/\r?\n/);
      } catch (err) {
        console.warn('backlinks-daily-blocks: read failed', file.path, err);
        continue;
      }

      let hasPluralTag = false;
      if (pluralTagRegex) {
        for (const line of lines) {
          pluralTagRegex.lastIndex = 0;
          if (pluralTagRegex.test(line)) {
            hasPluralTag = true;
            break;
          }
        }
      }

      let inFrontmatter = lines[0]?.trim() === '---';
      lines.forEach((line, idx) => {
        winRegex.lastIndex = 0;
        if (winRegex.test(line)) {
          const text = line.trim();
          wins.push({ file, line: idx, text: text || '(win)', raw: line });
          return;
        }

        // Notes carrying a plural tag (e.g. #wins) contribute their open tasks
        if (!hasPluralTag) return;

        const trimmed = line.trim();
        if (!trimmed) return;

        if (inFrontmatter) {
          if (idx > 0 && trimmed === '---') inFrontmatter = false;
          return;
        }

        if (/^#{1,6}\s/.test(trimmed)) return;
        if (/^>\s*$/.test(trimmed)) return;
        if (pluralTagRegex) {
          pluralTagRegex.lastIndex = 0;
          if (pluralTagRegex.test(trimmed) && !/\s/.test(trimmed)) return;
        }
        if (!/^\s*[-*]\s+\[\s\]\s+/.test(line)) return;

        wins.push({ file, line: idx, text: trimmed, raw: line });
      });
    }

    return wins;
  }

  async onDataUpdated() {
    this.containerEl.empty();

    const tagList = (this.getOption('tags') || '#win')
      .split(',')
      .map(t => t.trim())
      .filter(Boolean)
      .map(t => (t.startsWith('#') ? t : `#${t}`));

    this.containerEl.createEl('h3', { text: tagList.join(', '), cls: 'bdb-wins-heading' });

    if (!this.data?.groupedData) {
      this.containerEl.createDiv({ text: 'No data available', cls: 'bdb-wins-empty' });
      return;
    }

    // Build regexes matching any configured hashtag (word-boundary after tag)
    const escapedTags = tagList.map(escapeRegex);
    const winRegex = new RegExp(`(${escapedTags.join('|')})\\b`, 'gi');
    const escapedPluralTags = this.buildPluralTagList(tagList).map(escapeRegex);
    const pluralTagRegex = escapedPluralTags.length ? new RegExp(`(${escapedPluralTags.join('|')})\\b`, 'gi') : null;
    const highlightRegex = escapedPluralTags.length
      ? new RegExp(`(${escapedTags.concat(escapedPluralTags).join('|')})\\b`, 'gi')
      : winRegex;

    const wins = await this.collectWins(winRegex, pluralTagRegex);

    if (!wins.length) {
      this.containerEl.createDiv({ text: 'No records found', cls: 'bdb-wins-empty' });
      return;
    }

    const list = this.containerEl.createDiv({ cls: 'bdb-wins-list' });

    for (const win of wins) {
      this.waveSeparator(list, 'green');
      const li = list.createDiv({ cls: 'bdb-wins-item' });
      const row = li.createDiv({ cls: 'bdb-wins-row' });

      // Render win text as markdown so links and tasks are preserved
      const textEl = row.createDiv({ cls: 'bdb-wins-text' });
      await renderInteractive(this.plugin, win.raw || win.text, textEl, win.file.path);
      wireTaskCheckboxes(this.plugin, textEl, win.file, () => win.line);
      this.highlightHashtags(textEl, highlightRegex);

      textEl.addEventListener('click', (evt) => {
        const targetEl = evt.target;
        if (targetEl?.closest && targetEl.closest('a, input, button, textarea, select')) return;
        evt.preventDefault();
        const modEvent = evt.ctrlKey || evt.metaKey;
        openFileAtLine(this.app, win.file, win.line, modEvent);
      });

      // Render meta as an internal link
      const meta = row.createSpan({ cls: 'bdb-wins-meta' });
      const markdown = `[[${win.file.path}|${win.file.basename}:${win.line + 1}]]`;
      await renderInteractive(this.plugin, markdown, meta, win.file.path);
    }
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

module.exports = { BeaconView, BEACON_VIEW_TYPE };
