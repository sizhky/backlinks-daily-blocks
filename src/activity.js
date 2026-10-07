// 3 Activity timeline (blueprint: .yeshwanth/blueprints/activity-tracking.md).
// Reads the native app's day log and the card histories; writes neither.
const { scanKanbanTasks, resolveKanbanConfig, cleanText } = require('./kanban');
const { parseActivity, stints, overlapMs, union, stampMs } = require('./core/activity');

const LOG_DIR = '.activity';
const HOUR_PX = 56;

function dayBounds(dateStr) {
  const lo = stampMs(dateStr + '0000');
  const end = new Date(lo); end.setHours(23, 59, 59, 999);
  return { lo, hi: end.getTime() };
}

function fmt(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`;
}

function hhmm(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Stable hue per app name.
function hue(s) {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

async function loadDay(plugin, dateStr, config) {
  const { lo, hi } = dayBounds(dateStr);
  const path = `${LOG_DIR}/${dateStr}.jsonl`;
  const adapter = plugin.app.vault.adapter;
  const text = (await adapter.exists(path)) ? await adapter.read(path) : '';
  const spans = parseActivity(text).map(x => ({ ...x, s: Math.max(x.s, lo), e: Math.min(x.e, hi) })).filter(x => x.e > x.s);
  const today = dateStr === stampOf(new Date());
  const openEnd = s => (today ? Date.now() : Math.min(hi, s + 86400000));
  const doing = [];
  const byCol = await scanKanbanTasks(plugin.app, config);
  for (const [key, list] of byCol) for (const card of list) {
    for (const x of stints(card.history, 'doing', lo, hi, openEnd, key === 'doing')) doing.push({ ...x, body: cleanText(card.body) });
  }
  doing.sort((a, b) => a.s - b.s);
  return { lo, hi, spans, doing, logged: !!text };
}

function stampOf(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function totals({ spans, doing }) {
  const active = union(spans), inDoing = union(doing);
  const sum = xs => xs.reduce((t, x) => t + x.e - x.s, 0);
  const both = overlapMs(active, inDoing);
  return { active: sum(active), doing: sum(inDoing), idleDoing: sum(inDoing) - both, untracked: sum(active) - both };
}

// Longest apps first, each with its longest window title.
function byApp(spans) {
  const apps = new Map();
  for (const x of spans) {
    const a = apps.get(x.app) || { ms: 0, titles: new Map() };
    a.ms += x.e - x.s;
    const t = x.title || x.url || '';
    if (t) a.titles.set(t, (a.titles.get(t) || 0) + x.e - x.s);
    apps.set(x.app, a);
  }
  return [...apps.entries()].sort((a, b) => b[1].ms - a[1].ms)
    .map(([app, a]) => ({ app, ms: a.ms, top: [...a.titles.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || '' }));
}

async function activitySummary(plugin, dateStr, config) {
  const day = await loadDay(plugin, dateStr, config);
  if (!day.logged) return `\n# ${dateStr} — no activity log (${LOG_DIR}/${dateStr}.jsonl)`;
  const t = totals(day);
  const head = `# ${dateStr} — active ${fmt(t.active)} · doing ${fmt(t.doing)} · doing without activity ${fmt(t.idleDoing)} · activity outside doing ${fmt(t.untracked)}`;
  return '\n' + [head, ...byApp(day.spans).map(r => `${r.app}\t${fmt(r.ms)}\t${r.top}`)].join('\n');
}

function blockDate(src, ctx) {
  const m = src.match(/^\s*date:\s*(\d{8})\s*$/m);
  if (m) return m[1];
  const name = (ctx.sourcePath || '').split('/').pop();
  const d = name.match(/^(\d{8})-\d{4}/);
  return d ? d[1] : stampOf(new Date());
}

