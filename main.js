var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// src/core/notes.js
var require_notes = __commonJS({
  "src/core/notes.js"(exports2, module2) {
    function stripFrontmatter(text) {
      return text.replace(/^---\n[\s\S]*?\n---\n/, "");
    }
    function truncateContent(text, limit) {
      let output = text;
      const moreIndex = output.indexOf("%% more %%");
      if (moreIndex !== -1) {
        output = output.substring(0, moreIndex).trim() + "\n\n*Content truncated...*";
      }
      if (limit && output.length > limit) {
        output = output.substring(0, limit).trimEnd() + "...";
      }
      return output;
    }
    function isExcalidraw(file) {
      return file.basename.endsWith(".excalidraw");
    }
    function displayName(file) {
      return isExcalidraw(file) ? file.basename.replace(".excalidraw", "") : file.basename;
    }
    async function prepareNote(app, file, { strip = true, truncate = 0 } = {}) {
      if (isExcalidraw(file)) {
        return { kind: "excalidraw", content: "", lines: [] };
      }
      let raw = "";
      try {
        raw = await app.vault.cachedRead(file);
      } catch (err) {
        console.warn("backlinks-daily-blocks: read failed", file.path, err);
      }
      const lines = raw.split(/\r?\n/);
      let content = strip ? stripFrontmatter(raw || "") : raw;
      content = truncateContent(content, truncate);
      if (!content.trim()) {
        return { kind: "empty", content: "", lines };
      }
      return { kind: "markdown", content, lines };
    }
    module2.exports = { stripFrontmatter, truncateContent, isExcalidraw, displayName, prepareNote };
  }
});

// src/blocks.js
var require_blocks = __commonJS({
  "src/blocks.js"(exports2, module2) {
    var { TFile, MarkdownRenderer, parseYaml, moment } = require("obsidian");
    var { prepareNote, displayName, isExcalidraw } = require_notes();
    function parseOptions(source, defaults) {
      const raw = (source || "").trim();
      const base = { ...defaults };
      if (!raw) return base;
      let parsed = null;
      if (raw.startsWith("{") || raw.includes(":")) {
        try {
          parsed = parseYaml(raw);
        } catch (err) {
          console.warn("backlinks-daily-blocks: could not parse options", err);
        }
      }
      if (parsed && typeof parsed === "object") {
        return { ...base, ...parsed };
      }
      const fallbackKey = defaults.hasOwnProperty("target") ? "target" : defaults.hasOwnProperty("date") ? "date" : "value";
      return { ...base, [fallbackKey]: raw };
    }
    async function renderNoteSection(plugin, el, ctx, file, options, { asQuote }) {
      const section = el.createEl("div", { cls: asQuote ? "bdb-backlink" : "bdb-daily" });
      section.createEl("h4", { text: displayName(file) });
      if (isExcalidraw(file)) {
        const embed = `![[${file.path}${options.size ? "|" + options.size : ""}]]`;
        await MarkdownRenderer.renderMarkdown(embed, section, ctx.sourcePath, plugin);
        return;
      }
      const note = await prepareNote(plugin.app, file, { strip: true, truncate: options.truncate });
      const content = note.kind === "empty" ? "(empty note)" : note.content;
      const markdown = asQuote ? `> [[${file.path}|${file.basename}]]
>
> ${content.replace(/\n/g, "\n> ")}` : `${content}
`;
      await MarkdownRenderer.renderMarkdown(markdown, section, ctx.sourcePath, plugin);
    }
    async function renderBacklinksBlock2(plugin, source, el, ctx) {
      const { app } = plugin;
      const options = parseOptions(source, {
        target: null,
        ...plugin.settings?.backlinks || { sort: "ctime", limit: 20, truncate: 400, heading: "Backlinks" }
      });
      const currentPath = ctx.sourcePath;
      const targetFile = options.target ? app.metadataCache.getFirstLinkpathDest(options.target, currentPath || "") : app.vault.getAbstractFileByPath(currentPath);
      if (!(targetFile instanceof TFile)) {
        el.createEl("div", { text: `Target note not found: ${options.target || "(current file)"}` });
        return;
      }
      const backlinks = app.metadataCache.getBacklinksForFile(targetFile);
      const entries = [];
      if (backlinks?.data) {
        for (const [path] of backlinks.data.entries()) {
          const file = app.vault.getAbstractFileByPath(path);
          if (file instanceof TFile) {
            entries.push(file);
          }
        }
      }
      if (!entries.length) {
        el.createEl("div", { text: `No backlinks to ${targetFile.basename}.` });
        return;
      }
      const sortKey = (options.sort || "ctime").toLowerCase();
      entries.sort((a, b) => {
        const aStat = a.stat || {};
        const bStat = b.stat || {};
        if (sortKey === "mtime") return (bStat.mtime || 0) - (aStat.mtime || 0);
        return (bStat.ctime || 0) - (aStat.ctime || 0);
      });
      const limited = options.limit ? entries.slice(0, options.limit) : entries;
      el.createEl("h3", { text: `${options.heading} (${limited.length})` });
      for (const file of limited) {
        await renderNoteSection(plugin, el, ctx, file, options, { asQuote: true });
      }
    }
    async function renderDailyBlock2(plugin, source, el, ctx) {
      const { app } = plugin;
      const options = parseOptions(source, {
        date: null,
        size: "100%",
        ...plugin.settings?.daily || { order: "desc", limit: 0, truncate: 800, includeCurrent: false, heading: "Daily notes" }
      });
      let targetDate = (options.date || "").replace(/[^0-9]/g, "");
      if (!targetDate) {
        const match = ctx.sourcePath.match(/(\d{8})-\d{4}/);
        targetDate = match ? match[1] : moment().format("YYYYMMDD");
      }
      targetDate = targetDate.substring(0, 8);
      const pattern = /^\d{8}-\d{4}(?:\.excalidraw)?\.md$/;
      const files = app.vault.getFiles().filter((file) => {
        if (!pattern.test(file.name)) return false;
        if (!options.includeCurrent && file.path === ctx.sourcePath) return false;
        return file.name.startsWith(targetDate);
      });
      if (!files.length) {
        el.createEl("div", { text: `No notes found for ${targetDate}.` });
        return;
      }
      const order = (options.order || "desc").toLowerCase();
      files.sort((a, b) => {
        return order === "asc" ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
      });
      const limited = options.limit ? files.slice(0, options.limit) : files;
      el.createEl("h3", { text: `${options.heading} (${limited.length})` });
      for (const file of limited) {
        await renderNoteSection(plugin, el, ctx, file, options, { asQuote: false });
      }
    }
    module2.exports = { renderBacklinksBlock: renderBacklinksBlock2, renderDailyBlock: renderDailyBlock2 };
  }
});

// src/core/tasks.js
var require_tasks = __commonJS({
  "src/core/tasks.js"(exports2, module2) {
    var TASK_CHECKBOX_RE = /^(\s*[-*]\s*\[)( |x|X)(\])/;
    var TASK_LINE_RE = /^\s*[-*]\s*\[[ xX]\]/;
    async function setTaskOnLine(app, file, line, checked) {
      try {
        const content = await app.vault.read(file);
        const lines = content.split(/\r?\n/);
        if (line == null || line < 0 || line >= lines.length) return false;
        const original = lines[line];
        const updated = original.replace(TASK_CHECKBOX_RE, `$1${checked ? "x" : " "}$3`);
        if (updated === original) return false;
        lines[line] = updated;
        await app.vault.modify(file, lines.join("\n"));
        return true;
      } catch (err) {
        console.warn("backlinks-daily-blocks: toggle task failed", file?.path, err);
        return false;
      }
    }
    module2.exports = { TASK_CHECKBOX_RE, TASK_LINE_RE, setTaskOnLine };
  }
});

