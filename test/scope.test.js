const test = require('node:test');
const assert = require('node:assert/strict');
const { names, headingScopes, headingProjectAt, projectName, scopeAt, fileScopes } = require('../src/core/scope');

const pos = (line, col, endCol) => ({ start: { line, col }, end: { line, col: endCol } });

// `## [[Sutragana]]` (line 2), `### Notes` (line 4), `## Other [[X]]` (line 6), `## Plain` (line 8)
const cache = {
  frontmatter: { org: ['[[Personal]]'], projects: ['[[Meta]]'] },
  headings: [
    { heading: 'Sutragana', level: 2, position: pos(2, 0, 16) },
    { heading: 'Notes', level: 3, position: pos(4, 0, 9) },
    { heading: 'Other X', level: 2, position: pos(6, 0, 14) },
    { heading: 'Kanban App', level: 2, position: pos(8, 0, 17) },
  ],
  links: [
    { link: 'Sutragana', position: pos(2, 3, 16) },
    { link: 'X', position: pos(6, 9, 14) },
    { link: 'Kanban App', position: pos(8, 3, 17) },
  ],
};

function fakeApp(projectNotes) {
  const files = Object.keys(projectNotes).map(path => ({ path }));
  return {
    vault: { getMarkdownFiles: () => files },
    metadataCache: {
      getFileCache: f => (f.path === 'day.md' ? cache : { frontmatter: projectNotes[f.path] }),
    },
  };
}

test('names strips brackets and aliases', () => {
  assert.deepEqual(names(['[[A|x]]', 'B', null]), ['A', 'B']);
  assert.deepEqual(names(undefined), []);
});

test('only a heading that is one whole wikilink names a project', () => {
  assert.deepEqual(headingScopes(cache).map(h => h.project), ['Sutragana', null, null, 'Kanban App']);
});

test('a project heading scopes tasks until a same-level heading', () => {
  const heads = headingScopes(cache);
  assert.equal(headingProjectAt(heads, 1), null);
  assert.equal(headingProjectAt(heads, 3), 'Sutragana');
  assert.equal(headingProjectAt(heads, 5), 'Sutragana');
  assert.equal(headingProjectAt(heads, 7), null);
  assert.equal(headingProjectAt(heads, 9), 'Kanban App');
});

test('project notes are org-folder notes only', () => {
  assert.equal(projectName('40-49 Areas/43 Orgs/Divami/Arka.md'), 'Arka');
  assert.equal(projectName('40-49 Areas/43 Orgs/Personal/Vyasa/Vyasa.md'), 'Vyasa');
  assert.equal(projectName('40-49 Areas/43 Orgs/Divami/Optinn/Output/chats/meta.md'), null);
  assert.equal(projectName('30-39 Projects/Personal/Vyasa/Vyasa.md'), null);
  assert.equal(projectName('40-49 Areas/43 Orgs/Karishye/Karishye.md'), null);
});

test('heading tasks take the project note org; frontmatter tasks keep the note org', () => {
  const app = fakeApp({ '40-49 Areas/43 Orgs/Personal/Sutragana/Sutragana.md': { org: ['[[Personal]]'], active: true } });
  const file = { path: 'day.md' };
  assert.deepEqual(scopeAt(app, file, 0), { orgs: ['Personal'], projects: ['Meta'] });
  assert.deepEqual(scopeAt(app, file, 3), { orgs: ['Personal'], projects: ['Sutragana'] });
  // Kanban App has no project note: the note's own org is the fallback.
  assert.deepEqual(scopeAt(app, file, 9), { orgs: ['Personal'], projects: ['Kanban App'] });
});

test('a frontmatter project without a note org takes the project note org', () => {
  const app = fakeApp({ '40-49 Areas/43 Orgs/Divami/Arka.md': { org: '[[Divami]]' } });
  cache.frontmatter = { projects: ['[[Arka]]'] };
  try {
    assert.deepEqual(scopeAt(app, { path: 'day.md' }, 0), { orgs: ['Divami'], projects: ['Arka'] });
    assert.deepEqual(fileScopes(app, { path: 'day.md' }).map(p => `${p.org}/${p.project}`), ['Divami/Arka']);
  } finally {
    cache.frontmatter = { org: ['[[Personal]]'], projects: ['[[Meta]]'] };
  }
});
