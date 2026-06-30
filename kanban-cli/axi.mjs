#!/usr/bin/env node
// AXI-compliant CLI wrapper over the backlinks-daily-blocks kanban `kb` api.
// Talks to Obsidian via `obsidian eval`, reformats TSV -> TOON on stdout.
// Spec: https://toonformat.dev  +  AXI standard (agent-facing CLI ergonomics).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(import.meta.url).replace(process.env.HOME, '~');
const DESC = 'Query and mutate the Obsidian kanban board (tasks, moves, habits).';

// --- run `kb.<expr>` through obsidian eval, return raw value text (marker stripped) ---
function kb(expr) {
  let out;
  try {
    out = execFileSync('obsidian', ['eval', `code=kb.${expr}`], { encoding: 'utf8' });
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message || '').toString().trim();
    fail(msg.replace(/^.*Error:\s*/s, '') || 'obsidian eval failed', null, 1);
  }
  return out.replace(/^=>\s?/, '').replace(/^\n/, '').replace(/\n$/, '');
}

// TSV value text -> array of objects keyed by `fields`
function rows(text, fields) {
  if (!text.trim()) return [];
  return text.split('\n').filter(Boolean).map(line => {
    const cells = line.split('\t');
    const o = {};
    fields.forEach((f, i) => { o[f] = (cells[i] ?? '').trim(); });
    return o;
  });
}

// --- TOON output boundary ---
function cell(v) {
  const s = v == null || v === '' ? '·' : String(v);
  return /[,":\n]|^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s;
}
function toon(name, fields, data) {
  let s = `${name}[${data.length}]{${fields.join(',')}}:`;
  for (const r of data) s += '\n  ' + fields.map(f => cell(r[f])).join(',');
  return s;
}
function help(lines) { return 'help[' + lines.length + ']:\n  ' + lines.join('\n  '); }

// --- structured error on stdout, then exit ---
function fail(msg, hint, code = 2) {
  let s = 'error: ' + msg;
  if (hint) s += '\nhelp: ' + hint;
  console.log(s);
  process.exit(code);
}

// --- flag parsing: --k v | --k=v | --bool ---
function parseFlags(argv, bools = []) {
  bools = ['help', 'full', 'comments', ...bools];
  const f = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) f[a.slice(2, eq)] = a.slice(eq + 1);
      else if (bools.includes(a.slice(2))) f[a.slice(2)] = true;
      else f[a.slice(2)] = argv[++i];
    } else pos.push(a);
  }
  return { f, pos };
}

