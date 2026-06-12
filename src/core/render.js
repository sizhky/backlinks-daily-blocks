// Rendered-markdown interactivity: render, bind internal links, wire
// task checkboxes back to source lines, navigate to a file:line.

const { MarkdownRenderer } = require('obsidian');
const { setTaskOnLine } = require('./tasks');

function bindInternalLinks(app, container, sourcePath) {
  const anchors = container.querySelectorAll('a.internal-link');
  for (const anchor of anchors) {
    if (anchor.__bdbBound) continue;
    anchor.__bdbBound = true;
    anchor.addEventListener('click', (evt) => {
      evt.preventDefault();
      const link = anchor.getAttribute('href') || anchor.dataset?.href;
      if (!link) return;
      const modEvent = evt.ctrlKey || evt.metaKey;
      app.workspace.openLinkText(link, sourcePath || '', modEvent);
    });
  }
}

// Render markdown into `el` and make internal links open via Obsidian.
async function renderInteractive(plugin, markdown, el, sourcePath) {
  await MarkdownRenderer.renderMarkdown(markdown, el, sourcePath, plugin);
  bindInternalLinks(plugin.app, el, sourcePath);
}

// Wire every rendered checkbox in `container` to a source line of `file`.
// `resolveLine(index)` maps the i-th checkbox to a line number (or null to skip).
function wireTaskCheckboxes(plugin, container, file, resolveLine, { onToggled } = {}) {
  const boxes = container.querySelectorAll('input.task-list-item-checkbox');
  let i = -1;
  for (const box of boxes) {
    i++;
    if (box.__bdbBound) continue;
    box.__bdbBound = true;

    const line = resolveLine(i);
    if (line == null) continue;

    box.addEventListener('change', async () => {
      box.disabled = true;
      await setTaskOnLine(plugin.app, file, line, box.checked);
      box.disabled = false;
      if (onToggled) onToggled();
    });
  }
}

function openFileAtLine(app, file, lineNumber, modEvent) {
  const targetLine = Math.max(0, lineNumber || 0);
  app.workspace.openLinkText(file.path, '', modEvent);
  // Let the workspace open the leaf, then move the cursor/scroll.
  window.setTimeout(() => {
    const leaf = app.workspace.getMostRecentLeaf?.() || app.workspace.activeLeaf;
    const editor = leaf?.view?.editor;
    if (editor?.setCursor) {
      editor.setCursor({ line: targetLine, ch: 0 });
      if (editor.scrollIntoView) {
        editor.scrollIntoView({
          from: { line: targetLine, ch: 0 },
          to: { line: targetLine + 1, ch: 0 },
        }, true);
      }
    }
  }, 60);
}

module.exports = { bindInternalLinks, renderInteractive, wireTaskCheckboxes, openFileAtLine };
