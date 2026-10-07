// Task-line editing: the one place that flips a checkbox in a source file.

const TASK_CHECKBOX_RE = /^(\s*[-*]\s*\[)( |x|X)(\])/;
const TASK_LINE_RE = /^\s*[-*]\s*\[[ xX]\]/;

async function setTaskOnLine(app, file, line, checked) {
  try {
    // Atomic read-modify-write (vault.process), like kanban.js editLines.
    let changed = false;
    await app.vault.process(file, content => {
      const lines = content.split(/\r?\n/);
      if (line == null || line < 0 || line >= lines.length) return content;
      const updated = lines[line].replace(TASK_CHECKBOX_RE, `$1${checked ? 'x' : ' '}$3`);
      if (updated === lines[line]) return content;
      lines[line] = updated;
      changed = true;
      return lines.join('\n');
    });
    return changed;
  } catch (err) {
    console.warn('backlinks-daily-blocks: toggle task failed', file?.path, err);
    return false;
  }
}

module.exports = { TASK_CHECKBOX_RE, TASK_LINE_RE, setTaskOnLine };