// build a `{k:v,...}` opts literal for kb from flags (strings quoted, numbers raw)
function opts(map) {
  const parts = Object.entries(map)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}:${typeof v === 'boolean' ? v : (typeof v === 'number' || /^\d+$/.test(v) ? +v : JSON.stringify(String(v)))}`);
  return parts.length ? `{${parts.join(',')}}` : '';
}

// shared arg builder for date | from to | --days N (+ extra opts), per kb signatures
function rangeArgs(f, pos, extra = {}) {
  const o = opts({ ...extra, col: f.col, paths: f.paths });
  if (f.days) return opts({ days: f.days, ...extra, col: f.col, paths: f.paths });
  if (pos.length > 1) { const d = `${JSON.stringify(pos[0])},${JSON.stringify(pos[1])}`; return o ? `${d},${o}` : d; }
  if (pos[0]) return o ? `${JSON.stringify(pos[0])},${o}` : JSON.stringify(pos[0]);
  return o;
}
const indent = t => t.split('\n').map(l => '  ' + l).join('\n');

const LIST_FIELDS = ['col', 'ref', 'body', 'age'];

function cmdList(argv) {
  const { f } = parseFlags(argv);
  if (f.help) return console.log(
    'usage: kanban list [--col <name>] [--tag <s>] [--paths <p>] [--stale <n>] [--limit <n>]\n' +
    'Live tasks on your plate (non-terminal, non-paused columns).\n' +
    'examples:\n  kanban list --col Todo --limit 5\n  kanban list --tag work');
  const o = opts({ col: f.col, tag: f.tag, paths: f.paths, staleDays: f.stale, limit: f.limit });
  const data = rows(kb(`active(${o})`), LIST_FIELDS);
  if (!data.length) return console.log('tasks: 0 active tasks found');
  console.log(toon('tasks', LIST_FIELDS, data));
  console.log(help([
    'Run `kanban view <ref>` to read a task\'s notes',
    'Run `kanban move <ref> <col>` to move a task',
  ]));
}

function dashboard() {
  console.log('bin: ' + BIN);
  console.log('description: ' + DESC);
  const data = rows(kb('active({limit:15})'), LIST_FIELDS);
  if (!data.length) console.log('tasks: 0 active tasks found');
  else console.log(toon('tasks', LIST_FIELDS, data));
  console.log(help([
    'Run `kanban list --col Todo` to filter by column',
    'Run `kanban view <ref>` for a task\'s notes',
    'Run `kanban move <ref> <col>` to move a task',
    'Run `kanban done <date>` for what finished on a day',
    'Run `kanban habits` for habit stats',
  ]));
}

function cmdPlate(argv) {
  const { f, pos } = parseFlags(argv);
  if (f.help) return console.log(
    'usage: kanban plate [<project>] [--prop <key>] [--col <name>] [--limit <n>] [--paths <p>]\n' +
    'Live tasks incl. paused Backlog, optionally scoped to a project (default prop: projects).\n' +
    'examples:\n  kanban plate --col Backlog\n  kanban plate "Obsidian Workflow"');
  const o = opts({ col: f.col, prop: f.prop, limit: f.limit, paths: f.paths, contains: f.contains });
  const proj = pos[0] ? JSON.stringify(pos[0]) : '';
  const args = proj && o ? `${proj},${o}` : proj || o;
  const data = rows(kb(`plate(${args})`), LIST_FIELDS);
  if (!data.length) return console.log('tasks: 0 tasks on plate' + (pos[0] ? ` for "${pos[0]}"` : ''));
  console.log(toon('tasks', LIST_FIELDS, data));
  console.log(help(['Run `kanban move <ref> <col>` to move a task']));
}

const TRUNC = 1200;
function cmdView(argv) {
  const { f, pos } = parseFlags(argv);
  if (f.help || !pos[0]) return console.log(
    'usage: kanban view <file:line> [--full]\n' +
    'Read the freeform notes under a task.\nexamples:\n  kanban view 20260616-0946.md:0 --full');
  const prose = kb(`note(${JSON.stringify(pos[0])})`);
  if (!prose.trim()) return console.log(`task:\n  ref: ${pos[0]}\n  notes: (none)`);
  const full = f.full || prose.length <= TRUNC;
  let s = `task:\n  ref: ${pos[0]}\n  notes: ${full ? prose : prose.slice(0, TRUNC)}`;
  if (!full) {
    s += `\n    ... (truncated, ${prose.length} chars total)`;
    s += `\nhelp: Run \`kanban view ${pos[0]} --full\` to see complete notes`;
  }
  console.log(s);
}

function refToArgs(ref) {
  const i = ref.lastIndexOf(':');
  if (i < 0 || !/^\d+$/.test(ref.slice(i + 1))) fail(`bad ref: ${ref}`, 'use <file.md:line>, e.g. 20260616-0946.md:0');
  return { path: ref.slice(0, i), line: +ref.slice(i + 1) };
}
function cmdMove(argv) {
  const { f, pos } = parseFlags(argv);
  if (f.help || pos.length < 2) return console.log(
    'usage: kanban move <file:line> <column>\n' +
    'Move a task to a column (case-insensitive). Columns: Backlog, Todo, Doing, Parked, Done, Cancelled.\n' +
    'examples:\n  kanban move 20260616-0946.md:0 Done');
  const { path, line } = refToArgs(pos[0]);
  const r = kb(`moveTask(${JSON.stringify(path)},${line},${JSON.stringify(pos[1])})`);
  console.log('moved: ' + r.replace(/^ok\s*/, ''));
}