// src/core/render.js
var require_render = __commonJS({
  "src/core/render.js"(exports2, module2) {
    var { MarkdownRenderer } = require("obsidian");
    var { setTaskOnLine } = require_tasks();
    function bindInternalLinks(app, container, sourcePath) {
      const anchors = container.querySelectorAll("a.internal-link");
      for (const anchor of anchors) {
        if (anchor.__bdbBound) continue;
        anchor.__bdbBound = true;
        anchor.addEventListener("click", (evt) => {
          evt.preventDefault();
          const link = anchor.getAttribute("href") || anchor.dataset?.href;
          if (!link) return;
          const modEvent = evt.ctrlKey || evt.metaKey;
          app.workspace.openLinkText(link, sourcePath || "", modEvent);
        });
      }
    }
    async function renderInteractive(plugin, markdown, el, sourcePath) {
      await MarkdownRenderer.renderMarkdown(markdown, el, sourcePath, plugin);
      bindInternalLinks(plugin.app, el, sourcePath);
    }
    function wireTaskCheckboxes(plugin, container, file, resolveLine, { onToggled } = {}) {
      const boxes = container.querySelectorAll("input.task-list-item-checkbox");
      let i = -1;
      for (const box of boxes) {
        i++;
        if (box.__bdbBound) continue;
        box.__bdbBound = true;
        const line = resolveLine(i);
        if (line == null) continue;
        box.addEventListener("change", async () => {
          box.disabled = true;
          await setTaskOnLine(plugin.app, file, line, box.checked);
          box.disabled = false;
          if (onToggled) onToggled();
        });
      }
    }
    function openFileAtLine(app, file, lineNumber, modEvent) {
      const targetLine = Math.max(0, lineNumber || 0);
      app.workspace.openLinkText(file.path, "", modEvent);
      window.setTimeout(() => {
        const leaf = app.workspace.getMostRecentLeaf?.() || app.workspace.activeLeaf;
        const editor = leaf?.view?.editor;
        if (editor?.setCursor) {
          editor.setCursor({ line: targetLine, ch: 0 });
          if (editor.scrollIntoView) {
            editor.scrollIntoView({
              from: { line: targetLine, ch: 0 },
              to: { line: targetLine + 1, ch: 0 }
            }, true);
          }
        }
      }, 60);
    }
    module2.exports = { bindInternalLinks, renderInteractive, wireTaskCheckboxes, openFileAtLine };
  }
});

