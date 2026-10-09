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

test('adhoc: under the mulling threshold in Backlog and Todo before the first Doing entry', () => {
  const at = A.stampMs('202610071000');
  const mv = (stamp, from, to) => ({ stamp, from, to });
  assert.equal(A.adhoc([mv('202610071000', 'Backlog', 'Doing')], at), true);
  assert.equal(A.adhoc([mv('202610071010', 'Backlog', 'Todo'), mv('202610071020', 'Todo', 'Doing')], at), true);
  assert.equal(A.adhoc([mv('202610071300', 'Backlog', 'Doing')], at), false);
  assert.equal(A.adhoc([mv('202610071300', 'Backlog', 'Doing')], at, 4 * 60 * min), true);
  assert.equal(A.adhoc([mv('202610071000', 'Backlog', 'Done')], at), null);
  assert.equal(A.planned([mv('202610071300', 'Backlog', 'Todo'), mv('202610071400', 'Todo', 'Doing')], at), true);
  assert.equal(A.birthMs('20261007-1000.md'), at);
  assert.equal(A.birthMs('Notes.md'), null);
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

test('columnSeconds sums closed stints per column and leaves the open one out', () => {
  const { columnSeconds } = require('../src/core/activity');
  const h = [
    { stamp: '202610081000', from: 'Todo', to: 'Doing', seq: 3 },
    { stamp: '202610081030', from: 'Doing', to: 'Parked', seq: 2 },
    { stamp: '202610081100', from: 'Parked', to: 'Doing', seq: 1 },
  ];
  assert.deepEqual({ ...columnSeconds(h) }, { Doing: 1800, Parked: 1800 });
});

const card = () => [
  '- [x] a',
  '  %% kb 20261008-1200 Parked > Done %%',
  '  %% kb 20261008-1100 Doing > Parked %%',
  '  %% kb 20261008-1000 Todo > Doing %%',
  '- [ ] b',
  '  %% kb 20261008-0900 Todo > Doing %%',
];

test('stintEdit retimes start and end, clamped between the neighbouring moves', () => {
  const L = card();
  A.stintEdit(L, 0, '202610081000', { start: '202610081015', end: '202610081300' });
  assert.equal(L[3], '  %% kb 20261008-1015 Todo > Doing %%');
  assert.equal(L[2], '  %% kb 20261008-1200 Doing > Parked %%');
  assert.equal(L[5], '  %% kb 20261008-0900 Todo > Doing %%');
});

test('stintEdit delete drops the entry and starts the exit move from the entry column', () => {
  const L = card();
  A.stintEdit(L, 0, '202610081000', 'delete');
  assert.deepEqual(L.slice(0, 3), ['- [x] a', '  %% kb 20261008-1200 Parked > Done %%', '  %% kb 20261008-1100 Todo > Parked %%']);
  const M = ['- [ ] a', '  %% kb 20261008-1100 Doing > Parked %%', '  %% kb 20261008-1000 Parked > Doing %%'];
  A.stintEdit(M, 0, '202610081000', 'delete');
  assert.deepEqual(M, ['- [ ] a']);
});

test('stintEdit refuses an open stint end or delete and an unknown entry', () => {
  assert.throws(() => A.stintEdit(card(), 4, '202610080900', 'delete'), /still open/);
  assert.throws(() => A.stintEdit(card(), 0, '202610080900', { start: '202610080800' }), /no Doing stint/);
  const L = card();
  A.stintEdit(L, 4, '202610080900', { start: '202610080830' });
  assert.equal(L[5], '  %% kb 20261008-0830 Todo > Doing %%');
});
