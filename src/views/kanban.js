const { BdbBasesView } = require('./base');
const { resolveKanbanConfig, drawBoard } = require('../kanban');

const KANBAN_VIEW_TYPE = 'kanban-bases-view';

class KanbanView extends BdbBasesView {
  constructor(plugin, controller, parentEl) {
    super(plugin, controller, parentEl, KANBAN_VIEW_TYPE, 'bdb-kanban bdb-kanban-bases');
    this.state = { dragging: false };
  }

  load() {
    this.timer = window.setInterval(() => {
      if (!this.state.dragging) (this.state.timeUpdaters || []).forEach(update => update());
    }, 60000);
  }

  unload() {
    window.clearInterval(this.timer);
  }

  async onDataUpdated() {
    const paths = new Set([...this.fileEntries()].map(entry => entry.file.path));
    const config = resolveKanbanConfig(this.plugin, '', null);
    config.cacheFilter = (_cache, file) => paths.has(file.path);
    await drawBoard(this.plugin, this.containerEl, config, this.state);
  }
}

module.exports = { KanbanView, KANBAN_VIEW_TYPE };