// src/kanban.js
var require_kanban = __commonJS({
  "src/kanban.js"(exports2, module2) {
    var { MarkdownRenderChild, Notice } = require("obsidian");
    var { renderInteractive, openFileAtLine } = require_render();
    var KB_TAG_GLOBAL_RE = /#kb\/[\w-]+/g;
    var KB_TAG_RE = /#kb\/([\w-]+)/;
    var STAMP_RE = /\s+\d{12}\s*$/;
    var TASK_RE = /^(\s*[-*]\s*\[)(.)(\]\s*)(.*)$/;
    var HIST_RE = /^\s*%%\s?kb (\d{12}) (.+?) > (.+?)\s?%%\s*$/;
    var COL_PALETTE = {
      backlog: "#8a8f98",
      todo: "#d29922",
      doing: "#2d7ff9",
      parked: "#8d7ee7",
      review: "#b180d7",
      done: "#2ea043",
      cancelled: "#e93147"
    };
    var COL_CYCLE = ["#2d7ff9", "#d29922", "#b180d7", "#2ea043", "#e93147", "#8a8f98"];
    function columnColor(config, col, index) {
      return config.colors?.[col.key] || COL_PALETTE[col.key] || COL_CYCLE[index % COL_CYCLE.length];
    }
    function colKey(name) {
      return name.toLowerCase().replace(/\s+/g, "-");
    }
    function parseSweeps(text) {
      const out = [];
      for (const route of (text || "").split(/[,\n]/)) {
        const [from, to] = route.split(">").map((s) => colKey(s.trim()));
        if (from && to) out.push({ from, to });
      }
      return out;
    }
    function parseColors(text) {
      const out = {};
      for (const part of (text || "").split(/[,\n]/)) {
        const [name, color] = part.split("=").map((s) => s.trim());
        if (name && color) out[colKey(name)] = color;
      }
      return out;
    }
    function parseKanbanConfig(src) {
      const config = { paths: [], columns: [], maxage: null, colors: {}, sweeps: [] };
      let lastKey = null;
      for (const rawLine of (src || "").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const m = line.match(/^(maxage|paths|columns|colors|sweep)\s*:\s*(.*)$/);
        const key = m ? m[1] : lastKey;
        const value = m ? m[2].trim() : line;
        lastKey = key;
        if (!key || !value) continue;
        if (key === "maxage") {
          config.maxage = Number(value) || 0;
        } else if (key === "sweep") {
          config.sweeps.push(...parseSweeps(value));
        } else if (key === "colors") {
          Object.assign(config.colors, parseColors(value));
        } else if (key === "paths") {
          config.paths.push(...value.split(",").map((s) => s.trim()).filter(Boolean));
        } else if (key === "columns") {
          config.columns.push(...value.split(",").map((s) => s.trim()).filter(Boolean).map((part) => {
            const [rawName, state] = part.split("=").map((s) => s.trim());
            const paused = rawName.endsWith("~");
            const name = paused ? rawName.slice(0, -1).trim() : rawName;
            return { name, key: colKey(name), state: state || null, paused };
          }));
        }
      }
      return config;
    }
    async function scanKanbanTasks(app, config) {
      const open = config.columns.filter((c) => !c.state);
      const byState = new Map(config.columns.filter((c) => c.state).map((c) => [c.state, c]));
      const byTag = new Map(open.map((c) => [c.key, c]));
      const cards = new Map(config.columns.map((c) => [c.key, []]));
      const cutoff = config.maxage ? stampNow(new Date(Date.now() - config.maxage * 864e5)) : null;
      const files = app.vault.getMarkdownFiles().filter((f) => !config.paths.length || config.paths.some((p) => f.path.startsWith(p)));
      for (const file of files) {
        const lines = (await app.vault.cachedRead(file)).split(/\r?\n/);
        const stack = [];
        for (let i = 0; i < lines.length; i++) {
          const text = lines[i];
          const tm = text.match(TASK_RE);
          if (tm) {
            const indent = indentWidth(text);
            while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
            const parent = stack.length ? stack[stack.length - 1].card : null;
            const card = { file, line: i, body: tm[4], state: tm[2], parent, children: [], history: [] };
            if (parent) parent.children.push(card);
            stack.push({ indent, card });
            let col;
            if (card.state === " ") col = byTag.get(card.body.match(KB_TAG_RE)?.[1]) || open[0];
            else {
              col = byState.get(card.state);
              if (col && cutoff && (card.body.match(STAMP_RE)?.[0]?.trim() || "") < cutoff) col = null;
            }
            if (col) cards.get(col.key).push(card);
            continue;
          }
          const hm = text.match(HIST_RE);
          if (hm) {
            const indent = indentWidth(text);
            for (let s = stack.length - 1; s >= 0; s--) {
              if (stack[s].indent < indent) {
                stack[s].card.history.push({ stamp: hm[1], from: hm[2], to: hm[3] });
                break;
              }
            }
            continue;
          }
          if (!/^\s/.test(text)) stack.length = 0;
        }
      }
      return cards;
    }
    function indentWidth(text) {
      let w = 0;
      for (const ch of text.match(/^\s*/)[0]) w += ch === "	" ? 4 : 1;
      return w;
    }
    function openDescendants(card) {
      let n = 0;
      for (const child of card.children) {
        if (child.state === " ") n++;
        n += openDescendants(child);
      }
      return n;
    }
    function countDescendants(card) {
      return card.children.reduce((n, child) => n + 1 + countDescendants(child), 0);
    }
    function cleanText(body) {
      return body.replace(KB_TAG_GLOBAL_RE, "").replace(STAMP_RE, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
    }
    function stampNow(d = /* @__PURE__ */ new Date()) {
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
    }
    function stampToDate(s) {
      return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12));
    }
    function fmtDur(ms) {
      const m = Math.floor(ms / 6e4);
      if (m < 60) return `${m}m`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h`;
      return `${Math.floor(h / 24)}d${h % 24 ? `${h % 24}h` : ""}`;
    }
    async function sweepColumn(app, config, fromCol, toCol, colCards) {
      const ordered = colCards.slice().sort((a, b) => a.file.path === b.file.path ? b.line - a.line : a.file.path.localeCompare(b.file.path));
      let moved = 0;
      let blocked = 0;
      for (const card of ordered) {
        if (toCol.state && openDescendants(card) > 0) {
          blocked++;
          continue;
        }
        if (await moveCard(app, card.file, card.line, toCol, config, { fromCol })) moved++;
      }
      new Notice(`kanban: swept ${moved} to ${toCol.name}${blocked ? `, ${blocked} blocked` : ""}`);
    }
    async function moveCard(app, file, line, targetCol, config, { fromCol } = {}) {
      const content = await app.vault.read(file);
      const lines = content.split(/\r?\n/);
      const m = lines[line]?.match(TASK_RE);
      if (!m) return false;
      const [, pre, , close] = m;
      const body = m[4].replace(KB_TAG_GLOBAL_RE, "").replace(STAMP_RE, "").replace(/\s{2,}/g, " ").trim();
      const firstOpen = config.columns.find((c) => !c.state);
      if (targetCol.state) {
        lines[line] = `${pre}${targetCol.state}${close}${body} ${stampNow()}`;
      } else {
        const tag = targetCol === firstOpen ? "" : ` #kb/${targetCol.key}`;
        lines[line] = `${pre} ${close}${body}${tag}`;
      }
      const indent = lines[line].match(/^\s*/)[0];
      lines.splice(line + 1, 0, `${indent}  %% kb ${stampNow()} ${fromCol?.name || "?"} > ${targetCol.name} %%`);
      await app.vault.modify(file, lines.join("\n"));
      return true;
    }
    function resolveKanbanConfig(plugin, src) {
      const config = parseKanbanConfig(src);
      const defaults = plugin.settings?.kanban || {};
      if (!config.columns.length) {
        config.columns = parseKanbanConfig(`columns: ${defaults.columns || "Backlog~, Todo, Doing, Parked~, Done=x, Cancelled=-"}`).columns;
      }
      if (!Object.keys(config.colors).length && defaults.colors) {
        config.colors = parseColors(defaults.colors);
      }
      if (!config.paths.length && defaults.paths) {
        config.paths = defaults.paths.split(",").map((s) => s.trim()).filter(Boolean);
      }
      if (config.maxage == null) config.maxage = defaults.maxage != null ? defaults.maxage : 7;
      if (!config.sweeps.length && defaults.sweep) {
        config.sweeps = parseSweeps(defaults.sweep);
      }
      return config;
    }
    async function renderKanbanBlock2(plugin, src, el, ctx) {
      el.empty();
      const config = resolveKanbanConfig(plugin, src);
      const states = config.columns.filter((c) => c.state).map((c) => c.state);
      if (new Set(states).size !== states.length) {
        el.createDiv({ text: "kanban: two columns share the same state char" });
        return;
      }
      const board = el.createDiv({ cls: "bdb-kanban" });
      const state = { dragging: false };
      const redraw = () => {
        if (!state.dragging) drawBoard(plugin, board, resolveKanbanConfig(plugin, src), state);
      };
      const child = new MarkdownRenderChild(el);
      ctx.addChild(child);
      child.registerInterval(window.setInterval(redraw, 6e4));
      let pending = null;
      child.registerEvent(plugin.app.vault.on("modify", () => {
        window.clearTimeout(pending);
        pending = window.setTimeout(redraw, 500);
      }));
      await drawBoard(plugin, board, config, state);
    }
    async function drawBoard(plugin, board, config, state = { dragging: false }) {
      board.empty();
      const cards = await scanKanbanTasks(plugin.app, config);
      const cardEls = /* @__PURE__ */ new Map();
      for (const [index, col] of config.columns.entries()) {
        const colCards = cards.get(col.key);
        const colEl = board.createDiv({ cls: "bdb-kanban-col" });
        colEl.style.setProperty("--kb-col-color", columnColor(config, col, index));
        const titleEl = colEl.createDiv({ cls: "bdb-kanban-col-title", text: `${col.name} (${colCards.length})` });
        for (const route of config.sweeps.filter((s) => s.from === col.key)) {
          const sweepTo = config.columns.find((c) => c.key === route.to);
          if (!sweepTo) continue;
          const btn = titleEl.createEl("button", {
            cls: "bdb-kanban-sweep",
            text: `\u2933 ${sweepTo.name}`,
            attr: { "aria-label": `Sweep all to ${sweepTo.name}` }
          });
          btn.addEventListener("click", async () => {
            await sweepColumn(plugin.app, config, col, sweepTo, colCards);
            await drawBoard(plugin, board, config, state);
          });
        }
        const list = colEl.createDiv({ cls: "bdb-kanban-cards" });
        const rejects = () => col.state && state.card && openDescendants(state.card) > 0;
        colEl.addEventListener("dragover", (e) => {
          e.preventDefault();
          if (rejects()) {
            e.dataTransfer.dropEffect = "none";
            colEl.classList.add("bdb-kanban-reject");
          } else {
            colEl.classList.add("bdb-kanban-over");
          }
        });
        colEl.addEventListener("dragleave", () => colEl.classList.remove("bdb-kanban-over", "bdb-kanban-reject"));
        colEl.addEventListener("drop", async (e) => {
          e.preventDefault();
          colEl.classList.remove("bdb-kanban-over", "bdb-kanban-reject");
          const [path, lineStr, fromKey] = (e.dataTransfer.getData("text/plain") || "").split("::");
          if (!path || fromKey === col.key) return;
          const file = plugin.app.vault.getAbstractFileByPath(path);
          if (!file) return;
          state.dragging = false;
          if (col.state) {
            const dragged = [...cards.values()].flat().find((c) => c.file.path === path && c.line === Number(lineStr));
            const blockers = dragged ? openDescendants(dragged) : 0;
            if (blockers) {
              new Notice(`kanban: ${blockers} open sub-task${blockers > 1 ? "s" : ""} \u2014 close them first`);
              return;
            }
          }
          await moveCard(plugin.app, file, Number(lineStr), col, config, {
            fromCol: config.columns.find((c) => c.key === fromKey)
          });
          await drawBoard(plugin, board, config, state);
        });
        for (const card of colCards) {
          const cardEl = list.createDiv({ cls: "bdb-kanban-card", attr: { draggable: "true" } });
          if (card.children.length) cardEl.classList.add("bdb-kanban-card-parent");
          cardEls.set(card, cardEl);
          if (card.parent) {
            const crumb = cardEl.createDiv({ cls: "bdb-kanban-card-crumb", text: `${cleanText(card.parent.body)} \u25B8` });
            crumb.addEventListener("click", (e) => {
              const parentEl = cardEls.get(card.parent);
              if (!parentEl) return openFileAtLine(plugin.app, card.parent.file, card.parent.line, e.ctrlKey || e.metaKey);
              parentEl.scrollIntoView({ behavior: "smooth", block: "center" });
              parentEl.classList.remove("bdb-kanban-glow");
              void parentEl.offsetWidth;
              parentEl.classList.add("bdb-kanban-glow");
            });
          }
          const display = card.body.replace(KB_TAG_GLOBAL_RE, "").replace(STAMP_RE, "").trim();
          const textEl = cardEl.createDiv({ cls: "bdb-kanban-card-text" });
          await renderInteractive(plugin, display, textEl, card.file.path);
          const total = countDescendants(card);
          if (total) {
            const closed = total - openDescendants(card);
            const host = textEl.querySelector("p") || textEl;
            const pill = host.createSpan({ cls: "bdb-kanban-card-rollup", text: `${closed}/${total}` });
            if (closed === total) pill.classList.add("bdb-kanban-card-rollup-full");
          }
          if (card.history.length) {
            const es = card.history.slice().sort((a, b) => a.stamp.localeCompare(b.stamp));
            const colorOf = new Map(config.columns.map((c, i) => [c.name, columnColor(config, c, i)]));
            const idle = new Set(config.columns.filter((c) => c.paused).map((c) => c.name));
            const terminal = !!col.state;
            const birthM = card.file.name.match(/^(\d{8})-(\d{4})/);
            const birth = birthM ? stampToDate(birthM[1] + birthM[2]) : null;
            const visits = [];
            if (birth) visits.push({ name: es[0].from, dur: Math.max(stampToDate(es[0].stamp) - birth, 0) });
            for (let i = 0; i < es.length; i++) {
              const isLast = i === es.length - 1;
              if (isLast && terminal) break;
              const dur = (isLast ? /* @__PURE__ */ new Date() : stampToDate(es[i + 1].stamp)) - stampToDate(es[i].stamp);
              visits.push({ name: es[i].to, dur });
            }
            const active = visits.filter((v) => !idle.has(v.name)).reduce((sum, v) => sum + v.dur, 0);
            const journeyStart = birth || stampToDate(es[0].stamp);
            const journeyEnd = terminal ? stampToDate(es[es.length - 1].stamp) : /* @__PURE__ */ new Date();
            const total2 = Math.max(journeyEnd - journeyStart, 0);
            const parts = visits.map((v) => `${v.name} ${fmtDur(v.dur)}`);
            if (!birth) parts.unshift(es[0].from);
            if (terminal) parts.push(col.name);
            const last = es[es.length - 1];
            const inSync = last.to === col.name;
            const lineStamp = card.body.match(STAMP_RE)?.[0]?.trim();
            let since = null;
            if (terminal && lineStamp) since = /* @__PURE__ */ new Date() - stampToDate(lineStamp);
            else if (inSync) since = /* @__PURE__ */ new Date() - stampToDate(last.stamp);
            const flow = cardEl.createDiv({ cls: "bdb-kanban-card-flow", attr: { title: parts.join(" \u2192 ") } });
            const bars = flow.createDiv({ cls: "bdb-kanban-card-bars" });
            for (const subset of [visits, visits.filter((v) => !idle.has(v.name))]) {
              const bar = bars.createDiv({ cls: "bdb-kanban-card-bar" });
              for (const v of subset) {
                const span = bar.createSpan();
                span.style.flexGrow = String(Math.max(v.dur, 1));
                span.style.background = colorOf.get(v.name) || "var(--background-modifier-border)";
              }
            }
            flow.createSpan({
              cls: "bdb-kanban-card-now",
              text: terminal ? `${fmtDur(active)} work \xB7 ${fmtDur(total2)} total` : since == null ? col.name : `${col.name} ${fmtDur(since)}`
            });
            if (!terminal && col.paused && col !== config.columns[0] && since != null) {
              if (since > 7 * 864e5) cardEl.classList.add("bdb-kanban-age-red");
              else if (since > 2 * 864e5) cardEl.classList.add("bdb-kanban-age-amber");
            }
          }
          const stamp = card.body.match(STAMP_RE)?.[0]?.trim();
          cardEl.createDiv({ cls: "bdb-kanban-card-meta", text: stamp ? `${card.file.basename} \xB7 ${stamp}` : card.file.basename });
          cardEl.addEventListener("dragstart", (e) => {
            state.dragging = true;
            state.card = card;
            e.dataTransfer.setData("text/plain", `${card.file.path}::${card.line}::${col.key}`);
            e.dataTransfer.effectAllowed = "move";
          });
          cardEl.addEventListener("dragend", () => {
            state.dragging = false;
            state.card = null;
          });
          cardEl.querySelector(".bdb-kanban-card-meta").addEventListener("click", (e) => {
            openFileAtLine(plugin.app, card.file, card.line, e.ctrlKey || e.metaKey);
          });
        }
      }
    }
    module2.exports = { parseKanbanConfig, scanKanbanTasks, moveCard, renderKanbanBlock: renderKanbanBlock2 };
  }
});

