const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadDoingView() {
  const notices = [];
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require(id) {
      if (id === 'obsidian') {
        return {
          ItemView: class {},
          Menu: class {},
          Notice: class { constructor(message) { notices.push(message); } },
          setIcon() {},
        };
      }
      if (id === '../kanban') {
        return {
          cleanText() {},
          resolveKanbanConfig() {},
          scanKanbanTasks() {},
          moveCard: async () => true,
          stampToDate() {},
          columnColor() {},
        };
      }
      if (id === '../core/render') {
        return { renderInteractive() {}, openFileAtLine() {} };
      }
      throw new Error(`Unexpected module: ${id}`);
    },
  };
  vm.runInNewContext(fs.readFileSync('src/views/doing.js', 'utf8'), sandbox);
  return { DoingView: sandbox.module.exports.DoingView, notices };
}

test('moveTask keeps a collapsed target section collapsed', async () => {
  const { DoingView, notices } = loadDoingView();
  const view = Object.create(DoingView.prototype);
  view.app = {};
  view.collapsed = new Set(['done']);
  view.draw = async () => {};

  const moved = await view.moveTask(
    { file: {}, line: 4 },
    { key: 'doing' },
    { key: 'done', name: 'Done' },
    {},
  );

  assert.equal(moved, true);
  assert.equal(view.collapsed.has('done'), true);
  assert.deepEqual(notices, ['Task moved to Done']);
});