const DONE_FIELDS = ['col', 'ref', 'body', 'time'];
function cmdDone(argv) {
  const { f, pos } = parseFlags(argv);
  if (f.help || !pos[0]) return console.log(
    'usage: kanban done <date> [--col <name>] [--paths <p>]\n' +
    'Tasks that moved to a terminal column (Done/Cancelled) on a date.\n' +
    'examples:\n  kanban done 20260620\n  kanban done today --col Done');
  const o = opts({ col: f.col, paths: f.paths });
  const args = o ? `${JSON.stringify(pos[0])},${o}` : JSON.stringify(pos[0]);
  const data = rows(kb(`getDone(${args})`), DONE_FIELDS);
  if (!data.length) return console.log(`done: 0 tasks finished on ${pos[0]}`);
  console.log(toon('done', DONE_FIELDS, data));
}

const REPORT_FIELDS = ['ref', 'body', 'moves'];
function cmdReport(argv) {
  const { f, pos } = parseFlags(argv);
  if (f.help) return console.log(
    'usage: kanban report <date> | <from> <to> | --days <n> [--col <name>]\n' +
    'Move timeline. Single date = TOON rows; range/--days = grouped raw text.\n' +
    'examples:\n  kanban report 20260620\n  kanban report --days 7\n  kanban report 20260601 20260607');
  if (!f.days && !pos.length) return fail('need a <date>, <from> <to>, or --days <n>', 'kanban report 20260620 | kanban report --days 7');
  if (f.days || pos.length > 1) // range -> grouped raw passthrough
    return console.log('report:\n' + indent(kb(`getReport(${rangeArgs(f, pos)})`)));
  const data = rows(kb(`getReport(${rangeArgs(f, pos)})`), REPORT_FIELDS);
  if (!data.length) return console.log(`report: no moves on ${pos[0]}`);
  console.log(toon('moves', REPORT_FIELDS, data));
}

const CHRON_FIELDS = ['time', 'dur', 'body'];
function cmdChronicle(argv) {
  const { f, pos } = parseFlags(argv);
  if (f.help) return console.log(
    'usage: kanban chronicle <date> | <from> <to> | --days <n> [--col <name>]\n' +
    'What sat in a column (default Doing) per day, as time stints + total.\n' +
    'examples:\n  kanban chronicle 20260620\n  kanban chronicle --days 7 --col Doing');
  if (!f.days && !pos.length) return fail('need a <date>, <from> <to>, or --days <n>', 'kanban chronicle 20260620');
  if (f.days || pos.length > 1)
    return console.log('chronicle:\n' + indent(kb(`chronicle(${rangeArgs(f, pos)})`)));
  const data = rows(kb(`chronicle(${rangeArgs(f, pos)})`), CHRON_FIELDS);
  if (!data.length) return console.log(`chronicle: nothing tracked on ${pos[0]}`);
  console.log(toon('chronicle', CHRON_FIELDS, data));
}

