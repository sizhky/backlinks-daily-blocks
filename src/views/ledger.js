// Ledger: aggregates tasks across the filtered files, grouped
// Incomplete/Complete with optional frontmatter-property subgroups.

const { BdbBasesView } = require('./base');
const { setTaskOnLine } = require('../core/tasks');
const { renderInteractive, openFileAtLine } = require('../core/render');

const LEDGER_VIEW_TYPE = 'tasks-aggregation-view';

class LedgerView extends BdbBasesView {
  constructor(plugin, controller, parentEl) {
    super(plugin, controller, parentEl, LEDGER_VIEW_TYPE, 'bdb-tasks-aggregation');
    this.controllerRef = controller;
  }

  captureOpenGroupState() {
    const openGroups = new Set();
    const detailsEls = this.containerEl.querySelectorAll('details[open][data-bdb-group-id]');
    detailsEls.forEach((el) => {
      const id = el.getAttribute('data-bdb-group-id');
      if (id) openGroups.add(id);
    });
    return openGroups;
  }

  resolveGroupBy() {
    const taskGroupByRaw = this.getOption('taskGroupBy');
    const legacyGroupByRaw = this.getOption('groupBy');
    const controllerObj = this.controllerRef || this.controller || {};
    const controllerView = controllerObj.view || controllerObj.viewDefinition || controllerObj.definition || controllerObj.options;
    const viewGroupBy = controllerView?.groupBy;

    const groupByRaw = taskGroupByRaw || viewGroupBy?.property || viewGroupBy || legacyGroupByRaw;

    // Migrate legacy stored key to the new taskGroupBy to persist across reloads
    const config = this.config || {};
    if (!taskGroupByRaw && legacyGroupByRaw && config.set) {
      config.set('taskGroupBy', legacyGroupByRaw);
    }

    if (groupByRaw && typeof groupByRaw === 'object') {
      return (groupByRaw.property || '').toString().trim();
    }
    return groupByRaw ? groupByRaw.toString().trim() : '';
  }

