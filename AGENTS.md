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
