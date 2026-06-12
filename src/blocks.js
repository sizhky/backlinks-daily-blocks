// ```backlinks``` and ```daily``` code block renderers.

const { TFile, MarkdownRenderer, parseYaml, moment } = require('obsidian');
const { prepareNote, displayName, isExcalidraw } = require('./core/notes');

function parseOptions(source, defaults) {
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

  // A plain string body sets the target (backlinks) or date (daily)
  const fallbackKey = defaults.hasOwnProperty('target') ? 'target' : defaults.hasOwnProperty('date') ? 'date' : 'value';
  return { ...base, [fallbackKey]: raw };
}

async function renderNoteSection(plugin, el, ctx, file, options, { asQuote }) {
  const section = el.createEl('div', { cls: asQuote ? 'bdb-backlink' : 'bdb-daily' });
  section.createEl('h4', { text: displayName(file) });

  if (isExcalidraw(file)) {
    const embed = `![[${file.path}${options.size ? '|' + options.size : ''}]]`;
    await MarkdownRenderer.renderMarkdown(embed, section, ctx.sourcePath, plugin);
    return;
  }

  const note = await prepareNote(plugin.app, file, { strip: true, truncate: options.truncate });
  const content = note.kind === 'empty' ? '(empty note)' : note.content;

  const markdown = asQuote
    ? `> [[${file.path}|${file.basename}]]\n>\n> ${content.replace(/\n/g, '\n> ')}`
    : `${content}\n`;
  await MarkdownRenderer.renderMarkdown(markdown, section, ctx.sourcePath, plugin);
}

async function renderBacklinksBlock(plugin, source, el, ctx) {
  const { app } = plugin;
  const options = parseOptions(source, {
    target: null,
    ...(plugin.settings?.backlinks || { sort: 'ctime', limit: 20, truncate: 400, heading: 'Backlinks' }),
  });

  const currentPath = ctx.sourcePath;
  const targetFile = options.target
    ? app.metadataCache.getFirstLinkpathDest(options.target, currentPath || '')
    : app.vault.getAbstractFileByPath(currentPath);

  if (!(targetFile instanceof TFile)) {
    el.createEl('div', { text: `Target note not found: ${options.target || '(current file)'}` });
    return;
  }

  const backlinks = app.metadataCache.getBacklinksForFile(targetFile);
  const entries = [];

  if (backlinks?.data) {
    for (const [path] of backlinks.data.entries()) {
      const file = app.vault.getAbstractFileByPath(path);
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
    await renderNoteSection(plugin, el, ctx, file, options, { asQuote: true });
  }
}

async function renderDailyBlock(plugin, source, el, ctx) {
  const { app } = plugin;
  const options = parseOptions(source, {
    date: null,
    size: '100%',
    ...(plugin.settings?.daily || { order: 'desc', limit: 0, truncate: 800, includeCurrent: false, heading: 'Daily notes' }),
  });

  let targetDate = (options.date || '').replace(/[^0-9]/g, '');
  if (!targetDate) {
    const match = ctx.sourcePath.match(/(\d{8})-\d{4}/);
    targetDate = match ? match[1] : moment().format('YYYYMMDD');
  }
  targetDate = targetDate.substring(0, 8);

  const pattern = /^\d{8}-\d{4}(?:\.excalidraw)?\.md$/;
  const files = app.vault.getFiles().filter((file) => {
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
    await renderNoteSection(plugin, el, ctx, file, options, { asQuote: false });
  }
}

module.exports = { renderBacklinksBlock, renderDailyBlock };