// src/settings.js
var require_settings = __commonJS({
  "src/settings.js"(exports2, module2) {
    var { PluginSettingTab, Setting } = require("obsidian");
    var DEFAULT_SETTINGS = {
      kanban: {
        columns: "Backlog~, Todo, Doing, Parked~, Done=x, Cancelled=-",
        colors: "",
        paths: "",
        maxage: 7,
        sweep: "Doing > Parked"
      },
      backlinks: {
        heading: "Backlinks",
        sort: "ctime",
        limit: 20,
        truncate: 400
      },
      daily: {
        heading: "Daily notes",
        order: "desc",
        limit: 0,
        truncate: 800,
        includeCurrent: false
      }
    };
    var TABS = ["Kanban", "Backlinks", "Daily", "Views"];
    var BdbSettingTab2 = class extends PluginSettingTab {
      constructor(plugin) {
        super(plugin.app, plugin);
        this.plugin = plugin;
        this.activeTab = "Kanban";
      }
      display() {
        const { containerEl } = this;
        containerEl.empty();
        const bar = containerEl.createDiv({ cls: "bdb-settings-tabs" });
        for (const name of TABS) {
          const btn = bar.createEl("button", {
            text: name,
            cls: name === this.activeTab ? "bdb-settings-tab bdb-settings-tab-active" : "bdb-settings-tab"
          });
          btn.addEventListener("click", () => {
            this.activeTab = name;
            this.display();
          });
        }
        const body = containerEl.createDiv();
        this[`render${this.activeTab}`](body);
      }
      // Bind a Setting text/textarea/number/toggle to settings[section][key], save on change.
      bind(setting, section, key, { number = false, area = false } = {}) {
        const s = this.plugin.settings[section];
        const save = async (value) => {
          s[key] = number ? Number(value) || 0 : value;
          await this.plugin.saveSettings();
        };
        if (typeof s[key] === "boolean") {
          setting.addToggle((t) => t.setValue(s[key]).onChange(async (v) => {
            s[key] = v;
            await this.plugin.saveSettings();
          }));
        } else if (area) {
          setting.setClass("bdb-setting-area");
          setting.addTextArea((t) => t.setValue(String(s[key])).onChange(save));
        } else {
          setting.addText((t) => t.setValue(String(s[key])).onChange(save));
        }
      }
      renderKanban(el) {
        this.bind(new Setting(el).setName("Default columns").setDesc("Comma list; Name=char marks a terminal column."), "kanban", "columns");
        this.bind(new Setting(el).setName("Column colors").setDesc("One Name=color per line; empty = built-in palette. e.g. Doing=#2d7ff9"), "kanban", "colors", { area: true });
        this.bind(new Setting(el).setName("Default paths").setDesc("Comma list of path prefixes to scan; empty = whole vault."), "kanban", "paths");
        this.bind(new Setting(el).setName("Max age (days)").setDesc("Hide terminal cards stamped older than this; 0 = show all."), "kanban", "maxage", { number: true });
        this.bind(new Setting(el).setName("Sweep").setDesc('One "From > To" route per line; each adds a bulk-move button on its From column. Empty disables.'), "kanban", "sweep", { area: true });
        const preview = new Setting(el).setName("Current config as block").setDesc("Read-only. Paste into a kanban code block in any note to clone this board.").setClass("bdb-setting-area");
        preview.addButton((b) => b.setButtonText("Copy").onClick(async () => {
          await navigator.clipboard.writeText(this.kanbanBlockText());
          b.setButtonText("Copied");
          window.setTimeout(() => b.setButtonText("Copy"), 1200);
        }));
        preview.addTextArea((t) => {
          t.inputEl.readOnly = true;
          t.inputEl.rows = 8;
          t.inputEl.classList.add("bdb-config-preview");
          const fill = () => t.setValue(this.kanbanBlockText());
          fill();
          t.inputEl.addEventListener("focus", () => {
            fill();
            t.inputEl.select();
          });
        });
      }
      // Settings rendered as ```kanban``` block syntax.
      kanbanBlockText() {
        const k = this.plugin.settings.kanban;
        const multi = (key, text) => [`${key}:`, ...text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean).map((s) => `  ${s}`)];
        const lines = [`columns: ${k.columns}`];
        if (k.paths) lines.push(`paths: ${k.paths}`);
        lines.push(`maxage: ${k.maxage}`);
        if (k.sweep) lines.push(...multi("sweep", k.sweep));
        if (k.colors) lines.push(...multi("colors", k.colors));
        return lines.join("\n");
      }
      renderBacklinks(el) {
        this.bind(new Setting(el).setName("Heading"), "backlinks", "heading");
        new Setting(el).setName("Sort").setDesc("Newest first by created or modified time.").addDropdown((d) => d.addOptions({ ctime: "ctime", mtime: "mtime" }).setValue(this.plugin.settings.backlinks.sort).onChange(async (v) => {
          this.plugin.settings.backlinks.sort = v;
          await this.plugin.saveSettings();
        }));
        this.bind(new Setting(el).setName("Limit").setDesc("Max notes shown; 0 = no limit."), "backlinks", "limit", { number: true });
        this.bind(new Setting(el).setName("Truncate").setDesc("Characters per note preview."), "backlinks", "truncate", { number: true });
      }
      renderDaily(el) {
        this.bind(new Setting(el).setName("Heading"), "daily", "heading");
        new Setting(el).setName("Order").addDropdown((d) => d.addOptions({ desc: "desc", asc: "asc" }).setValue(this.plugin.settings.daily.order).onChange(async (v) => {
          this.plugin.settings.daily.order = v;
          await this.plugin.saveSettings();
        }));
        this.bind(new Setting(el).setName("Limit").setDesc("Max notes shown; 0 = no limit."), "daily", "limit", { number: true });
        this.bind(new Setting(el).setName("Truncate").setDesc("Characters per note preview."), "daily", "truncate", { number: true });
        this.bind(new Setting(el).setName("Include current note"), "daily", "includeCurrent");
      }
      renderViews(el) {
        el.createEl("p", {
          text: "Chronicle, Atlas, Ledger and Beacon are Bases views: configure each one from the view options menu in the Bases toolbar.",
          cls: "setting-item-description"
        });
      }
    };
    function mergeSettings2(loaded) {
      const out = {};
      for (const [section, defaults] of Object.entries(DEFAULT_SETTINGS)) {
        out[section] = { ...defaults, ...loaded?.[section] || {} };
      }
      return out;
    }
    module2.exports = { DEFAULT_SETTINGS, BdbSettingTab: BdbSettingTab2, mergeSettings: mergeSettings2 };
  }
});

