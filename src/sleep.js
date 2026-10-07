// 1 Overnight stint repair (blueprint: .yeshwanth/blueprints/activity-tracking.md).
const { Notice, Platform } = require('obsidian');
const { scanKanbanTasks, moveCard, parseKanbanConfig } = require('./kanban');
const { sleepGap, backdateOk } = require('./core/activity');

const TICK_KEY = 'bdb-last-tick';
const TICK_MS = 60000;

function readTick() {
  try { return Number(window.localStorage.getItem(TICK_KEY)) || null; } catch { return null; }
}
function writeTick(ms) {
  try { window.localStorage.setItem(TICK_KEY, String(ms)); } catch { /* storage blocked: next load sees no gap */ }
}

// 1.2 Move every live (Doing) card to its paused column, stamped at `at`.
// Habit cards (frontmatter `metric`) stop to Idle; other cards park to Parked.
async function parkAll(plugin, at, makeConfig) {
  const boards = [
    { config: makeConfig(), habit: false },
    { config: parseKanbanConfig('columns: Idle~, Doing!'), habit: true },
  ];
  let moved = 0;
  for (const { config, habit } of boards) {
    const live = config.columns.find(c => c.live);
    const target = habit
      ? config.columns.find(c => c.paused)
      : config.columns.find(c => c.key === 'parked') || config.columns.find(c => c.paused && c.key !== 'backlog');
    if (!live || !target) continue;
    const byCol = await scanKanbanTasks(plugin.app, config);
    const cards = (byCol.get(live.key) || [])
      .filter(c => (plugin.app.metadataCache.getFileCache(c.file)?.frontmatter?.metric != null) === habit)
      .filter(c => backdateOk(at.getTime(), c.history))
      .sort((a, b) => a.file.path === b.file.path ? b.line - a.line : a.file.path.localeCompare(b.file.path));
    for (const card of cards) {
      if (await moveCard(plugin.app, card.file, card.line, target, config, { fromCol: live, at })) moved++;
    }
  }
  return moved;
}

// 1.1 Heartbeat: a gap between ticks means the Mac slept or Obsidian was closed.
// Desktop only: mobile Obsidian is suspended in the background, so its gaps are not sleep.
function startSleepWatch(plugin, makeConfig) {
  if (!Platform.isDesktopApp) return;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now();
      const gapStart = sleepGap(readTick(), now);
      writeTick(now);
      if (gapStart == null) return;
      const n = await parkAll(plugin, new Date(gapStart), makeConfig);
      if (n) new Notice(`kanban: parked ${n} Doing card${n > 1 ? 's' : ''} at ${new Date(gapStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (Mac was asleep)`);
    } catch (err) {
      console.warn('backlinks-daily-blocks: sleep park failed', err);
    } finally {
      busy = false;
    }
  };
  plugin.app.workspace.onLayoutReady(tick);
  plugin.registerInterval(window.setInterval(tick, TICK_MS));
  plugin.register(() => writeTick(Date.now()));
}

module.exports = { startSleepWatch, parkAll };
