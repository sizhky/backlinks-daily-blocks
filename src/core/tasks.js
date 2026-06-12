// Task-line editing: the one place that flips a checkbox in a source file.

const TASK_CHECKBOX_RE = /^(\s*[-*]\s*\[)( |x|X)(\])/;
const TASK_LINE_RE = /^\s*[-*]\s*\[[ xX]\]/;

async function setTaskOnLine(app, file, line, checked) {
  try {
    const content = await app.vault.read(file);
    const lines = content.split(/\r?\n/);
    if (line == null || line < 0 || line >= lines.length) return false;

    const original = lines[line];
    const updated = original.replace(TASK_CHECKBOX_RE, `$1${checked ? 'x' : ' '}$3`);
    if (updated === original) return false;

    lines[line] = updated;
    await app.vault.modify(file, lines.join('\n'));
    return true;
  } catch (err) {
    console.warn('backlinks-daily-blocks: toggle task failed', file?.path, err);
    return false;
  }
}

module.exports = { TASK_CHECKBOX_RE, TASK_LINE_RE, setTaskOnLine };