// src/views/base.js
var require_base = __commonJS({
  "src/views/base.js"(exports2, module2) {
    var { BasesView, TFile } = require("obsidian");
    var BdbBasesView = class extends BasesView {
      constructor(plugin, controller, parentEl, type, containerCls) {
        super(controller);
        this.type = type;
        this.plugin = plugin;
        this.containerEl = parentEl.createDiv(containerCls);
      }
      load() {
      }
      unload() {
      }
      getOption(key) {
        const config = this.config || {};
        return config.get ? config.get(key) : config[key];
      }
      // Yields every TFile entry across grouped data.
      *fileEntries() {
        if (!this.data?.groupedData) return;
        for (const group of this.data.groupedData) {
          for (const entry of group.entries) {
            if (entry.file instanceof TFile) yield entry;
          }
        }
      }
      // variant: 'red' | 'green' | 'green-thin' (see styles.css)
      waveSeparator(parentEl, variant = "red") {
        return parentEl.createDiv({ cls: `bdb-wave-sep bdb-wave-sep--${variant}` });
      }
    };
    module2.exports = { BdbBasesView };
  }
});

// src/views/chronicle.js
var require_chronicle = __commonJS({
  "src/views/chronicle.js"(exports2, module2) {
    var { BdbBasesView } = require_base();
    var { prepareNote, displayName, isExcalidraw } = require_notes();
    var { renderInteractive, wireTaskCheckboxes } = require_render();
    var { TASK_LINE_RE } = require_tasks();
    var CHRONICLE_VIEW_TYPE2 = "content-feed-bases-view";
    var ChronicleView2 = class extends BdbBasesView {
      constructor(plugin, controller, parentEl) {
        super(plugin, controller, parentEl, CHRONICLE_VIEW_TYPE2, "bases-content-feed-container");
      }
      async onDataUpdated() {
        const { app } = this;
        this.containerEl.empty();
        if (!this.data) {
          this.containerEl.createDiv({ text: "Loading..." });
          return;
        }
        const stripFrontmatter = this.getOption("stripFrontmatter") !== false;
        let truncateLength = Number(this.getOption("truncateLength"));
        if (!Number.isFinite(truncateLength) || truncateLength < 0) {
          truncateLength = 0;
        }
        const titleProperty = String(this.getOption("titleProperty") || "note.categories");
        const allEntries = Array.from(this.fileEntries());
        if (!allEntries.length) {
          this.containerEl.createDiv({ text: "No entries found." });
          return;
        }
        for (const entry of allEntries) {
          const file = entry.file;
          const note = await prepareNote(app, file, { strip: stripFrontmatter, truncate: truncateLength });
          if (note.kind === "empty") continue;
          this.waveSeparator(this.containerEl, "red");
          const section = this.containerEl.createDiv("bdb-bases-entry");
          const titleEl = section.createEl("h4");
          const linkEl = titleEl.createEl("a", { text: displayName(file), cls: "bdb-bases-title-link" });
          linkEl.addEventListener("click", (evt) => {
            evt.preventDefault();
            const modEvent = evt.ctrlKey || evt.metaKey;
            app.workspace.openLinkText(file.path, "", modEvent);
          });
          await this.renderTitleProperty(titleEl, entry, titleProperty, file);
          if (isExcalidraw(file)) {
            await renderInteractive(this.plugin, `![[${file.path}|100%]]`, section, file.path);
            continue;
          }
          await renderInteractive(this.plugin, `${note.content}
`, section, file.path);
          this.attachTaskCheckboxHandlers(section, file, note.lines);
        }
        this.waveSeparator(this.containerEl, "red");
      }
      async renderTitleProperty(titleEl, entry, titleProperty, file) {
        if (!titleProperty) return;
        const propertyValue = entry.getValue(titleProperty);
        if (!propertyValue?.data || !Array.isArray(propertyValue.data)) return;
        const valueLinks = propertyValue.data.filter((val) => val).map((val) => {
          if (val && val.path) {
            const label = val.display || val.path.split("/").pop().replace(".md", "");
            return `[[${val.path}|${label}]]`;
          }
          return String(val);
        });
        if (!valueLinks.length) return;
        const propertySpan = titleEl.createSpan({ cls: "bdb-bases-categories" });
        await renderInteractive(this.plugin, ` (${valueLinks.join(", ")})`, propertySpan, file.path);
      }
      // Map the i-th rendered checkbox to the i-th task list item from the
      // metadata cache (best-effort match, same order as rendered markdown).
      attachTaskCheckboxHandlers(container, file, rawLines) {
        if (!rawLines?.length) return;
        const listItems = this.app.metadataCache.getFileCache(file)?.listItems || [];
        const taskItems = listItems.filter((item) => {
          const line = item?.position?.start?.line;
          if (line == null) return false;
          return TASK_LINE_RE.test(rawLines[line] || "");
        });
        wireTaskCheckboxes(this.plugin, container, file, (i) => {
          const line = taskItems[i]?.position?.start?.line;
          if (line == null || line < 0 || line >= rawLines.length) return null;
          return line;
        });
      }
    };
    module2.exports = { ChronicleView: ChronicleView2, CHRONICLE_VIEW_TYPE: CHRONICLE_VIEW_TYPE2 };
  }
});

