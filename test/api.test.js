const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadApi() {
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require() { return {}; },
  };
  vm.runInNewContext(fs.readFileSync('src/api.js', 'utf8'), sandbox);
  return sandbox.module.exports;
}

test('filterSince keeps only tasks seen within the requested span', () => {
  const { filterSince } = loadApi();
  const now = Date.UTC(2026, 7, 10, 18);
  const rows = [
    { body: 'recent', recent: now - 23 * 60 * 60 * 1000 },
    { body: 'old', recent: now - 25 * 60 * 60 * 1000 },
    { body: 'unknown', recent: null },
  ];

  assert.deepEqual(JSON.parse(JSON.stringify(filterSince(rows, '1d', now))), [rows[0]]);
});

test('fileNameStamp only accepts a leading daily-note timestamp', () => {
  const { fileNameStamp } = loadApi();
  assert.equal(fileNameStamp({ basename: '20260810-1049' }), '202608101049');
  assert.equal(fileNameStamp({ basename: 'W.e.e.k. 53 - 20251228 - bkp' }), null);
});

test('scope inactivity supports organization, project, and exact combination rules', () => {
  const { scopeInactive } = loadApi();
  assert.equal(scopeInactive({ 'kanban-inactive-orgs': ['[[OldOrg]]'] }, 'OldOrg', 'Current'), true);
  assert.equal(scopeInactive({ 'kanban-inactive-projects': ['[[Legacy]]'] }, 'Current', 'Legacy'), true);
  assert.equal(scopeInactive({ 'kanban-inactive-scopes': ['Current / Paused'] }, 'Current', 'Paused'), true);
  assert.equal(scopeInactive({}, 'Current', 'Active'), false);
});

test('taskNote writes validated scope properties and one kanban task', () => {
  const { taskNote } = loadApi();
  assert.equal(taskNote({ text: ' Reply   to Srinivas ', org: 'InfoshareSystems', project: 'AAA', col: 'Backlog', stamp: '20260919-1423' }),
    '---\norg:\n  - "[[InfoshareSystems]]"\nprojects:\n  - "[[AAA]]"\n---\n\n- [ ] Reply to Srinivas #kb/backlog\n  %% kb 20260919-1423 Backlog > Backlog %%\n');
});

test('parseTaskId maps a Kanban Board ID to its note and task ordinal', () => {
  const { parseTaskId } = loadApi();
  assert.deepEqual({ ...parseTaskId('HTP-261008-1106.01') }, { key: 'HTP', base: '20261008-1106', ordinal: 1 });
  assert.deepEqual({ ...parseTaskId('ow-260613-1844') }, { key: 'OW', base: '20260613-1844', ordinal: 1 });
  assert.equal(parseTaskId('TAS-K3F9'), null);
});
