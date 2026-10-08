const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// kanban.js imports obsidian; a stub is enough for the pure line helpers.
const load = Module._load;
Module._load = (req, ...rest) => (req === 'obsidian' ? {} : load(req, ...rest));
const K = require('../src/kanban');
Module._load = load;

test('addActiveLine creates the kbactive line, then adds to it in place', () => {
  const lines = ['- [ ] Fix API #kb/doing', '  %% kb 202610071000 Todo > Doing %%', '- [ ] Next'];
  assert.equal(K.addActiveLine(lines, 0, 90), 90);
  assert.equal(lines.length, 4);
  assert.match(lines[1], /%% kbactive 90 %%/);
  assert.equal(K.addActiveLine(lines, 0, 30), 120);
  assert.equal(lines.length, 4, 'second add rewrites the line, no shift');
  assert.match(lines[1], /kbactive 120/);
  assert.equal(lines[3], '- [ ] Next');
});

test('setNoteLines replaces prose and keeps metadata lines', () => {
  const lines = ['- [ ] Task', '  %% kb 202610071000 Todo > Doing %%', '  old one', '', '  old two', '  %% kbactive 60 %%', '', '- [ ] Next'];
  assert.equal(K.noteText(lines, 0), '  old one\n\n  old two');
  assert.equal(K.setNoteLines(lines, 0, 'new\nlines'), true);
  assert.deepEqual(lines, ['- [ ] Task', '  %% kb 202610071000 Todo > Doing %%', '  %% kbactive 60 %%', 'new', 'lines', '', '- [ ] Next']);
  assert.equal(K.addActiveLine(lines, 0, 30), 90);
  assert.equal(K.setNoteLines(lines, 0, 'new\nlines'), false);
});

test('setNoteLines adds prose after metadata and clears it to nothing', () => {
  const lines = ['- [ ] Task', '  %% kbest 30 %%', '', '---'];
  K.setNoteLines(lines, 0, 'hello');
  assert.deepEqual(lines, ['- [ ] Task', '  %% kbest 30 %%', 'hello', '', '---']);
  K.setNoteLines(lines, 0, '');
  assert.deepEqual(lines, ['- [ ] Task', '  %% kbest 30 %%', '', '---']);
});