// src/views/atlas.js
var require_atlas = __commonJS({
  "src/views/atlas.js"(exports2, module2) {
    var { TFile } = require("obsidian");
    var { BdbBasesView } = require_base();
    var ATLAS_VIEW_TYPE2 = "properties-aggregation-view";
    var AtlasView2 = class extends BdbBasesView {
      constructor(plugin, controller, parentEl) {
        super(plugin, controller, parentEl, ATLAS_VIEW_TYPE2, "bdb-properties-aggregation");
        this.frontmatterUpdating = false;
      }
      resolveHostFile() {
        const ownHostPath = this.containerEl?.getAttribute?.("data-path");
        if (ownHostPath) {
          const file = this.app.vault.getAbstractFileByPath(ownHostPath);
          if (file instanceof TFile) return file;
        }
        const hostEl = this.containerEl?.closest?.("[data-path]");
        const hostPath = hostEl?.getAttribute?.("data-path");
        if (hostPath) {
          const file = this.app.vault.getAbstractFileByPath(hostPath);
          if (file instanceof TFile) return file;
        }
        const active = this.app.workspace.getActiveFile();
        return active instanceof TFile ? active : null;
      }
      async updateFrontmatterWithAggregates(aggregatedData) {
        if (this.frontmatterUpdating) return;
        const targetFile = this.resolveHostFile();
        if (!(targetFile instanceof TFile)) return;
        const filePath = targetFile.path || "";
        const frontmatter = this.app.metadataCache.getFileCache(targetFile)?.frontmatter || {};
        const optOut = frontmatter["bdb-disable-sync"] === true;
        const looksLikeTemplate = /\/Templates\//i.test(filePath) || /template/i.test(targetFile.basename);
        if (optOut || looksLikeTemplate) return;
        const updates = {};
        for (const [propertyKey, valueMap] of aggregatedData) {
          const values = Array.from(valueMap.values()).map((info) => {
            const display = (info?.displayName || info?.key || "").toString().trim();
            if (!display) return "";
            if (info?.linkPath) {
              const targetName = info.linkPath.split("/").pop()?.replace(/\.md$/i, "") || "";
              const normalizedDisplay = display.replace(/\.md$/i, "");
              if (targetName && normalizedDisplay === targetName) {
                return `[[${info.linkPath}]]`;
              }
              return `[[${info.linkPath}|${display}]]`;
            }
            return display;
          }).filter(Boolean);
          if (!values.length) continue;
          const deduped = [];
          for (const val of values) {
            if (!deduped.includes(val)) deduped.push(val);
          }
          updates[propertyKey] = deduped.length === 1 ? deduped[0] : deduped;
        }
        if (!Object.keys(updates).length) return;
        this.frontmatterUpdating = true;
        try {
          await this.app.fileManager.processFrontMatter(targetFile, (frontmatter2) => {
            for (const [key, val] of Object.entries(updates)) {
              const current = frontmatter2[key];
              const bothArrays = Array.isArray(current) && Array.isArray(val);
              const sameArray = bothArrays && current.length === val.length && current.every((item, idx) => item === val[idx]);
              if (current === val || sameArray) continue;
              frontmatter2[key] = val;
            }
          });
        } catch (err) {
          console.warn("backlinks-daily-blocks: update frontmatter failed", err);
        } finally {
          this.frontmatterUpdating = false;
        }
      }
      async onDataUpdated() {
        const { app } = this;
        this.containerEl.empty();
        const targetFile = this.resolveHostFile();
        if (targetFile) {
          this.containerEl.setAttribute("data-path", targetFile.path);
        }
        const targetDateMatch = targetFile?.basename?.match(/^(\d{8})/);
        const targetDatePrefix = targetDateMatch ? targetDateMatch[1] : null;
        if (!targetFile || !targetDatePrefix) {
          this.containerEl.createDiv({ text: "No target note detected for properties sync.", cls: "bdb-properties-empty" });
          return;
        }
        if (!this.data?.groupedData) {
          this.containerEl.createDiv({ text: "No data available", cls: "bdb-properties-empty" });
          return;
        }
        const blacklistRaw = this.getOption("propertyBlacklist") ?? "file,journal,journal-date,aliases,captured-from";
        const excludeProperties = String(blacklistRaw).split(",").map((p) => p.trim()).filter(Boolean);
        if (!excludeProperties.includes("aliases")) excludeProperties.push("aliases");
        const dateEntries = Array.from(this.fileEntries()).filter((entry) => entry.file.basename.startsWith(targetDatePrefix));
        const allPropertyKeys = /* @__PURE__ */ new Set();
        for (const entry of dateEntries) {
          const cache = app.metadataCache.getFileCache(entry.file);
          if (!cache?.frontmatter) continue;
          for (const key of Object.keys(cache.frontmatter)) {
            if (key !== "position" && !excludeProperties.includes(key)) {
              allPropertyKeys.add(key);
            }
          }
        }
        if (!allPropertyKeys.size) {
          this.containerEl.createDiv({ text: "No properties found", cls: "bdb-properties-empty" });
          return;
        }
        const aggregatedData = /* @__PURE__ */ new Map();
        for (const propertyKey of allPropertyKeys) {
          const propertyMap = this.aggregateProperty(propertyKey, dateEntries);
          if (propertyMap.size > 0) {
            aggregatedData.set(propertyKey, propertyMap);
          }
        }
        if (!aggregatedData.size) {
          this.containerEl.createDiv({ text: "No properties found", cls: "bdb-properties-empty" });
          return;
        }
        await this.updateFrontmatterWithAggregates(aggregatedData);
        this.containerEl.createDiv({ text: "Properties synced to frontmatter.", cls: "bdb-properties-synced" });
      }
      isPresenceOnlyProperty(propertyKey) {
        const propertyInfo = this.app.metadataTypeManager?.getPropertyInfo(propertyKey);
        if (propertyInfo?.type === "checkbox") return true;
        for (const entry of this.fileEntries()) {
          const cache = this.app.metadataCache.getFileCache(entry.file);
          if (!cache?.frontmatter) continue;
          const rawValue = cache.frontmatter[propertyKey];
          const isPresenceLike = rawValue === void 0 || rawValue === null || typeof rawValue === "boolean" || rawValue === "";
          if (!isPresenceLike) return false;
        }
        return true;
      }
      aggregateProperty(propertyKey, dateEntries) {
        const propertyMap = /* @__PURE__ */ new Map();
        const isCheckbox = this.isPresenceOnlyProperty(propertyKey);
        for (const entry of dateEntries) {
          const file = entry.file;
          const cache = this.app.metadataCache.getFileCache(file);
          if (!cache?.frontmatter) continue;
          if (!(propertyKey in cache.frontmatter)) continue;
          const rawValue = cache.frontmatter[propertyKey];
          if (isCheckbox) {
            const timeMatch = file.basename.match(/\d{8}-(\d{4})/);
            const timestamp = timeMatch ? timeMatch[1] : file.basename;
            this.addToPropertyMap(propertyMap, file.path, timestamp, file.path, file);
            continue;
          }
          if (rawValue === void 0 || rawValue === null) continue;
          const values = Array.isArray(rawValue) ? rawValue : [rawValue];
          for (const val of values) {
            const parsed = this.parsePropertyValue(val);
            if (!parsed) continue;
            this.addToPropertyMap(propertyMap, parsed.key, parsed.displayName, parsed.linkPath, file);
          }
        }
        return propertyMap;
      }
      parsePropertyValue(val) {
        if (val && typeof val === "object" && val.path) {
          return {
            key: val.path,
            linkPath: val.path,
            displayName: val.display || val.path.split("/").pop().replace(".md", "")
          };
        }
        const strVal = String(val);
        const wikiLinkMatch = strVal.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/);
        if (wikiLinkMatch) {
          return {
            key: wikiLinkMatch[1],
            linkPath: wikiLinkMatch[1],
            displayName: wikiLinkMatch[2] || wikiLinkMatch[1].split("/").pop()
          };
        }
        return { key: strVal, linkPath: null, displayName: strVal };
      }
      addToPropertyMap(propertyMap, key, displayName, linkPath, file) {
        if (!propertyMap.has(key)) {
          propertyMap.set(key, { displayName, linkPath, sources: [] });
        }
        propertyMap.get(key).sources.push({ file, basename: file.basename });
      }
    };
    module2.exports = { AtlasView: AtlasView2, ATLAS_VIEW_TYPE: ATLAS_VIEW_TYPE2 };
  }
});

