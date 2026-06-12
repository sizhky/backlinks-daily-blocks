// Shared base for all Bases views: lifecycle, config access,
// entry iteration, wave separators.

const { BasesView, TFile } = require('obsidian');

class BdbBasesView extends BasesView {
  constructor(plugin, controller, parentEl, type, containerCls) {
    super(controller);
    this.type = type;
    this.plugin = plugin;
    this.containerEl = parentEl.createDiv(containerCls);
  }

  load() {}

  unload() {}

  getOption(key) {
    const config = this.config || {};
    return config.get ? config.get(key) : config[key];
  }

  // Yields every TFile entry across grouped data.
  *fileEntries() {
    if (!this.data?.groupedData) return;
    for (const group of this.data.groupedData) {
      for (const entry of group.entries) {
        if (entry.file instanceof TFile) yield entry;
      }
    }
  }

  // variant: 'red' | 'green' | 'green-thin' (see styles.css)
  waveSeparator(parentEl, variant = 'red') {
    return parentEl.createDiv({ cls: `bdb-wave-sep bdb-wave-sep--${variant}` });
  }
}

module.exports = { BdbBasesView };
