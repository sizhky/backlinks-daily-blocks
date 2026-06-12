// Note-content pipeline: read → strip frontmatter → truncate, one place.

function stripFrontmatter(text) {
  return text.replace(/^---\n[\s\S]*?\n---\n/, '');
}

function truncateContent(text, limit) {
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

function isExcalidraw(file) {
  return file.basename.endsWith('.excalidraw');
}

function displayName(file) {
  return isExcalidraw(file) ? file.basename.replace('.excalidraw', '') : file.basename;
}

// Returns { kind: 'excalidraw' | 'markdown' | 'empty', content, lines }.
// `lines` is the raw file split by newline, for callers that map rendered
// elements back to source lines.
async function prepareNote(app, file, { strip = true, truncate = 0 } = {}) {
  if (isExcalidraw(file)) {
    return { kind: 'excalidraw', content: '', lines: [] };
  }

  let raw = '';
  try {
    raw = await app.vault.cachedRead(file);
  } catch (err) {
    console.warn('backlinks-daily-blocks: read failed', file.path, err);
  }

  const lines = raw.split(/\r?\n/);
  let content = strip ? stripFrontmatter(raw || '') : raw;
  content = truncateContent(content, truncate);

  if (!content.trim()) {
    return { kind: 'empty', content: '', lines };
  }
  return { kind: 'markdown', content, lines };
}

module.exports = { stripFrontmatter, truncateContent, isExcalidraw, displayName, prepareNote };