  extractGroupValues(cache, groupBy) {
    if (!groupBy) return [];
    const rawVal = cache?.frontmatter ? cache.frontmatter[groupBy] : undefined;
    const values = Array.isArray(rawVal) ? rawVal : (rawVal !== undefined && rawVal !== null ? [rawVal] : []);

    return values
      .map(val => {
        if (val && typeof val === 'object') {
          if (val.path) {
            const key = val.path;
            const label = (val.display || val.path.split('/').pop() || '').replace(/\.md$/, '');
            return { key, label: label || key };
          }
          return null;
        }

        const strVal = String(val).trim();
        if (!strVal) return null;

        const wikiLinkMatch = strVal.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/);
        if (wikiLinkMatch) {
          const key = wikiLinkMatch[1];
          const label = (wikiLinkMatch[2] || wikiLinkMatch[1]).replace(/\.md$/, '').split('/').pop();
          return { key, label: label || key };
        }

        const trimmed = strVal.replace(/\.md$/, '');
        return { key: strVal, label: trimmed.split('/').pop() || trimmed };
      })
      .filter(Boolean);
  }

  async collectTasks(groupBy, includeCompleted, contains) {
    const { app } = this;
    const tasks = [];

    for (const entry of this.fileEntries()) {
      const file = entry.file;
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
          groupValues: this.extractGroupValues(cache, groupBy),
        });
      }
    }

    return tasks;
  }

  async onDataUpdated() {
    const openGroupState = this.captureOpenGroupState();
    this.containerEl.empty();

    if (!this.data?.groupedData) {
      this.containerEl.createDiv({ text: 'No data available', cls: 'bdb-tasks-empty' });
      return;
    }

    const includeCompleted = this.getOption('includeCompleted') !== false;
    const contains = (this.getOption('contains') || '').toString().trim().toLowerCase();
    const groupBy = this.resolveGroupBy();
    const foldSubgroups = this.getOption('foldSubgroups') !== false;

    const tasks = await this.collectTasks(groupBy, includeCompleted, contains);

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

    const shouldBeOpen = (groupId, defaultOpen) => {
      if (!openGroupState.size) return defaultOpen;
      return openGroupState.has(groupId);
    };

    await this.renderGroup('Incomplete', incomplete, false, groupBy, foldSubgroups, shouldBeOpen);
    if (complete.length) {
      this.containerEl.createDiv({ cls: 'bdb-task-separator' });
      await this.renderGroup('Complete', complete, true, groupBy, foldSubgroups, shouldBeOpen);
    }
  }

  async renderTaskList(listEl, items) {
    for (const task of items) {
      const itemEl = listEl.createDiv({ cls: 'bdb-task-item' });

      const status = (task.status || '').trim();
      const isToggleable = status === '' || status === ' ' || status.toLowerCase() === 'x';

      const textEl = itemEl.createSpan({ cls: 'bdb-task-link' });

      // Render the original line so checkbox/status styling matches core/Tasks
      await renderInteractive(this.plugin, task.rawLine || task.text, textEl, task.file.path);

      const renderedBox = textEl.querySelector('input.task-list-item-checkbox');
      if (renderedBox) {
        if (isToggleable) {
          renderedBox.checked = task.completed;
          renderedBox.addEventListener('change', async () => {
            renderedBox.disabled = true;
            await setTaskOnLine(this.app, task.file, task.line, renderedBox.checked);
            renderedBox.disabled = false;
            this.onDataUpdated(); // Refresh to reflect new state
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
      metaEl.addEventListener('click', (evt) => {
        evt.preventDefault();
        const modEvent = evt.ctrlKey || evt.metaKey;
        openFileAtLine(this.app, task.file, task.line, modEvent);
      });

      this.waveSeparator(listEl, 'green-thin');
    }
  }

  async renderGroup(title, items, collapsedByDefault, groupBy, foldSubgroups, shouldBeOpen) {
    const topGroupId = `top:${title}`;
    const details = this.containerEl.createEl('details', { cls: 'bdb-task-group' });
    details.setAttr('data-bdb-group-id', topGroupId);
    if (shouldBeOpen(topGroupId, !collapsedByDefault)) details.setAttr('open', 'open');
    details.createEl('summary', { text: `${title} (${items.length})`, cls: 'bdb-task-group-title' });
    const listEl = details.createDiv({ cls: 'bdb-tasks-list' });

    if (!groupBy) {
      await this.renderTaskList(listEl, items);
      return details;
    }

    const groupMap = new Map();
    const unsetGroup = { key: '__ungrouped__', label: '! Unset' };

    for (const task of items) {
      const values = (task.groupValues && task.groupValues.length) ? task.groupValues : [unsetGroup];
      for (const val of values) {
        if (!groupMap.has(val.key)) {
          const label = (val.label && val.label.trim()) || val.key || unsetGroup.label;
          groupMap.set(val.key, { key: val.key, label, items: [] });
        }
        groupMap.get(val.key).items.push(task);
      }
    }

    const orderedGroups = Array.from(groupMap.values()).sort((a, b) => a.label.localeCompare(b.label));

    for (const subgroup of orderedGroups) {
      const subgroupId = `sub:${title}:${subgroup.key}`;
      const subgroupDetails = listEl.createEl('details', { cls: 'bdb-task-subgroup' });
      subgroupDetails.setAttr('data-bdb-group-id', subgroupId);
      if (shouldBeOpen(subgroupId, !foldSubgroups)) subgroupDetails.setAttr('open', 'open');
      const heading = subgroupDetails.createEl('summary', { cls: 'bdb-task-subgroup-title' });

      const labelText = subgroup.label;
      const countText = ` (${subgroup.items.length})`;
      const isUnset = subgroup.key === '__ungrouped__';

      if (groupBy && !isUnset) {
        const linkEl = heading.createEl('a', { text: labelText, cls: 'internal-link', href: '#' });
        linkEl.addEventListener('click', (evt) => {
          evt.preventDefault();
          const modEvent = evt.ctrlKey || evt.metaKey;
          this.app.workspace.openLinkText(subgroup.key, '', modEvent);
        });
        heading.appendText(countText);
      } else {
        heading.setText(labelText + countText);
      }

      const subgroupList = subgroupDetails.createDiv({ cls: 'bdb-task-subgroup-list' });
      await this.renderTaskList(subgroupList, subgroup.items);
    }

    return details;
  }
}

module.exports = { LedgerView, LEDGER_VIEW_TYPE };
