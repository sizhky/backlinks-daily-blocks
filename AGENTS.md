# Map

Obsidian plugin. Renders `backlinks`/`daily` code blocks + 4 custom Bases views. No Dataview.

**Never edit `main.js` — it's the esbuild bundle.** Edit `src/`, then `npm run build`. Obsidian loads `main.js` + `styles.css` + `manifest.json` from this folder root. Test = reload Obsidian.

## Layout

```
src/main.js            plugin class; registers blocks + Bases views (names/options live here)
src/blocks.js          ```backlinks``` and ```daily``` code block renderers
src/core/notes.js      prepareNote: read → strip frontmatter → truncate (%% more %%)
src/core/tasks.js      setTaskOnLine — THE one place that flips a checkbox in a file
src/core/render.js     renderInteractive, wireTaskCheckboxes, openFileAtLine
src/views/base.js      BdbBasesView: getOption, fileEntries(), waveSeparator
src/views/chronicle.js "Chronicle" — content feed of filtered files
src/views/atlas.js     "Atlas" — aggregates frontmatter props, syncs into host note's frontmatter (writes!)
src/views/ledger.js    "Ledger" — task aggregation, Incomplete/Complete + subgroups
src/views/beacon.js    "Beacon" — lines tagged #win (configurable), plural-tag task pickup
styles.css             all styling incl. wave separators; no inline styles, no injected CSS
```

## Rules

- New checkbox/toggle behaviour goes through `core/tasks.js`, not per-view regex.
- New content rendering goes through `core/notes.js` + `core/render.js`.
- Daily-note filename contract: `YYYYMMDD-HHmm.md` (optionally `.excalidraw.md`).
- Atlas mutates frontmatter of the host note — respect `bdb-disable-sync: true` and template skips.
- Plain JS CommonJS, no TypeScript. `obsidian` is external in the bundle.

Note that there's obsidian cli for tracking and reporting tasks
Whenever there's a new cli based feature, update this repo's kanban-cli skill

## Querying tasks via `obsidian eval`

`obsidian` resolves to `/Applications/Obsidian.app/Contents/MacOS/obsidian`. Global `kb`
= `app.plugins.plugins["backlinks-daily-blocks"].api`. Methods: `active(opts)`,
`getDone(date,opts)`, `getReport(date,opts)`, `moveTask(file,line,col)`. (No `getPlate` —
that's stale skill docs; use `active()`.) All take `opts.col`/`opts.paths`/etc; date is
`YYYYMMDD`; `file` is the bare note name e.g. `20260613-1844.md`.

```bash
obsidian eval code='kb.getReport(20260613,{col:"Doing"})'
obsidian eval code='kb.moveTask("20260613-1844.md",0,"Done")'
```

The api methods are `async`. This needs an up-to-date Obsidian **installer** (Electron
shell), not just the auto-updated app package — keep it current via
`brew install --cask obsidian`. On a stale installer `eval` cold-spawns an old asar that
does NOT await: async results come back **blank** and top-level `await` errors. If you see
the "installer is out of date" banner and blank output, that's the cause.
On 2026-10-07 async results also came back blank most of the time on a current installer (1.14.4),
while sync evals always worked. Reliable pattern: start the promise in a sync eval that stores its
result on `window`, then read it with a second sync eval (the Kanban Board app's `ObsidianClient.eval`).

$ which obsidian
/Applications/Obsidian.app/Contents/MacOS/obsidian
