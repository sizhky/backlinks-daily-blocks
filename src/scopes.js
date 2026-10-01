const { MarkdownRenderChild, Notice } = require('obsidian');

async function renderScopesBlock(plugin, src, el, ctx) {
  const child = new MarkdownRenderChild(el);
  ctx.addChild(child);
  const expanded = new Set();
  let timer;
  const refresh = async () => {
    el.empty();
    const groups = await plugin.api.scopeCatalog();
    const root = el.createDiv({ cls: 'bdb-scopes' });
    for (const group of groups) {
      const section = root.createEl('details', { cls: 'bdb-scopes-org' });
      section.open = expanded.has(group.org);
      section.addEventListener('toggle', () => section.open ? expanded.add(group.org) : expanded.delete(group.org));
      const head = section.createEl('summary', { cls: 'bdb-scopes-org-head' });
      head.createSpan({ cls: 'bdb-scopes-org-name', text: group.org });
      const orgToggle = head.createEl('button', {
        cls: `bdb-scopes-toggle ${group.active ? 'is-active' : 'is-inactive'}`,
        text: group.active ? 'Active' : 'Inactive',
        attr: { 'aria-pressed': String(group.active), 'aria-label': `${group.org} organization is ${group.active ? 'active' : 'inactive'}` },
      });
      orgToggle.addEventListener('click', async (event) => {
        event.stopPropagation();
        try { await plugin.api.setScopeStatus({ org: group.org, active: !group.active }); }
        catch (err) { new Notice(`Scope update failed: ${err.message}`); }
      });
      const projects = section.createDiv({ cls: 'bdb-scopes-projects' });
      for (const project of group.projects) {
        const row = projects.createDiv({ cls: 'bdb-scopes-project' });
        row.createSpan({ cls: 'bdb-scopes-project-name', text: project.name });
        row.createSpan({ cls: 'bdb-scopes-count', text: `${project.count} notes` });
        const toggle = row.createEl('button', {
          cls: `bdb-scopes-toggle ${project.active ? 'is-active' : 'is-inactive'}`,
          text: project.active ? 'Active' : 'Inactive',
          attr: { 'aria-pressed': String(project.active), 'aria-label': `${group.org} / ${project.name} is ${project.active ? 'active' : 'inactive'}` },
        });
        toggle.addEventListener('click', async () => {
          try { await plugin.api.setScopeStatus({ org: group.org, project: project.name, active: !project.active }); }
          catch (err) { new Notice(`Scope update failed: ${err.message}`); }
        });
      }
    }
  };
  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => refresh().catch(err => new Notice(`Scope refresh failed: ${err.message}`)), 350);
  };
  child.register(() => window.clearTimeout(timer));
  for (const event of ['modify', 'create', 'delete', 'rename']) {
    child.registerEvent(plugin.app.vault.on(event, file => {
      if (!file || file.extension === 'md') schedule();
    }));
  }
  await refresh();
}

module.exports = { renderScopesBlock };
