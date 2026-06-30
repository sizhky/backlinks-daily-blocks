// Snapshot a note's PROPERTIES (frontmatter) into a reusable, provenance-stamped
// template. Body is intentionally dropped — only props travel. Notes later created
// from the template inherit `template`/`template-version`, the breadcrumb that lets
// a future "propagate" walk find every note of a type and back-fill new props.
//
// Pipeline is four seams so features slot in without touching the rest:
//   extract -> select -> serialize -> write
// Today `select` returns everything; swap in a multi-select UI later, default all.
const { stringifyYaml, normalizePath, Modal, Setting } = require('obsidian');

const TEMPLATE_DIR = '90-99 Obsidian Meta/Templates';
const PROVENANCE_KEYS = ['template', 'template-version'];

// Active note's frontmatter as a plain object, minus Obsidian's injected `position`.
function extractProps(plugin, file) {
  const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter || {};
  const { position, ...props } = fm;
  return props;
}

// Which props make it into the template. v1: all of them.
// Future seam: present props multi-selected, let the user deselect dynamic ones.
function selectProps(props) {
  return props;
}

// Template file body: selected props as YAML, with the provenance stamp forced last
// so it wins even if the source note was itself made from a template.
function serializeTemplate(props, { name, version }) {
  const rest = { ...props };
  for (const k of PROVENANCE_KEYS) delete rest[k];
  const body = { ...rest, template: name, 'template-version': version };
  return `---\n${stringifyYaml(body)}---\n`;
}

async function ensureDir(plugin, dir) {
  const norm = normalizePath(dir);
  if (!plugin.app.vault.getAbstractFileByPath(norm)) {
    await plugin.app.vault.createFolder(norm).catch(() => {}); // race / already-exists is fine
  }
}

// Vault-relative folder for templates. Tolerates a pasted absolute path by
// stripping the vault's base path (desktop adapter exposes `basePath`).
function templateDir(plugin) {
  let dir = plugin.settings?.templates?.dir || TEMPLATE_DIR;
  const base = plugin.app.vault.adapter?.basePath;
  if (base && dir.startsWith(base)) dir = dir.slice(base.length);
  return normalizePath(dir.replace(/^\/+/, ''));
}

// Write the template, refusing to clobber an existing one. Returns its path.
async function writeTemplate(plugin, name, content) {
  const dir = templateDir(plugin);
  const path = normalizePath(`${dir}/${name}.md`);
  if (plugin.app.vault.getAbstractFileByPath(path)) {
    throw new Error(`template exists: ${path} (rename or delete it first)`);
  }
  await ensureDir(plugin, dir);
  await plugin.app.vault.create(path, content);
  return path;
}

// Orchestrator: snapshot the active note's props into a new named template.
async function saveTemplate(plugin, name) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('template name required: kb.saveTemplate("Project ABC")');
  const file = plugin.app.workspace.getActiveFile();
  if (!file) throw new Error('no active note');
  const props = selectProps(extractProps(plugin, file));
  const content = serializeTemplate(props, { name: clean, version: 1 });
  const path = await writeTemplate(plugin, clean, content);
  return `ok template -> ${path}`;
}

// Tiny one-field modal: resolves to the trimmed name, or null if dismissed.
class NameModal extends Modal {
  constructor(app, defaultName, onSubmit) {
    super(app);
    this.value = defaultName || '';
    this.onSubmit = onSubmit;
    this.done = false;
  }
  onOpen() {
    this.titleEl.setText('Save properties as template');
    new Setting(this.contentEl)
      .setName('Template name')
      .addText(t => {
        t.setValue(this.value).onChange(v => { this.value = v; });
        t.inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') this.submit(); });
        setTimeout(() => { t.inputEl.focus(); t.inputEl.select(); }, 0);
      });
    new Setting(this.contentEl).addButton(b =>
      b.setButtonText('Save').setCta().onClick(() => this.submit()));
  }
  submit() { this.done = true; this.close(); this.onSubmit(this.value.trim() || null); }
  onClose() { this.contentEl.empty(); if (!this.done) this.onSubmit(null); }
}

// Command entry point: prompt for a name (default = active note's basename), then save.
async function saveTemplateCommand(plugin) {
  const { Notice } = require('obsidian');
  const file = plugin.app.workspace.getActiveFile();
  if (!file) { new Notice('No active note'); return; }
  new NameModal(plugin.app, file.basename, async (name) => {
    if (!name) return;
    try { new Notice(await saveTemplate(plugin, name)); }
    catch (e) { new Notice('Template failed: ' + e.message); }
  }).open();
}

module.exports = {
  saveTemplate, saveTemplateCommand, extractProps, selectProps, serializeTemplate,
  writeTemplate, NameModal, TEMPLATE_DIR, PROVENANCE_KEYS,
};
