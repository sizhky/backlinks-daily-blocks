// Chronicle: vertical content feed of all filtered files.

const { BdbBasesView } = require('./base');
const { prepareNote, displayName, isExcalidraw } = require('../core/notes');
const { renderInteractive, wireTaskCheckboxes } = require('../core/render');
const { TASK_LINE_RE } = require('../core/tasks');

const CHRONICLE_VIEW_TYPE = 'content-feed-bases-view';

class ChronicleView extends BdbBasesView {
  constructor(plugin, controller, parentEl) {
    super(plugin, controller, parentEl, CHRONICLE_VIEW_TYPE, 'bases-content-feed-container');
  }

  async onDataUpdated() {
    const { app } = this;
    this.containerEl.empty();

    if (!this.data) {
      this.containerEl.createDiv({ text: 'Loading...' });
      return;
    }

    const stripFrontmatter = this.getOption('stripFrontmatter') !== false;

    // Preserve zero to disable truncation; fall back only if the value is invalid
    let truncateLength = Number(this.getOption('truncateLength'));
    if (!Number.isFinite(truncateLength) || truncateLength < 0) {
      truncateLength = 0;
    }
    const titleProperty = String(this.getOption('titleProperty') || 'note.categories');

    const allEntries = Array.from(this.fileEntries());
    if (!allEntries.length) {
      this.containerEl.createDiv({ text: 'No entries found.' });
      return;
    }

    for (const entry of allEntries) {
      const file = entry.file;
      const note = await prepareNote(app, file, { strip: stripFrontmatter, truncate: truncateLength });
      if (note.kind === 'empty') continue;

      this.waveSeparator(this.containerEl, 'red');

      const section = this.containerEl.createDiv('bdb-bases-entry');

      const titleEl = section.createEl('h4');
      const linkEl = titleEl.createEl('a', { text: displayName(file), cls: 'bdb-bases-title-link' });
      linkEl.addEventListener('click', (evt) => {
        evt.preventDefault();
        const modEvent = evt.ctrlKey || evt.metaKey;
        app.workspace.openLinkText(file.path, '', modEvent);
      });

      await this.renderTitleProperty(titleEl, entry, titleProperty, file);

      if (isExcalidraw(file)) {
        await renderInteractive(this.plugin, `![[${file.path}|100%]]`, section, file.path);
        continue;
      }

      await renderInteractive(this.plugin, `${note.content}\n`, section, file.path);
      this.attachTaskCheckboxHandlers(section, file, note.lines);
    }

    // Trailing separator after the last entry
    this.waveSeparator(this.containerEl, 'red');
  }

  async renderTitleProperty(titleEl, entry, titleProperty, file) {
    if (!titleProperty) return;
    const propertyValue = entry.getValue(titleProperty);
    if (!propertyValue?.data || !Array.isArray(propertyValue.data)) return;

    const valueLinks = propertyValue.data
      .filter(val => val)
      .map(val => {
        if (val && val.path) {
          const label = val.display || val.path.split('/').pop().replace('.md', '');
          return `[[${val.path}|${label}]]`;
        }
        return String(val);
      });

    if (!valueLinks.length) return;
    const propertySpan = titleEl.createSpan({ cls: 'bdb-bases-categories' });
    await renderInteractive(this.plugin, ` (${valueLinks.join(', ')})`, propertySpan, file.path);
  }

  // Map the i-th rendered checkbox to the i-th task list item from the
  // metadata cache (best-effort match, same order as rendered markdown).
  attachTaskCheckboxHandlers(container, file, rawLines) {
    if (!rawLines?.length) return;

    const listItems = this.app.metadataCache.getFileCache(file)?.listItems || [];
    const taskItems = listItems.filter((item) => {
      const line = item?.position?.start?.line;
      if (line == null) return false;
      return TASK_LINE_RE.test(rawLines[line] || '');
    });

    wireTaskCheckboxes(this.plugin, container, file, (i) => {
      const line = taskItems[i]?.position?.start?.line;
      if (line == null || line < 0 || line >= rawLines.length) return null;
      return line;
    });
  }
}

module.exports = { ChronicleView, CHRONICLE_VIEW_TYPE };