// src/views/ledger.js
var require_ledger = __commonJS({
  "src/views/ledger.js"(exports2, module2) {
    var { BdbBasesView } = require_base();
    var { setTaskOnLine } = require_tasks();
    var { renderInteractive, openFileAtLine } = require_render();
    var LEDGER_VIEW_TYPE2 = "tasks-aggregation-view";
    var LedgerView2 = class extends BdbBasesView {
      constructor(plugin, controller, parentEl) {
        super(plugin, controller, parentEl, LEDGER_VIEW_TYPE2, "bdb-tasks-aggregation");
        this.controllerRef = controller;
      }
      captureOpenGroupState() {
        const openGroups = /* @__PURE__ */ new Set();
        const detailsEls = this.containerEl.querySelectorAll("details[open][data-bdb-group-id]");
        detailsEls.forEach((el) => {
          const id = el.getAttribute("data-bdb-group-id");
          if (id) openGroups.add(id);
        });
        return openGroups;
      }
      resolveGroupBy() {
        const taskGroupByRaw = this.getOption("taskGroupBy");
        const legacyGroupByRaw = this.getOption("groupBy");
        const controllerObj = this.controllerRef || this.controller || {};
        const controllerView = controllerObj.view || controllerObj.viewDefinition || controllerObj.definition || controllerObj.options;
        const viewGroupBy = controllerView?.groupBy;
        const groupByRaw = taskGroupByRaw || viewGroupBy?.property || viewGroupBy || legacyGroupByRaw;
        const config = this.config || {};
        if (!taskGroupByRaw && legacyGroupByRaw && config.set) {
          config.set("taskGroupBy", legacyGroupByRaw);
        }
        if (groupByRaw && typeof groupByRaw === "object") {
          return (groupByRaw.property || "").toString().trim();
        }
        return groupByRaw ? groupByRaw.toString().trim() : "";
      }
      extractGroupValues(cache, groupBy) {
        if (!groupBy) return [];
        const rawVal = cache?.frontmatter ? cache.frontmatter[groupBy] : void 0;
        const values = Array.isArray(rawVal) ? rawVal : rawVal !== void 0 && rawVal !== null ? [rawVal] : [];
        return values.map((val) => {
          if (val && typeof val === "object") {
            if (val.path) {
              const key = val.path;
              const label = (val.display || val.path.split("/").pop() || "").replace(/\.md$/, "");
              return { key, label: label || key };
            }
            return null;
          }
          const strVal = String(val).trim();
          if (!strVal) return null;
          const wikiLinkMatch = strVal.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/);
          if (wikiLinkMatch) {
            const key = wikiLinkMatch[1];
            const label = (wikiLinkMatch[2] || wikiLinkMatch[1]).replace(/\.md$/, "").split("/").pop();
            return { key, label: label || key };
          }
          const trimmed = strVal.replace(/\.md$/, "");
          return { key: strVal, label: trimmed.split("/").pop() || trimmed };
        }).filter(Boolean);
      }
      async collectTasks(groupBy, includeCompleted, contains) {
        const { app } = this;
        const tasks = [];
        for (const entry of this.fileEntries()) {
          const file = entry.file;
          const cache = app.metadataCache.getFileCache(file);
          const listItems = cache?.listItems || [];
          if (!listItems.length) continue;
          let fileLines = null;
          for (const item of listItems) {
            if (!item || typeof item.task !== "string") continue;
            const pos = item.position?.start;
            if (!pos || pos.line == null) continue;
            if (!fileLines) {
              try {
                const content = await app.vault.cachedRead(file);
                fileLines = content.split(/\r?\n/);
              } catch (err) {
                console.warn("backlinks-daily-blocks: task read failed", file.path, err);
                break;
              }
            }
            const rawLine = fileLines[pos.line] || "";
            const statusMatch = rawLine.match(/^\s*[-*]\s*\[([^\]])\]/);
            if (!statusMatch) continue;
            const status = statusMatch[1] || " ";
            const completed = status.toLowerCase() === "x" || status === "-";
            if (!includeCompleted && completed) continue;
            const taskText = rawLine.replace(/^\s*[-*]\s*\[[^\]]\]\s*/, "").trim();
            if (contains && !taskText.toLowerCase().includes(contains)) continue;
            tasks.push({
              file,
              line: pos.line,
              text: taskText || "(empty task)",
              completed,
              status,
              rawLine,
              groupValues: this.extractGroupValues(cache, groupBy)
            });
          }
        }
        return tasks;
      }
      async onDataUpdated() {
        const openGroupState = this.captureOpenGroupState();
        this.containerEl.empty();
        if (!this.data?.groupedData) {
          this.containerEl.createDiv({ text: "No data available", cls: "bdb-tasks-empty" });
          return;
        }
        const includeCompleted = this.getOption("includeCompleted") !== false;
        const contains = (this.getOption("contains") || "").toString().trim().toLowerCase();
        const groupBy = this.resolveGroupBy();
        const foldSubgroups = this.getOption("foldSubgroups") !== false;
        const tasks = await this.collectTasks(groupBy, includeCompleted, contains);
        if (!tasks.length) {
          this.containerEl.createDiv({ text: "No tasks found", cls: "bdb-tasks-empty" });
          return;
        }
        const hasBaseSorters = Array.isArray(this.data?.sorters) && this.data.sorters.length > 0;
        if (!hasBaseSorters) {
          tasks.sort((a, b) => {
            const pathCompare = a.file.path.localeCompare(b.file.path);
            if (pathCompare !== 0) return pathCompare;
            return a.line - b.line;
          });
        }
        const incomplete = tasks.filter((t) => !t.completed);
        const complete = tasks.filter((t) => t.completed);
        const shouldBeOpen = (groupId, defaultOpen) => {
          if (!openGroupState.size) return defaultOpen;
          return openGroupState.has(groupId);
        };
        await this.renderGroup("Incomplete", incomplete, false, groupBy, foldSubgroups, shouldBeOpen);
        if (complete.length) {
          this.containerEl.createDiv({ cls: "bdb-task-separator" });
          await this.renderGroup("Complete", complete, true, groupBy, foldSubgroups, shouldBeOpen);
        }
      }
      async renderTaskList(listEl, items) {
        for (const task of items) {
          const itemEl = listEl.createDiv({ cls: "bdb-task-item" });
          const status = (task.status || "").trim();
          const isToggleable = status === "" || status === " " || status.toLowerCase() === "x";
          const textEl = itemEl.createSpan({ cls: "bdb-task-link" });
          await renderInteractive(this.plugin, task.rawLine || task.text, textEl, task.file.path);
          const renderedBox = textEl.querySelector("input.task-list-item-checkbox");
          if (renderedBox) {
            if (isToggleable) {
              renderedBox.checked = task.completed;
              renderedBox.addEventListener("change", async () => {
                renderedBox.disabled = true;
                await setTaskOnLine(this.app, task.file, task.line, renderedBox.checked);
                renderedBox.disabled = false;
                this.onDataUpdated();
              });
            } else {
              renderedBox.disabled = true;
            }
          }
          const metaEl = itemEl.createEl("a", {
            text: ` \xB7 ${task.file.basename}:${task.line + 1}`,
            cls: "bdb-task-meta",
            href: "#"
          });
          metaEl.addEventListener("click", (evt) => {
            evt.preventDefault();
            const modEvent = evt.ctrlKey || evt.metaKey;
            openFileAtLine(this.app, task.file, task.line, modEvent);
          });
          this.waveSeparator(listEl, "green-thin");
        }
      }
      async renderGroup(title, items, collapsedByDefault, groupBy, foldSubgroups, shouldBeOpen) {
        const topGroupId = `top:${title}`;
        const details = this.containerEl.createEl("details", { cls: "bdb-task-group" });
        details.setAttr("data-bdb-group-id", topGroupId);
        if (shouldBeOpen(topGroupId, !collapsedByDefault)) details.setAttr("open", "open");
        details.createEl("summary", { text: `${title} (${items.length})`, cls: "bdb-task-group-title" });
        const listEl = details.createDiv({ cls: "bdb-tasks-list" });
        if (!groupBy) {
          await this.renderTaskList(listEl, items);
          return details;
        }
        const groupMap = /* @__PURE__ */ new Map();
        const unsetGroup = { key: "__ungrouped__", label: "! Unset" };
        for (const task of items) {
          const values = task.groupValues && task.groupValues.length ? task.groupValues : [unsetGroup];
          for (const val of values) {
            if (!groupMap.has(val.key)) {
              const label = val.label && val.label.trim() || val.key || unsetGroup.label;
              groupMap.set(val.key, { key: val.key, label, items: [] });
            }
            groupMap.get(val.key).items.push(task);
          }
        }
        const orderedGroups = Array.from(groupMap.values()).sort((a, b) => a.label.localeCompare(b.label));
        for (const subgroup of orderedGroups) {
          const subgroupId = `sub:${title}:${subgroup.key}`;
          const subgroupDetails = listEl.createEl("details", { cls: "bdb-task-subgroup" });
          subgroupDetails.setAttr("data-bdb-group-id", subgroupId);
          if (shouldBeOpen(subgroupId, !foldSubgroups)) subgroupDetails.setAttr("open", "open");
          const heading = subgroupDetails.createEl("summary", { cls: "bdb-task-subgroup-title" });
          const labelText = subgroup.label;
          const countText = ` (${subgroup.items.length})`;
          const isUnset = subgroup.key === "__ungrouped__";
          if (groupBy && !isUnset) {
            const linkEl = heading.createEl("a", { text: labelText, cls: "internal-link", href: "#" });
            linkEl.addEventListener("click", (evt) => {
              evt.preventDefault();
              const modEvent = evt.ctrlKey || evt.metaKey;
              this.app.workspace.openLinkText(subgroup.key, "", modEvent);
            });
            heading.appendText(countText);
          } else {
            heading.setText(labelText + countText);
          }
          const subgroupList = subgroupDetails.createDiv({ cls: "bdb-task-subgroup-list" });
          await this.renderTaskList(subgroupList, subgroup.items);
        }
        return details;
      }
    };
    module2.exports = { LedgerView: LedgerView2, LEDGER_VIEW_TYPE: LEDGER_VIEW_TYPE2 };
  }
});