const SUMMARY_FIELDS = ['group', 'count', 'sample'];
function cmdSummary(argv) {
  const { f, pos } = parseFlags(argv);
  if (f.help) return console.log(
    'usage: kanban summary [<date> | <from> <to> | --days <n>] [--by <fmkey>] [--col <name>]\n' +
    'Done counts grouped by a frontmatter key (default projects). Defaults to --days 7.\n' +
    'examples:\n  kanban summary --days 3 --by projects\n  kanban summary 20260601 20260607');
  if (!f.days && !pos.length) f.days = 7;
  const raw = kb(`summary(${rangeArgs(f, pos, { by: f.by })})`).split('\n').filter(Boolean);
  let header = '';
  if (raw[0]?.startsWith('#')) header = raw.shift().replace(/^#\s*/, '');
  if (header) console.log('summary: ' + header);
  const data = rows(raw.join('\n'), SUMMARY_FIELDS);
  if (!data.length) return console.log('summary: 0 done in range');
  console.log(toon('groups', SUMMARY_FIELDS, data));
}

const PROPS_FIELDS = ['key', 'notes', 'values'];
function cmdProps(argv) {
  const { f, pos } = parseFlags(argv, ['all']);
  if (f.help) return console.log(
    'usage: kanban props [<since>] [--paths <p>] [--sample <n>] [--all]\n' +
    'Discover frontmatter schema. <since>: 1d|3d|1w|2m|1y. --all scans non-task notes too.\n' +
    'examples:\n  kanban props 1w\n  kanban props --all');
  const o = opts({ since: pos[0] || f.since, paths: f.paths, sample: f.sample, tasks: f.all ? false : undefined });
  const data = rows(kb(`props(${o})`), PROPS_FIELDS);
  if (!data.length) return console.log('props: 0 frontmatter keys found');
  console.log(toon('props', PROPS_FIELDS, data));
  console.log(help(['Run `kanban notes --where <key>=<value>` to find notes by a property']));
}

const NOTES_FIELDS = ['file', 'props'];
function parseWhere(s) {
  const o = {};
  for (const pair of String(s).split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) o[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return o;
}
function cmdNotes(argv) {
  const { f } = parseFlags(argv, ['contains', 'tasks']);
  if (f.help || !f.where) return console.log(
    'usage: kanban notes --where <key>=<value>[,<key2>=<value2>] [--limit <n>] [--paths <p>] [--since <s>] [--contains] [--tasks]\n' +
    'Find notes by frontmatter props. Array props match if any element matches.\n' +
    'examples:\n  kanban notes --where projects="Obsidian Workflow" --limit 10');
  const w = parseWhere(f.where);
  if (!Object.keys(w).length) return fail('--where needs <key>=<value> pairs', 'kanban notes --where projects="Obsidian Workflow"');
  const whereLit = '{' + Object.entries(w).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',') + '}';
  const extra = opts({ limit: f.limit, paths: f.paths, since: f.since, contains: f.contains, tasks: f.tasks });
  const inner = `where:${whereLit}` + (extra ? ',' + extra.slice(1, -1) : '');
  const data = rows(kb(`notes({${inner}})`), NOTES_FIELDS);
  if (!data.length) return console.log('notes: 0 matching notes');
  console.log(toon('notes', NOTES_FIELDS, data));
}

const HABIT_FIELDS = ['name', 'state', 'today', 'avg7', 'streak'];
function cmdHabits(argv) {
  const { f } = parseFlags(argv);
  if (f.help) return console.log(
    'usage: kanban habits [--paths <p>]\nHabit stopwatch stats, one row per habit.\n' +
    'examples:\n  kanban habits');
  const data = rows(kb(`habits(${opts({ paths: f.paths })})`), HABIT_FIELDS);
  if (!data.length) return console.log('habits: 0 habits found');
  console.log(toon('habits', HABIT_FIELDS, data));
  console.log(help(['Run `kanban toggle "<name>"` to start/stop a habit']));
}

function cmdToggle(argv) {
  const { f, pos } = parseFlags(argv);
  if (f.help || !pos[0]) return console.log(
    'usage: kanban toggle <name> [--paths <p>]\n' +
    'Start/stop a habit (flips Idle <-> Doing).\nexamples:\n  kanban toggle Cook');
  const o = opts({ paths: f.paths });
  const args = o ? `${JSON.stringify(pos[0])},${o}` : JSON.stringify(pos[0]);
  console.log('toggled: ' + kb(`toggle(${args})`).replace(/^ok\s*/, ''));
}

const cmd = process.argv[2];
const rest = process.argv.slice(3);
switch (cmd) {
  case undefined: dashboard(); break;
  case 'list': cmdList(rest); break;
  case 'plate': cmdPlate(rest); break;
  case 'view': cmdView(rest); break;
  case 'move': cmdMove(rest); break;
  case 'done': cmdDone(rest); break;
  case 'report': cmdReport(rest); break;
  case 'chronicle': cmdChronicle(rest); break;
  case 'summary': cmdSummary(rest); break;
  case 'props': cmdProps(rest); break;
  case 'notes': cmdNotes(rest); break;
  case 'habits': cmdHabits(rest); break;
  case 'toggle': cmdToggle(rest); break;
  case 'help': case '--help': console.log(`bin: ${BIN}\ndescription: ${DESC}\n` +
    help(['list', 'plate [project]', 'view <ref>', 'move <ref> <col>', 'done <date>',
      'report <date>|--days N', 'chronicle <date>|--days N', 'summary --days N --by <key>',
      'props [since]', 'notes --where k=v', 'habits', 'toggle <name>'].map(c => `kanban ${c}`))); break;
  default: fail(`unknown command: ${cmd}`, 'kanban [list|plate|view|move|done|report|chronicle|summary|props|notes|habits|toggle]');
}
