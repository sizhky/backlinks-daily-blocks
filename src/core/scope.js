// Card scope: the org and projects of one task line.
// Implements: an inline `@[[Project]]` on the task line wins; a `## [[Project]]` heading scopes the tasks under it; the project note's
// frontmatter owns its `org` and `active`; note frontmatter `org`/`projects` is the fallback.

// Frontmatter value -> names, brackets and alias off.
//   names(['[[A|x]]', 'B']) -> ['A', 'B'];  names(undefined) -> []
function names(raw) {
  if (raw == null) return [];
  return (Array.isArray(raw) ? raw : [raw]).filter(v => v != null && typeof v !== 'object')
    .map(v => String(v).trim().replace(/^\[\[([^\]]*)\]\]$/, '$1').split('|')[0].trim()).filter(Boolean);
}

// Headings of a file cache with the project each one names. A heading names a project when
// its whole text is one wikilink (`## [[Sutragana]]`); the heading cache drops the brackets,
// so the link cache at the same line, ending where the heading ends, tells them apart.
//   -> [{ line, level, project: 'Sutragana' | null }]
function headingScopes(cache) {
  const links = cache?.links || [];
  return (cache?.headings || []).map(h => {
    const at = h.position.start, end = h.position.end;
    const link = links.find(l => l.position.start.line === at.line
      && l.position.end.col === end.col && l.position.start.col <= at.col + h.level + 2);
    return { line: at.line, level: h.level, project: link ? link.link.split('#')[0].trim() || null : null };
  }).sort((a, b) => a.line - b.line);
}

const INLINE_RE = /(?:^|\s)@\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

// Projects marked inline on a task line; a bare [[link]] is not a project.
//   inlineProjects('Improve parser @[[Sutragana]]') -> ['Sutragana']
//   inlineProjects('Work through [[Sutragana]]') -> []
//   inlineProjects('@[[A|x]] and @[[B#h]]') -> ['A', 'B']
function inlineProjects(body) {
  return [...String(body || '').matchAll(INLINE_RE)].map(m => m[1].trim()).filter(Boolean);
}

// Task title without its inline project marks (the project shows as the card scope instead).
//   withoutProjects('Create the Trading bench @[[Trading]]') -> 'Create the Trading bench'
//   withoutProjects('Work through [[Sutragana]]') -> 'Work through [[Sutragana]]'
function withoutProjects(body) {
  return String(body || '').replace(INLINE_RE, '').replace(/\s{2,}/g, ' ').trim();
}

// Project of the deepest enclosing project heading above `line`; a same-or-higher heading closes it.
//   heads [{line:0,level:2,project:'A'},{line:4,level:3,project:null}], line 6 -> 'A'
//   heads [{line:0,level:2,project:'A'},{line:4,level:2,project:null}], line 6 -> null
function headingProjectAt(heads, line) {
  const stack = [];
  for (const h of heads) {
    if (h.line >= line) break;
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    stack.push(h);
  }
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].project) return stack[i].project;
  return null;
}

// Project notes live at `<PROJECT_ROOT>/<Org>/<Project>.md` or `<PROJECT_ROOT>/<Org>/<Project>/<Project>.md`.
const PROJECT_ROOT = '40-49 Areas/43 Orgs';

// Is `path` a project note path? Returns the project name or null.
//   projectName('40-49 Areas/43 Orgs/Divami/Arka.md') -> 'Arka'
//   projectName('40-49 Areas/43 Orgs/Personal/Vyasa/Vyasa.md') -> 'Vyasa'
//   projectName('40-49 Areas/43 Orgs/Divami/Optinn/Output/chats/meta.md') -> null
//   projectName('40-49 Areas/43 Orgs/Karishye/Karishye.md') -> null
function projectName(path) {
  if (!path.startsWith(PROJECT_ROOT + '/') || !path.endsWith('.md')) return null;
  const parts = path.slice(PROJECT_ROOT.length + 1, -3).split('/');
  if (parts.length === 2) return parts[1] === parts[0] ? null : parts[1]; // <Org>/<Org>.md is the org note
  if (parts.length === 3 && parts[1] === parts[2]) return parts[2];
  return null;
}

// Lower-case project name -> project note, rebuilt at most once a second.
let index = { at: 0, app: null, map: new Map() };
function projectIndex(app) {
  if (index.app === app && Date.now() - index.at < 1000) return index.map;
  const map = new Map();
  for (const f of app.vault.getMarkdownFiles()) {
    const name = projectName(f.path);
    if (name && !map.has(name.toLowerCase())) map.set(name.toLowerCase(), f);
  }
  index = { at: Date.now(), app, map };
  return map;
}

// Project note of a project name (a path-like name matches on its last segment), or null.
function projectFile(app, project) {
  return projectIndex(app).get(String(project).split('/').pop().toLowerCase()) || null;
}

// Frontmatter of a project's note, or null when no project note exists.
function projectFm(app, project) {
  const file = projectFile(app, project);
  return file ? app.metadataCache.getFileCache(file)?.frontmatter || {} : null;
}

// Project note's `active: true|false`, or null when the note or the key is absent.
function projectActive(app, project) {
  const active = projectFm(app, project)?.active;
  return typeof active === 'boolean' ? active : null;
}

function projectOrgs(app, projects) {
  return [...new Set(projects.flatMap(p => names(projectFm(app, p)?.org)))];
}

// { orgs, projects } of the task at `line` with task text `body` (omit body to skip inline marks).
// An inline or heading project takes its project note's org (the note's own `org` when the
// project note has none); a frontmatter project keeps the note's explicit `org`, else its
// project note's org.
function scopeAt(app, file, line, heads, body) {
  const cache = app.metadataCache.getFileCache(file);
  const fm = cache?.frontmatter;
  const own = names(fm?.org);
  const inline = inlineProjects(body);
  const hp = inline.length ? inline : [headingProjectAt(heads || headingScopes(cache), line)].filter(Boolean);
  if (hp.length) {
    const orgs = projectOrgs(app, hp);
    return { orgs: orgs.length ? orgs : own, projects: hp };
  }
  const projects = names(fm?.projects);
  return { orgs: own.length ? own : projectOrgs(app, projects), projects };
}

// Every { org, project } pair a file's tasks can carry: frontmatter, heading, then inline pairs.
// bodies = the file's task texts, for inline marks.
function fileScopes(app, file, bodies = []) {
  const cache = app.metadataCache.getFileCache(file);
  const pairs = new Map();
  const add = ({ orgs, projects }) => {
    for (const org of orgs) for (const project of projects) pairs.set(`${org}\t${project}`.toLowerCase(), { org, project });
  };
  const top = scopeAt(app, file, 0, []);
  // An empty `projects:` keeps its org-only row, which createTask needs for project-less cards.
  if (!top.projects.length && cache?.frontmatter && 'projects' in cache.frontmatter) top.projects = [''];
  add(top);
  for (const h of headingScopes(cache)) if (h.project) add(scopeAt(app, file, h.line + 1, [h]));
  for (const body of bodies) if (inlineProjects(body).length) add(scopeAt(app, file, 0, [], body));
  return [...pairs.values()];
}

module.exports = { inlineProjects, withoutProjects, PROJECT_ROOT, projectName, projectFile, names, headingScopes, headingProjectAt, projectFm, projectActive, scopeAt, fileScopes };