// src/views/beacon.js
var require_beacon = __commonJS({
  "src/views/beacon.js"(exports2, module2) {
    var { BdbBasesView } = require_base();
    var { renderInteractive, wireTaskCheckboxes, openFileAtLine } = require_render();
    var BEACON_VIEW_TYPE2 = "hashtags-aggregation-view";
    var escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    var BeaconView2 = class extends BdbBasesView {
      constructor(plugin, controller, parentEl) {
        super(plugin, controller, parentEl, BEACON_VIEW_TYPE2, "bdb-wins-aggregation");
      }
      buildPluralTagList(tagList) {
        const out = /* @__PURE__ */ new Set();
        for (const tag of tagList) {
          const base = (tag || "").replace(/^#/, "").trim().toLowerCase();
          if (!base) continue;
          const add = (value) => {
            if (value && value !== base) out.add(`#${value}`);
          };
          if (!base.endsWith("s")) add(`${base}s`);
          if (base.endsWith("y") && base.length > 1) add(`${base.slice(0, -1)}ies`);
          if (/(s|x|z|ch|sh)$/.test(base)) add(`${base}es`);
        }
        return Array.from(out);
      }
      async collectWins(winRegex, pluralTagRegex) {
        const { app } = this;
        const wins = [];
        for (const entry of this.fileEntries()) {
          const file = entry.file;
          let lines = [];
          try {
            const content = await app.vault.cachedRead(file);
            lines = content.split(/\r?\n/);
          } catch (err) {
            console.warn("backlinks-daily-blocks: read failed", file.path, err);
            continue;
          }
          let hasPluralTag = false;
          if (pluralTagRegex) {
            for (const line of lines) {
              pluralTagRegex.lastIndex = 0;
              if (pluralTagRegex.test(line)) {
                hasPluralTag = true;
                break;
              }
            }
          }
          let inFrontmatter = lines[0]?.trim() === "---";
          lines.forEach((line, idx) => {
            winRegex.lastIndex = 0;
            if (winRegex.test(line)) {
              const text = line.trim();
              wins.push({ file, line: idx, text: text || "(win)", raw: line });
              return;
            }
            if (!hasPluralTag) return;
            const trimmed = line.trim();
            if (!trimmed) return;
            if (inFrontmatter) {
              if (idx > 0 && trimmed === "---") inFrontmatter = false;
              return;
            }
            if (/^#{1,6}\s/.test(trimmed)) return;
            if (/^>\s*$/.test(trimmed)) return;
            if (pluralTagRegex) {
              pluralTagRegex.lastIndex = 0;
              if (pluralTagRegex.test(trimmed) && !/\s/.test(trimmed)) return;
            }
            if (!/^\s*[-*]\s+\[\s\]\s+/.test(line)) return;
            wins.push({ file, line: idx, text: trimmed, raw: line });
          });
        }
        return wins;
      }
      async onDataUpdated() {
        this.containerEl.empty();
        const tagList = (this.getOption("tags") || "#win").split(",").map((t) => t.trim()).filter(Boolean).map((t) => t.startsWith("#") ? t : `#${t}`);
        this.containerEl.createEl("h3", { text: tagList.join(", "), cls: "bdb-wins-heading" });
        if (!this.data?.groupedData) {
          this.containerEl.createDiv({ text: "No data available", cls: "bdb-wins-empty" });
          return;
        }
        const escapedTags = tagList.map(escapeRegex);
        const winRegex = new RegExp(`(${escapedTags.join("|")})\\b`, "gi");
        const escapedPluralTags = this.buildPluralTagList(tagList).map(escapeRegex);
        const pluralTagRegex = escapedPluralTags.length ? new RegExp(`(${escapedPluralTags.join("|")})\\b`, "gi") : null;
        const highlightRegex = escapedPluralTags.length ? new RegExp(`(${escapedTags.concat(escapedPluralTags).join("|")})\\b`, "gi") : winRegex;
        const wins = await this.collectWins(winRegex, pluralTagRegex);
        if (!wins.length) {
          this.containerEl.createDiv({ text: "No records found", cls: "bdb-wins-empty" });
          return;
        }
        const list = this.containerEl.createDiv({ cls: "bdb-wins-list" });
        for (const win of wins) {
          this.waveSeparator(list, "green");
          const li = list.createDiv({ cls: "bdb-wins-item" });
          const row = li.createDiv({ cls: "bdb-wins-row" });
          const textEl = row.createDiv({ cls: "bdb-wins-text" });
          await renderInteractive(this.plugin, win.raw || win.text, textEl, win.file.path);
          wireTaskCheckboxes(this.plugin, textEl, win.file, () => win.line);
          this.highlightHashtags(textEl, highlightRegex);
          textEl.addEventListener("click", (evt) => {
            const targetEl = evt.target;
            if (targetEl?.closest && targetEl.closest("a, input, button, textarea, select")) return;
            evt.preventDefault();
            const modEvent = evt.ctrlKey || evt.metaKey;
            openFileAtLine(this.app, win.file, win.line, modEvent);
          });
          const meta = row.createSpan({ cls: "bdb-wins-meta" });
          const markdown = `[[${win.file.path}|${win.file.basename}:${win.line + 1}]]`;
          await renderInteractive(this.plugin, markdown, meta, win.file.path);
        }
      }
      highlightHashtags(container, tagRegex) {
        if (!tagRegex) return;
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        for (const node of nodes) {
          const text = node.nodeValue || "";
          tagRegex.lastIndex = 0;
          if (!tagRegex.test(text)) continue;
          tagRegex.lastIndex = 0;
          const frag = document.createDocumentFragment();
          let lastIndex = 0;
          let match;
          while ((match = tagRegex.exec(text)) !== null) {
            if (match.index > lastIndex) {
              frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
            }
            const span = document.createElement("span");
            span.textContent = match[1];
            span.className = "bdb-wins-tag";
            frag.appendChild(span);
            lastIndex = tagRegex.lastIndex;
          }
          if (lastIndex < text.length) {
            frag.appendChild(document.createTextNode(text.slice(lastIndex)));
          }
          const parent = node.parentNode;
          if (parent) parent.replaceChild(frag, node);
        }
      }
    };
    module2.exports = { BeaconView: BeaconView2, BEACON_VIEW_TYPE: BEACON_VIEW_TYPE2 };
  }
});

// src/main.js
var { Plugin } = require("obsidian");
var { renderBacklinksBlock, renderDailyBlock } = require_blocks();
var { renderKanbanBlock } = require_kanban();
var { BdbSettingTab, mergeSettings } = require_settings();
var { ChronicleView, CHRONICLE_VIEW_TYPE } = require_chronicle();
var { AtlasView, ATLAS_VIEW_TYPE } = require_atlas();
var { LedgerView, LEDGER_VIEW_TYPE } = require_ledger();
var { BeaconView, BEACON_VIEW_TYPE } = require_beacon();
var BacklinksDailyBlocksPlugin = class extends Plugin {
  async onload() {
    this.settings = mergeSettings(await this.loadData());
    this.addSettingTab(new BdbSettingTab(this));
    this.normalizeBaseGroupBy().catch((err) => console.warn("backlinks-daily-blocks: normalize groupBy failed", err));
    this.registerMarkdownCodeBlockProcessor("backlinks", (src, el, ctx) => {
      return renderBacklinksBlock(this, src, el, ctx);
    });
    this.registerMarkdownCodeBlockProcessor("daily", (src, el, ctx) => {
      return renderDailyBlock(this, src, el, ctx);
    });
    this.registerMarkdownCodeBlockProcessor("kanban", (src, el, ctx) => {
      return renderKanbanBlock(this, src, el, ctx);
    });
    this.registerBasesView(CHRONICLE_VIEW_TYPE, {
      name: "Chronicle",
      icon: "lucide-scroll-text",
      factory: (controller, containerEl) => new ChronicleView(this, controller, containerEl),
      options: () => [
        {
          type: "toggle",
          displayName: "Strip frontmatter",
          key: "stripFrontmatter",
          default: true
        },
        {
          type: "number",
          displayName: "Truncate length",
          key: "truncateLength",
          default: 0
        },
        {
          type: "text",
          displayName: "Show property beside title",
          key: "titleProperty",
          default: "note.categories"
        }
      ]
    });
    this.registerBasesView(ATLAS_VIEW_TYPE, {
      name: "Atlas",
      icon: "lucide-list-tree",
      factory: (controller, containerEl) => new AtlasView(this, controller, containerEl),
      options: () => [
        {
          type: "text",
          displayName: "Property blacklist (comma-separated)",
          key: "propertyBlacklist",
          default: "file,journal,journal-date,aliases,captured-from"
        }
      ]
    });
    this.registerBasesView(LEDGER_VIEW_TYPE, {
      name: "Ledger",
      icon: "lucide-check-square",
      factory: (controller, containerEl) => new LedgerView(this, controller, containerEl),
      options: () => [
        {
          type: "toggle",
          displayName: "Include completed tasks",
          key: "includeCompleted",
          default: true
        },
        {
          type: "text",
          displayName: "Contains (case-insensitive)",
          key: "contains",
          default: ""
        },
        {
          type: "text",
          displayName: "Group by property (optional)",
          key: "taskGroupBy",
          default: ""
        },
        {
          type: "toggle",
          displayName: "Fold subgroups by default when grouped",
          key: "foldSubgroups",
          default: true
        }
      ]
    });
    this.registerBasesView(BEACON_VIEW_TYPE, {
      name: "Beacon",
      icon: "lucide-flag",
      factory: (controller, containerEl) => new BeaconView(this, controller, containerEl),
      options: () => [
        {
          type: "text",
          displayName: "Hashtags (comma-separated)",
          key: "tags",
          default: "#win"
        }
      ]
    });
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  async normalizeBaseGroupBy(targetFile) {
    const files = targetFile ? [targetFile] : this.app.vault.getFiles().filter((f) => f.extension === "base");
    for (const file of files) {
      if (file.extension !== "base") continue;
      let content;
      try {
        content = await this.app.vault.read(file);
      } catch (err) {
        console.warn("backlinks-daily-blocks: read base failed", file.path, err);
        continue;
      }
      const updated = content.replace(/(^[ \t]*)groupBy:\s*([A-Za-z0-9_.\/:-]+)\s*$/gm, (match, indent, prop) => {
        const property = (prop || "").trim();
        if (!property) return match;
        return `${indent}groupBy:
${indent}  property: ${property}
${indent}  direction: ASC`;
      });
      if (updated !== content) {
        try {
          await this.app.vault.modify(file, updated);
        } catch (err) {
          console.warn("backlinks-daily-blocks: write base failed", file.path, err);
        }
      }
    }
  }
};
module.exports = BacklinksDailyBlocksPlugin;