function renderActivityBlock(plugin, src, el, ctx) {
  const dateStr = blockDate(src, ctx);
  const config = resolveKanbanConfig(plugin, '', null);
  const root = el.createDiv({ cls: 'bdb-activity' });
  const draw = async () => {
    const day = await loadDay(plugin, dateStr, config);
    root.empty();
    const t = totals(day);
    const head = root.createDiv({ cls: 'bdb-activity-head' });
    head.createSpan({ cls: 'bdb-activity-date', text: dateStr });
    for (const [label, ms] of [['Active', t.active], ['Doing', t.doing], ['Doing, no activity', t.idleDoing], ['Activity outside Doing', t.untracked]]) {
      const stat = head.createSpan({ cls: 'bdb-activity-stat' });
      stat.createSpan({ cls: 'bdb-activity-stat-label', text: label });
      stat.createSpan({ cls: 'bdb-activity-stat-value', text: fmt(ms) });
    }
    if (!day.logged && !day.doing.length) {
      root.createDiv({ cls: 'bdb-activity-empty', text: `No activity log at ${LOG_DIR}/${dateStr}.jsonl` });
      return;
    }
    const all = [...day.spans, ...day.doing];
    const from = new Date(Math.min(...all.map(x => x.s))); from.setMinutes(0, 0, 0);
    const to = new Date(Math.max(...all.map(x => x.e))); if (to.getMinutes() || to.getSeconds()) to.setHours(to.getHours() + 1, 0, 0, 0);
    const hours = Math.max(1, Math.round((to - from) / 3600000));
    const px = ms => ((ms - from.getTime()) / 3600000) * HOUR_PX;

    const grid = root.createDiv({ cls: 'bdb-activity-grid' });
    grid.style.setProperty('--bdb-activity-height', `${hours * HOUR_PX}px`);
    const axis = grid.createDiv({ cls: 'bdb-activity-axis' });
    for (let h = 0; h <= hours; h++) {
      const tick = axis.createDiv({ cls: 'bdb-activity-tick', text: hhmm(from.getTime() + h * 3600000) });
      tick.style.setProperty('--bdb-top', `${h * HOUR_PX}px`);
    }
    const lane = (title, items, cls, label, tip, color) => {
      const col = grid.createDiv({ cls: 'bdb-activity-lane' });
      col.createDiv({ cls: 'bdb-activity-lane-title', text: title });
      const body = col.createDiv({ cls: 'bdb-activity-lane-body' });
      for (const x of items) {
        const b = body.createDiv({ cls: cls });
        b.style.setProperty('--bdb-top', `${px(x.s)}px`);
        b.style.setProperty('--bdb-h', `${Math.max(2, px(x.e) - px(x.s))}px`);
        if (color) b.style.setProperty('--bdb-hue', String(color(x)));
        b.setAttr('aria-label', tip(x));
        if (px(x.e) - px(x.s) >= 16) b.createSpan({ cls: 'bdb-activity-block-label', text: label(x) });
      }
    };
    lane('Activity', day.spans, 'bdb-activity-block',
      x => `${x.app}${x.title ? ' · ' + x.title : ''}`,
      x => `${hhmm(x.s)}-${hhmm(x.e)} ${fmt(x.e - x.s)}\n${x.app}${x.title ? '\n' + x.title : ''}${x.url ? '\n' + x.url : ''}${x.space ? '\nDesktop ' + x.space : ''}`,
      x => hue(x.app));
    lane('Doing', day.doing, 'bdb-activity-block bdb-activity-doing',
      x => x.body,
      x => `${hhmm(x.s)}-${hhmm(x.e)} ${fmt(x.e - x.s)}\n${x.body}`);

    const apps = byApp(day.spans).slice(0, 8);
    if (apps.length) {
      const list = root.createDiv({ cls: 'bdb-activity-apps' });
      for (const r of apps) {
        const row = list.createDiv({ cls: 'bdb-activity-app' });
        const dot = row.createSpan({ cls: 'bdb-activity-app-dot' });
        dot.style.setProperty('--bdb-hue', String(hue(r.app)));
        row.createSpan({ cls: 'bdb-activity-app-name', text: r.app });
        row.createSpan({ cls: 'bdb-activity-app-title', text: r.top });
        row.createSpan({ cls: 'bdb-activity-app-time', text: fmt(r.ms) });
      }
    }
  };
  draw().catch(err => root.setText('activity: ' + err.message));
  if (dateStr === stampOf(new Date())) {
    const child = new (require('obsidian').MarkdownRenderChild)(el);
    child.registerInterval(window.setInterval(() => draw().catch(() => {}), 60000));
    ctx.addChild(child);
  }
}

module.exports = { renderActivityBlock, activitySummary };
