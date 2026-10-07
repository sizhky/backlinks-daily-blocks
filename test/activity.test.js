const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../src/core/activity');

const min = 60000;

test('sleepGap returns the last tick only after a gap above 30 minutes', () => {
  assert.equal(A.sleepGap(1000, 1000 + 31 * min), 1000);
  assert.equal(A.sleepGap(1000, 1000 + 29 * min), null);
  assert.equal(A.sleepGap(null, Date.now()), null);
});

test('backdateOk refuses a stamp earlier than the latest move', () => {
  const h = [{ stamp: '202610062200', to: 'Doing' }];
  assert.equal(A.backdateOk(A.stampMs('202610070100'), h), true);
  assert.equal(A.backdateOk(A.stampMs('202610062130'), h), false);
});

test('stints pairs each Doing entry with the next move and clips to the window', () => {
  const h = [
    { stamp: '202610070900', to: 'Doing' },
    { stamp: '202610071000', to: 'Parked' },
    { stamp: '202610071100', to: 'Doing' },
  ];
  const lo = A.stampMs('202610070000'), hi = A.stampMs('202610072359');
  const out = A.stints(h, 'doing', lo, hi, () => A.stampMs('202610071130'));
  assert.deepEqual(out.map(x => [(x.e - x.s) / min, x.open]), [[60, false], [30, true]]);
});

test('a night that ends with a backdated park leaves only the worked stint', () => {
  const h = [
    { stamp: '202610062300', to: 'Doing' },
    { stamp: '202610070112', to: 'Parked' }, // last heartbeat before sleep
  ];
  const lo = A.stampMs('202610060000'), hi = A.stampMs('202610072359');
  const [s] = A.stints(h, 'doing', lo, hi, () => hi);
  assert.equal((s.e - s.s) / min, 132);
});

test('planned needs Todo before the first Doing entry', () => {
  assert.equal(A.planned([{ stamp: '1', to: 'Backlog' }, { stamp: '2', to: 'Todo' }, { stamp: '3', to: 'Doing' }]), true);
  assert.equal(A.planned([{ stamp: '1', to: 'Doing' }, { stamp: '2', to: 'Todo' }]), false);
  assert.equal(A.planned([{ stamp: '1', to: 'Backlog' }, { stamp: '2', to: 'Doing' }]), false);
});

test('parseActivity skips partial lines and sorts by start', () => {
  const text = [
    '{"start":"2026-10-07T10:05:00Z","end":"2026-10-07T10:06:00Z","app":"iTerm2"}',
    '{"start":"2026-10-07T10:00:00Z","end":"2026-10-07T10:05:00Z","app":"Safari"}',
    '{"start":"2026-10-07T10:0',
  ].join('\n');
  assert.deepEqual(A.parseActivity(text).map(x => x.app), ['Safari', 'iTerm2']);
});

test('overlapMs and union', () => {
  assert.equal(A.overlapMs([{ s: 0, e: 10 }], [{ s: 5, e: 20 }]), 5);
  assert.deepEqual(A.union([{ s: 5, e: 8 }, { s: 0, e: 6 }, { s: 10, e: 12 }]), [{ s: 0, e: 8 }, { s: 10, e: 12 }]);
});

test('desktopRef accepts 1-9 and names, rejects unsafe values', () => {
  assert.equal(A.desktopRef(' PenguinAI '), 'PenguinAI');
  assert.equal(A.desktopRef(2), '2');
  assert.equal(A.desktopRef('02'), '2');
  assert.equal(A.desktopRef(12), null);
  assert.equal(A.desktopRef('a %% b'), null);
  assert.equal(A.desktopRef(''), null);
});

test('chrono orders same-minute moves by file position (newest first in the note)', () => {
  const h = [{ stamp: '202610011657', to: 'Done', seq: 0 }, { stamp: '202610011657', to: 'Doing', seq: 1 }];
  assert.deepEqual(A.chrono(h).map(x => x.to), ['Doing', 'Done']);
  const day = A.stampMs('202610010000'), end = A.stampMs('202610012359');
  assert.equal(A.stints(h, 'doing', day, end, () => end).length, 0, 'zero-length stint, not open until midnight');
});

test('a card no longer in the column has no open stint', () => {
  const h = [{ stamp: '202607171628', to: 'Done', seq: 1 }, { stamp: '202607171735', to: 'Doing', seq: 0 }];
  const lo = A.stampMs('202610070000'), hi = A.stampMs('202610072359');
  assert.equal(A.stints(h, 'doing', lo, hi, () => hi, false).length, 0);
  assert.equal(A.stints(h, 'doing', lo, hi, () => hi, true).length, 1);
});
