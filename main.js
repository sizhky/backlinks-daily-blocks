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
    async function prepareNote(app2, file, { strip = true, truncate = 0 } = {}) {
      if (isExcalidraw(file)) {
        return { kind: "excalidraw", content: "", lines: [] };
      }
      let raw = "";
      try {
        raw = await app2.vault.cachedRead(file);
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
      const { app: app2 } = plugin;
      const options = parseOptions(source, {
        target: null,
        ...plugin.settings?.backlinks || { sort: "ctime", limit: 20, truncate: 400, heading: "Backlinks" }
      });
      const currentPath = ctx.sourcePath;
      const targetFile = options.target ? app2.metadataCache.getFirstLinkpathDest(options.target, currentPath || "") : app2.vault.getAbstractFileByPath(currentPath);
      if (!(targetFile instanceof TFile)) {
        el.createEl("div", { text: `Target note not found: ${options.target || "(current file)"}` });
        return;
      }
      const backlinks = app2.metadataCache.getBacklinksForFile(targetFile);
      const entries = [];
      if (backlinks?.data) {
        for (const [path] of backlinks.data.entries()) {
          const file = app2.vault.getAbstractFileByPath(path);
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
      const { app: app2 } = plugin;
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
      const files = app2.vault.getFiles().filter((file) => {
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
    async function setTaskOnLine(app2, file, line, checked) {
      try {
        const content = await app2.vault.read(file);
        const lines = content.split(/\r?\n/);
        if (line == null || line < 0 || line >= lines.length) return false;
        const original = lines[line];
        const updated = original.replace(TASK_CHECKBOX_RE, `$1${checked ? "x" : " "}$3`);
        if (updated === original) return false;
        lines[line] = updated;
        await app2.vault.modify(file, lines.join("\n"));
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
    function bindInternalLinks(app2, container, sourcePath) {
      const anchors = container.querySelectorAll("a.internal-link");
      for (const anchor of anchors) {
        if (anchor.__bdbBound) continue;
        anchor.__bdbBound = true;
        anchor.addEventListener("click", (evt) => {
          evt.preventDefault();
          const link = anchor.getAttribute("href") || anchor.dataset?.href;
          if (!link) return;
          const modEvent = evt.ctrlKey || evt.metaKey;
          app2.workspace.openLinkText(link, sourcePath || "", modEvent);
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
    function openFileAtLine(app2, file, lineNumber, modEvent) {
      const targetLine = Math.max(0, lineNumber || 0);
      app2.workspace.openLinkText(file.path, "", modEvent);
      window.setTimeout(() => {
        const leaf = app2.workspace.getMostRecentLeaf?.() || app2.workspace.activeLeaf;
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

// src/core/activity.js
var require_activity = __commonJS({
  "src/core/activity.js"(exports2, module2) {
    var GAP_MS = 30 * 6e4;
    function sleepGap(lastTick, now, gapMs = GAP_MS) {
      if (!Number.isFinite(lastTick) || lastTick <= 0) return null;
      return now - lastTick > gapMs ? lastTick : null;
    }
    function chrono(history2) {
      return history2.slice().sort((x, y) => x.stamp.localeCompare(y.stamp) || (y.seq ?? 0) - (x.seq ?? 0));
    }
    function stampMs(s) {
      s = String(s).replace(/\D/g, "");
      return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12)).getTime();
    }
    function birthMs(name) {
      const m = String(name).match(/^(\d{8})-(\d{4})/);
      return m ? stampMs(m[1] + m[2]) : null;
    }
    function backdateOk(atMs, history2) {
      const latest = Math.max(0, ...history2.map((h) => stampMs(h.stamp)));
      return atMs >= latest;
    }
    function stints(history2, want, lo, hi, openEnd, stillIn = true) {
      const ordered = chrono(history2);
      const out = [];
      for (let i = 0; i < ordered.length; i++) {
        if (ordered[i].to.toLowerCase() !== want) continue;
        if (!ordered[i + 1] && !stillIn) continue;
        const s = stampMs(ordered[i].stamp);
        const raw = ordered[i + 1] ? stampMs(ordered[i + 1].stamp) : openEnd(s);
        const cs = Math.max(s, lo), ce = Math.min(raw, hi);
        if (ce > cs) out.push({ s: cs, e: ce, open: !ordered[i + 1] });
      }
      return out;
    }
    var MULL_MS = 60 * 6e4;
    var QUEUE = ["backlog", "todo"];
    function adhoc(history2, createdMs = null, mullMs = MULL_MS) {
      const ordered = chrono(history2);
      if (!ordered.length) return null;
      let t = Number.isFinite(createdMs) ? createdMs : stampMs(ordered[0].stamp);
      let queued = 0;
      let inQueue = QUEUE.includes(String(ordered[0].from || "backlog").toLowerCase());
      for (const h of ordered) {
        const at = stampMs(h.stamp);
        if (inQueue) queued += Math.max(0, at - t);
        if (h.to.toLowerCase() === "doing") return queued < mullMs;
        inQueue = QUEUE.includes(h.to.toLowerCase());
        t = at;
      }
      return null;
    }
    function planned(history2, createdMs = null, mullMs = MULL_MS) {
      return adhoc(history2, createdMs, mullMs) === false;
    }
    function parseActivity(text) {
      const out = [];
      for (const line of String(text || "").split("\n")) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          const s = Date.parse(o.start), e = Date.parse(o.end);
          if (Number.isFinite(s) && Number.isFinite(e) && e > s) out.push({ ...o, s, e });
        } catch {
        }
      }
      return out.sort((a, b) => a.s - b.s);
    }
    function overlapMs(spans, cover) {
      let ms = 0;
      for (const a of spans) for (const b of cover) {
        const s = Math.max(a.s, b.s), e = Math.min(a.e, b.e);
        if (e > s) ms += e - s;
      }
      return ms;
    }
    function union(ivals) {
      const sorted = ivals.slice().sort((a, b) => a.s - b.s);
      const out = [];
      for (const x of sorted) {
        const last = out[out.length - 1];
        if (last && x.s <= last.e) last.e = Math.max(last.e, x.e);
        else out.push({ s: x.s, e: x.e });
      }
      return out;
    }
    function desktopRef(v) {
      if (v == null) return null;
      const s = String(v).trim();
      if (!s || s.length > 40 || /[%\r\n]/.test(s)) return null;
      if (/^\d+$/.test(s)) return +s >= 1 && +s <= 9 ? String(+s) : null;
      return s;
    }
    module2.exports = { birthMs, chrono, desktopRef, GAP_MS, MULL_MS, sleepGap, stampMs, backdateOk, stints, adhoc, planned, parseActivity, overlapMs, union };
  }
});

// src/habits.js
var require_habits = __commonJS({
  "src/habits.js"(exports2, module2) {
    var { parseKanbanConfig: parseKanbanConfig2, scanKanbanTasks, stampToDate, cleanText, moveCard: moveCard2, logTapSpan, addTitleCopy } = require_kanban();
    var { MarkdownRenderChild, setIcon } = require("obsidian");
    var { openFileAtLine } = require_render();
    var { chrono } = require_activity();
    var HABIT_COLS = "columns: Idle~, Doing!";
    function spans(history2) {
      const h = chrono(history2);
      const out = [];
      let start = null;
      for (const m of h) {
        if (m.to === "Doing") start = stampToDate(m.stamp);
        else if (m.from === "Doing" && start) {
          const end = stampToDate(m.stamp);
          out.push({ start, end, ms: end - start });
          start = null;
        }
      }
      if (start) out.push({ start, end: null, ms: null });
      return out;
    }
    function bucketByDay(history2, metric, year) {
      const days = /* @__PURE__ */ new Map();
      for (const s of spans(history2)) {
        const d = s.end || s.start;
        if (d.getFullYear() !== year) continue;
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const cur = days.get(key) || { value: 0, sessions: 0, open: false };
        cur.sessions += 1;
        if (s.end === null) cur.open = true;
        else cur.value += metric === "count" ? 1 : s.ms / 36e5;
        days.set(key, cur);
      }
      return days;
    }
    async function collectHabits(app2, paths2, year) {
      const config = parseKanbanConfig2(`${HABIT_COLS}
paths: ${paths2.join(", ")}`);
      const cards = await scanKanbanTasks(app2, config, {
        cacheFilter: (cache) => cache?.frontmatter?.metric != null
      });
      const all = [].concat(...cards.values());
      return all.map((card) => {
        const fm = app2.metadataCache.getFileCache(card.file).frontmatter;
        const metric = (card.metric || fm.metric) === "count" ? "count" : "sum";
        return {
          name: cleanText(card.body),
          metric,
          color: card.color || fm.kbcolor || null,
          days: bucketByDay(card.history, metric, year)
        };
      });
    }
    function fmtHours(h) {
      const min = Math.round((h || 0) * 60);
      const hh = Math.floor(min / 60), mm = min % 60;
      if (hh && mm) return `${hh}h${mm}m`;
      return hh ? `${hh}h` : `${mm}m`;
    }
    function fmtVal(v, metric) {
      if (metric === "count") return `${v}x`;
      return fmtHours(v);
    }
    function showPadBubble(text, x, y) {
      let el = document.querySelector(".bdb-report-drag-bubble");
      if (!el) {
        el = document.createElement("div");
        el.className = "bdb-report-drag-bubble";
        document.body.appendChild(el);
      }
      el.textContent = text;
      const pad = 12;
      const width = el.offsetWidth || 0;
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const clamped = Math.max(pad + width / 2, Math.min(vw - pad - width / 2, x));
      const anchor = width ? (x - (clamped - width / 2)) / width * 100 : 50;
      el.style.left = `${clamped}px`;
      el.style.top = `${y}px`;
      el.style.setProperty("--bdb-bubble-anchor", `${Math.max(10, Math.min(90, anchor))}%`);
      el.classList.add("is-visible");
    }
    function hidePadBubble() {
      document.querySelector(".bdb-report-drag-bubble")?.classList.remove("is-visible");
    }
    function renderPadIcon(parent, icon, color) {
      const box = parent.createDiv({ cls: "bdb-pad-icon", attr: { "aria-hidden": "true" } });
      const match = String(icon || "").match(/^([a-z0-9]+(?:-[a-z0-9]+)*):([a-z0-9]+(?:-[a-z0-9]+)*)$/i);
      if (!match) {
        setIcon(box, "activity");
        return;
      }
      const src = `https://api.iconify.design/${match[1]}/${match[2]}.svg?color=${encodeURIComponent(color || "#8b949e")}`;
      const img = box.createEl("img", { attr: { src, alt: "", loading: "lazy", decoding: "async" } });
      img.addEventListener("error", () => {
        img.remove();
        setIcon(box, "activity");
      }, { once: true });
    }
    function renderPadTitle(parent, text) {
      const nameEl = parent.createDiv({ cls: "bdb-pad-name" });
      const track = nameEl.createDiv({ cls: "bdb-pad-name-track" });
      const first = track.createSpan({ cls: "bdb-pad-name-copy", text });
      window.requestAnimationFrame(() => {
        const overflow = first.scrollWidth - nameEl.clientWidth;
        if (overflow <= 8) return;
        const gap = 56;
        track.createSpan({ cls: "bdb-pad-name-copy bdb-pad-name-copy-ghost", text });
        nameEl.addClass("is-ticker");
        nameEl.style.setProperty("--bdb-ticker-gap", `${gap}px`);
        nameEl.style.setProperty("--bdb-ticker-shift", `${first.scrollWidth + gap}px`);
        nameEl.style.setProperty("--bdb-ticker-duration", `${Math.max(7, Math.round((first.scrollWidth + gap) / 18))}s`);
      });
    }
    function dayKey(d) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
    var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    function renderHabitRow(parent, habit, year, today) {
      const row = parent.createDiv({ cls: "bdb-habit-row" });
      if (habit.color) row.style.setProperty("--kb-habit-color", habit.color);
      const head = row.createDiv({ cls: "bdb-habit-head" });
      const nameEl = head.createDiv({ cls: "bdb-habit-name", text: habit.name });
      addTitleCopy(nameEl, habit.name);
      const max = Math.max(0, ...[...habit.days.values()].map((d) => d.value));
      const total = [...habit.days.values()].reduce((a, d) => a + d.value, 0);
      const active = [...habit.days.values()].filter((d) => d.value > 0 || d.open).length;
      head.createDiv({
        cls: "bdb-habit-stat",
        text: `${active}d \xB7 ${fmtVal(total, habit.metric)} total`
      });
      const grid = row.createDiv({ cls: "bdb-habit-grid" });
      const jan1 = new Date(year, 0, 1);
      const startDow = (jan1.getDay() + 6) % 7;
      let lastMonth = -1;
      for (let i = 0; i < 366; i++) {
        const d = new Date(year, 0, 1 + i);
        if (d.getFullYear() !== year) break;
        const col = Math.floor((startDow + i) / 7) + 1;
        const dow = (d.getDay() + 6) % 7;
        if (d.getMonth() !== lastMonth) {
          lastMonth = d.getMonth();
          const lbl = grid.createDiv({ cls: "bdb-habit-month", text: MONTHS[d.getMonth()] });
          lbl.style.gridColumn = `${col}`;
          lbl.style.gridRow = "1";
        }
        const cell = grid.createDiv({ cls: "bdb-habit-cell" });
        cell.style.gridColumn = `${col}`;
        cell.style.gridRow = `${dow + 2}`;
        const info = habit.days.get(dayKey(d));
        const future = d > today;
        if (info?.open) {
          cell.addClass("bdb-h-open");
          cell.setAttribute("aria-label", `${dayKey(d)}: in progress`);
        } else if (info && info.value > 0) {
          const lvl = max ? Math.min(4, Math.ceil(info.value / max * 4)) : 0;
          cell.addClass(`bdb-h${lvl}`);
          cell.setAttribute("aria-label", `${dayKey(d)}: ${fmtVal(info.value, habit.metric)}`);
        } else if (future) {
          cell.addClass("bdb-h-future");
        } else {
          cell.addClass("bdb-h-empty");
          cell.setAttribute("aria-label", `${dayKey(d)}: \u2014`);
        }
      }
    }
    async function renderHabitsBlock2(plugin, source, el, ctx) {
      const lines = (source || "").split(/\r?\n/);
      let paths2 = [], year = null;
      for (const line of lines) {
        const m = line.match(/^(paths|year)\s*:\s*(.*)$/);
        if (!m) continue;
        if (m[1] === "paths") paths2 = m[2].split(",").map((s) => s.trim()).filter(Boolean);
        else year = parseInt(m[2].replace(/[^0-9]/g, ""), 10) || null;
      }
      if (!paths2.length) paths2 = [ctx.sourcePath];
      const now = /* @__PURE__ */ new Date();
      if (!year) year = now.getFullYear();
      const habits = await collectHabits(plugin.app, paths2, year);
      const wrap = el.createDiv({ cls: "bdb-habits" });
      wrap.createDiv({ cls: "bdb-habits-title", text: `Habits ${year}` });
      if (!habits.length) {
        wrap.createDiv({ text: `no habit cards under ${paths2.join(", ")}` });
        return;
      }
      for (const h of habits.sort((a, b) => a.name.localeCompare(b.name))) {
        renderHabitRow(wrap, h, year, now);
      }
    }
    function habitStats(history2, metric, now) {
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const byDay = /* @__PURE__ */ new Map();
      let open = false;
      for (const s of spans(history2)) {
        const d = s.end || s.start;
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        if (s.end === null) {
          open = true;
          continue;
        }
        const v = metric === "count" ? 1 : s.ms / 36e5;
        byDay.set(key, (byDay.get(key) || 0) + v);
      }
      if (!byDay.size && !open) return null;
      const vals = [...byDay.values()];
      const todayVal = byDay.get(today) || 0;
      const loggedDays = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const latest = loggedDays[loggedDays.length - 1] || null;
      const latestPrev = loggedDays.length > 1 ? loggedDays[loggedDays.length - 2] : null;
      const dayVal = (offset) => {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
        const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        return byDay.get(k) || 0;
      };
      const yesterdayVal = dayVal(1);
      const prevVal = dayVal(2);
      const prev2Val = dayVal(3);
      const lastN = (n) => {
        let sum = 0;
        for (let i = 0; i < n; i++) {
          const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
          const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          sum += byDay.get(k) || 0;
        }
        return sum / n;
      };
      const avg3 = lastN(3);
      const avg7 = lastN(7);
      const avg30 = lastN(30);
      const _closedActive = [];
      for (let i = 1; _closedActive.length < 3 && i <= 90; i++) {
        const v = dayVal(i);
        if (v > 0) _closedActive.push(v);
      }
      const avg3Closed = _closedActive.length > 0 ? _closedActive.reduce((a, b) => a + b, 0) / _closedActive.length : 0;
      const spark7 = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        spark7.push(byDay.get(k) || 0);
      }
      let streak = 0;
      for (let i = 0; i < 366; i++) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        if (byDay.get(k)) streak++;
        else if (i > 0) break;
      }
      const trend = avg30 === 0 ? 0 : (avg7 - avg30) / avg30;
      return {
        metric,
        open,
        today: todayVal,
        avg3,
        avg3Closed,
        avg7,
        streak,
        spark7,
        latestDay: latest?.[0] || null,
        latestVal: latest?.[1] || 0,
        latestPrevDay: latestPrev?.[0] || null,
        latestPrevVal: latestPrev?.[1] || 0,
        yesterday: yesterdayVal,
        prevDay: prevVal,
        min: Math.min(...vals),
        max: Math.max(...vals),
        mean: vals.reduce((a, b) => a + b, 0) / vals.length,
        days: byDay.size,
        trend,
        deltaLatest: (latest?.[1] || 0) - (latestPrev?.[1] || 0),
        deltaMu3: (latest?.[1] || 0) - avg3Closed
      };
    }
    async function renderHabitPad2(plugin, source, el, ctx) {
      const child = new MarkdownRenderChild(el);
      ctx.addChild(child);
      const config = parseKanbanConfig2(source || "");
      if (!config.columns.length) config.columns = parseKanbanConfig2(HABIT_COLS).columns;
      if (!config.paths.length) config.paths = [ctx.sourcePath];
      const liveCol = config.columns.find((c) => c.live) || config.columns.find((c) => !c.state && !c.paused);
      const idleCol = config.columns.find((c) => !c.state && c.paused) || config.columns.find((c) => !c.state);
      const draw = async () => {
        el.empty();
        const cardsByCol = await scanKanbanTasks(plugin.app, config, {
          cacheFilter: (cache) => cache?.frontmatter?.metric != null
        });
        const now = /* @__PURE__ */ new Date();
        const items = [];
        for (const [colKey, list] of cardsByCol) {
          for (const card of list) {
            const fm = plugin.app.metadataCache.getFileCache(card.file)?.frontmatter || {};
            if (fm.metric == null) continue;
            items.push({ card, colKey, fm });
          }
        }
        items.sort((a, b) => cleanText(a.card.body).localeCompare(cleanText(b.card.body)));
        const grid = el.createDiv({ cls: "bdb-pad" });
        for (const { card, colKey, fm } of items) {
          const metric = (card.metric || fm.metric) === "count" ? "count" : "sum";
          const tap = card.tap === true || fm.tap === true || fm.tap === "true";
          const doing = !tap && colKey === liveCol?.key;
          const st = habitStats(card.history, metric, now);
          const color = card.color || fm.kbcolor || null;
          const btn = grid.createDiv({ cls: "bdb-pad-card" + (doing ? " bdb-pad-on" : "") });
          if (color) btn.style.setProperty("--kb-card-color", color);
          const head = btn.createDiv({ cls: "bdb-pad-head" });
          renderPadIcon(head, card.icon || fm.icon, doing ? "#ffffff" : color);
          renderPadTitle(head, cleanText(card.body));
          const openBtn = head.createSpan({ cls: "bdb-pad-open", attr: { "aria-label": "Open habit note" } });
          setIcon(openBtn, "external-link");
          let sub = [];
          if (doing) {
            const sp = spans(card.history);
            const open = sp[sp.length - 1];
            const elapsed = open && open.end === null ? (now - open.start) / 36e5 : 0;
            sub = [{ text: `\u25B6 ${fmtHours(elapsed)}` }, { text: "live now" }];
          } else {
            if (st) {
              const f = (v) => metric === "count" ? `${Number(v.toFixed(1)).toString()}x` : fmtHours(v);
              const trendCls = st.deltaLatest > 0.05 ? "up" : st.deltaLatest < -0.05 ? "down" : "flat";
              const muCls = st.deltaMu3 > 0.05 ? "up" : st.deltaMu3 < -0.05 ? "down" : "flat";
              const arrow = trendCls === "up" ? "\u2191" : trendCls === "down" ? "\u2193" : "\u2192";
              const muArrow = muCls === "up" ? "\u2191" : muCls === "down" ? "\u2193" : "\u2192";
              sub = [
                { text: `${st.streak}d \xB7 ${f(st.today)}` },
                {
                  chunks: [
                    { text: `last ${f(st.latestVal)} ` },
                    { trend: { text: arrow, cls: trendCls } }
                  ]
                },
                {
                  chunks: [
                    { text: `\u03BC3 ${f(st.avg3Closed)} ` },
                    { trend: { text: muArrow, cls: muCls } }
                  ]
                }
              ];
            } else sub = [{ text: tap ? "tap to log" : "tap to start" }];
          }
          const subEl = btn.createDiv({ cls: "bdb-pad-sub" });
          for (const line of sub) {
            const lineEl = subEl.createDiv({ cls: "bdb-pad-subline" });
            if (line.chunks) {
              for (const chunk of line.chunks) {
                if (chunk.text) lineEl.appendText(chunk.text);
                if (chunk.trend) lineEl.createSpan({ cls: `bdb-pad-trend bdb-pad-trend-${chunk.trend.cls}`, text: chunk.trend.text });
              }
            } else {
              lineEl.appendText(line.text);
              if (line.trend) lineEl.createSpan({ cls: `bdb-pad-trend bdb-pad-trend-${line.trend.cls}`, text: line.trend.text });
            }
          }
          if (st?.spark7?.some((v) => v > 0)) {
            const sparkEl = btn.createDiv({ cls: "bdb-pad-spark", attr: { "aria-label": "Last 7 days activity" } });
            const sparkMax = Math.max(1, ...st.spark7);
            for (let i = 0; i < st.spark7.length; i++) {
              const v = st.spark7[i];
              const bar = sparkEl.createDiv({ cls: "bdb-pad-spark-bar" + (!v ? " is-zero" : "") });
              bar.style.setProperty("--bdb-bar-h", `${Math.max(2, Math.round(v / sparkMax * 18))}px`);
              const day = `${i === st.spark7.length - 1 ? "today" : `${st.spark7.length - 1 - i}d ago`}: ${fmtVal(v, metric)}`;
              const label = v ? day : `${day} (none)`;
              bar.setAttribute("aria-label", label);
              bar.addEventListener("pointerenter", (e) => showPadBubble(label, e.clientX, e.clientY - 14));
              bar.addEventListener("pointermove", (e) => showPadBubble(label, e.clientX, e.clientY - 14));
              bar.addEventListener("pointerleave", hidePadBubble);
            }
          }
          openBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            openFileAtLine(plugin.app, card.file, card.line, e.ctrlKey || e.metaKey);
          });
          btn.addEventListener("click", async (e) => {
            const cur = config.columns.find((c) => c.key === colKey);
            if (tap) {
              await logTapSpan(plugin.app, card.file, card.line);
              showPadBubble("+1", e.clientX, e.clientY - 14);
              window.setTimeout(hidePadBubble, 800);
              await draw();
              return;
            }
            const target = doing ? idleCol : liveCol;
            if (!target) return;
            await moveCard2(plugin.app, card.file, card.line, target, config, { fromCol: cur });
            await draw();
          });
        }
        if (!items.length) grid.createDiv({ text: `no habit cards under ${paths.join(", ")}` });
      };
      child.registerInterval(window.setInterval(draw, 6e4));
      await draw();
    }
    module2.exports = { spans, bucketByDay, collectHabits, renderHabitsBlock: renderHabitsBlock2, habitStats, fmtHours, renderHabitPad: renderHabitPad2 };
  }
});

// src/kanban.js
var require_kanban = __commonJS({
  "src/kanban.js"(exports2, module2) {
    var { MarkdownRenderChild, Menu, Notice: Notice2, Platform, setIcon } = require("obsidian");
    var { renderInteractive, openFileAtLine } = require_render();
    var { desktopRef, chrono } = require_activity();
    var LANE_NONE = "__none__";
    var KB_TAG_GLOBAL_RE = /#kb\/[\w-]+/g;
    var KB_TAG_RE = /#kb\/([\w-]+)/;
    var STAMP_RE = /\s+\d{8}-?\d{4}\s*$/;
    var TASK_RE2 = /^(\s*[-*]\s*\[)(.)(\]\s*)(.*)$/;
    var TASK_END_RE2 = /^(\s*[-*]\s*\[.\]\s*.*|\s*---+\s*)$/;
    var HIST_RE2 = /^\s*%%\s?kb (\d{8}-?\d{4}) (.+?) > (.+?)\s?%%\s*$/;
    var EI_HIST_RE = /^\s*%%\s?ei (\d{8}-?\d{4}) ([\w-]+)\s?%%\s*$/;
    var COLOR_RE = /^\s*%%\s?kbcolor (#[0-9a-fA-F]{3,8}|[a-zA-Z]+)\s?%%\s*$/;
    var ICON_RE = /^\s*%%\s?kbicon ([a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*)\s?%%\s*$/i;
    var METRIC_RE = /^\s*%%\s?kbmetric (count|sum)\s?%%\s*$/i;
    var TAP_RE = /^\s*%%\s?kbtap\s?%%\s*$/i;
    var RANK_RE = /^\s*%%\s?kbrank (-?\d+(?:\.\d+)?(?:e-?\d+)?)\s?%%\s*$/i;
    var DESKTOP_RE = /^\s*%%\s?kbdesktop ([^%]+?)\s?%%\s*$/i;
    var EST_RE = /^\s*%%\s?kbest (\d+)\s?%%\s*$/i;
    var TAGLINE_RE = /^\s*((?:#[\w/-]+|\[\[[^\]]+\]\])(?:[ \t]+(?:#[\w/-]+|\[\[[^\]]+\]\]))*)[ \t]*$/;
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
    function parseFilters(text) {
      const out = [];
      for (const part of (text || "").split(/[,\n]/)) {
        let s = part.trim();
        if (!s) continue;
        const absent = s.startsWith("!");
        if (absent) s = s.slice(1).trim();
        const neq = s.includes("!=");
        const [key, value] = s.split(/!?=/).map((x) => x.trim());
        const values = (value || "").split("|").map((x) => x.trim().replace(/^\[\[|\]\]$/g, "").toLowerCase()).filter(Boolean);
        if (key) out.push({ key: key.replace(/^\[\[|\]\]$/g, ""), values, absent, neq });
      }
      return out;
    }
    function fmValues(cache, key) {
      let v = cache?.frontmatter?.[key];
      if (v == null) return [];
      if (!Array.isArray(v)) v = [v];
      return v.filter((x) => x != null).map((x) => String(x).replace(/^\[\[|\]\]$/g, "").trim()).filter(Boolean);
    }
    function passesFilter(cache, f) {
      const vals = fmValues(cache, f.key);
      if (f.absent) return !vals.length;
      if (!f.values.length) return vals.length > 0;
      const hit = vals.some((v) => f.values.includes(v.toLowerCase()));
      return f.neq ? !hit : hit;
    }
    function parseColors(text) {
      const out = {};
      for (const part of (text || "").split(/[,\n]/)) {
        const [name, color] = part.split("=").map((s) => s.trim());
        if (name && color) out[colKey(name)] = color;
      }
      return out;
    }
    function parseKanbanConfig2(src) {
      const config = { paths: [], columns: [], maxage: null, colors: {}, sweeps: [], filters: [], lane: null, groupby: null, lanes: [], open: [], hidedonelanes: false, lanesort: null, mode: null, layout: null, includeInactive: false, only: [], autoFold: null };
      let lastKey = null;
      for (const rawLine of (src || "").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const m = line.match(/^(maxage|paths|columns|colors|sweep|filter|lane|groupby|lanes|open|hidedonelanes|lanesort|mode|layout|include-inactive|only|auto-fold|fold)\s*:\s*(.*)$/);
        const key = m ? m[1] : lastKey;
        const value = m ? m[2].trim() : line;
        lastKey = key;
        if (!key || !value) continue;
        if (key === "maxage") {
          config.maxage = Number(value) || 0;
        } else if (key === "mode") {
          config.mode = value.toLowerCase();
        } else if (key === "layout") {
          config.layout = value.toLowerCase() === "horizontal" ? "horizontal" : "vertical";
        } else if (key === "include-inactive") {
          config.includeInactive = value.toLowerCase() === "true";
        } else if (key === "auto-fold" || key === "fold") {
          config.autoFold = value !== "false";
        } else if (key === "hidedonelanes") {
          config.hidedonelanes = value !== "false";
        } else if (key === "lanesort") {
          config.lanesort = colKey(value);
        } else if (key === "filter") {
          config.filters.push(...parseFilters(value));
        } else if (key === "lane") {
          config.lane = value;
        } else if (key === "groupby") {
          config.groupby = value;
        } else if (key === "lanes") {
          config.lanes.push(...value.split(",").map((s) => s.trim()).filter(Boolean));
        } else if (key === "open") {
          config.open.push(...value.split(",").map((s) => s.trim()).filter(Boolean));
        } else if (key === "only") {
          config.only.push(...value.split(",").map((s) => colKey(s.trim())).filter(Boolean));
        } else if (key === "sweep") {
          config.sweeps.push(...parseSweeps(value));
        } else if (key === "colors") {
          Object.assign(config.colors, parseColors(value));
        } else if (key === "paths") {
          config.paths.push(...value.split(",").map((s) => s.trim()).filter(Boolean));
        } else if (key === "columns") {
          config.columns.push(...value.split(",").map((s) => s.trim()).filter(Boolean).map((part) => {
            const [spec, color] = part.split("@").map((s) => s.trim());
            let [name, state] = spec.split("=").map((s) => s.trim());
            let paused = false;
            let live = false;
            let age = null;
            let am;
            while (am = name.match(/(~(\d+(?:\.\d+)?)?|!)$/)) {
              if (am[1][0] === "~") {
                paused = true;
                age = am[2] ? Number(am[2]) : 1;
              } else live = true;
              name = name.slice(0, name.length - am[1].length).trim();
            }
            if (color) config.colors[colKey(name)] = color;
            return { name, key: colKey(name), state: state || null, paused, live, age };
          }));
        }
      }
      return config;
    }
    async function scanKanbanTasks(app2, config, opts = {}) {
      const open = config.columns.filter((c) => !c.state);
      const byState = new Map(config.columns.filter((c) => c.state).map((c) => [c.state, c]));
      const byTag = new Map(open.map((c) => [c.key, c]));
      const cards = new Map(config.columns.map((c) => [c.key, []]));
      const cutoff = config.maxage ? stampNow(new Date(Date.now() - config.maxage * 864e5)) : null;
      const files = app2.vault.getMarkdownFiles().filter((f) => {
        if (config.paths.length && !config.paths.some((p) => f.path.startsWith(p))) return false;
        const cache = app2.metadataCache.getFileCache(f);
        if (!cache?.listItems?.some((it) => it.task != null)) return false;
        const cacheFilter = opts.cacheFilter || config.cacheFilter;
        if (cacheFilter && !cacheFilter(cache, f)) return false;
        return config.filters.every((fl) => passesFilter(cache, fl));
      });
      for (const file of files) {
        const cache = app2.metadataCache.getFileCache(file);
        const lane = config.lane ? fmValues(cache, config.lane)[0] || null : null;
        const laneGroup = config.groupby ? fmValues(cache, config.groupby)[0] || null : null;
        const fileDesktop = desktopRef(fmValues(cache, "kbdesktop")[0]);
        const lines = (await app2.vault.cachedRead(file)).split(/\r?\n/);
        const fileCards = [];
        const stack = [];
        let group = null;
        const owner = (text) => {
          const indent = indentWidth(text);
          for (let s = stack.length - 1; s >= 0; s--) {
            if (stack[s].indent < indent) return stack[s].card;
          }
          return null;
        };
        for (let i = 0; i < lines.length; i++) {
          const text = lines[i];
          if (/^-{3,}\s*$/.test(text)) {
            group = null;
            continue;
          }
          const tm = text.match(TASK_RE2);
          if (tm) {
            const indent = indentWidth(text);
            while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
            let parent = stack.length ? stack[stack.length - 1].card : null;
            const isGroup = tm[2] === "!";
            if (!parent && !isGroup && group) parent = group;
            const card = {
              file,
              line: i,
              body: tm[4],
              state: tm[2],
              parent,
              lane,
              group: laneGroup,
              isGroup,
              children: [],
              history: [],
              eiHistory: [],
              tags: [],
              who: [],
              color: null,
              icon: null
            };
            if (parent) parent.children.push(card);
            stack.push({ indent, card });
            fileCards.push(card);
            if (isGroup) group = card;
            continue;
          }
          const hm = text.match(HIST_RE2);
          if (hm) {
            {
              const o = owner(text);
              o?.history.push({ stamp: stampDigits(hm[1]), from: hm[2], to: hm[3], seq: o.history.length });
            }
            continue;
          }
          const em = text.match(EI_HIST_RE);
          if (em) {
            owner(text)?.eiHistory.push({ stamp: stampDigits(em[1]), label: em[2] });
            continue;
          }
          const cm = text.match(COLOR_RE);
          if (cm) {
            const card = owner(text);
            if (card) card.color = cm[1];
            continue;
          }
          const im = text.match(ICON_RE);
          if (im) {
            const card = owner(text);
            if (card) card.icon = im[1];
            continue;
          }
          const mm = text.match(METRIC_RE);
          if (mm) {
            const card = owner(text);
            if (card) card.metric = mm[1].toLowerCase();
            continue;
          }
          const rm = text.match(RANK_RE);
          if (rm) {
            const card = owner(text);
            if (card) card.rank = Number(rm[1]);
            continue;
          }
          const dm = text.match(DESKTOP_RE);
          if (dm) {
            const card = owner(text);
            if (card) card.desktop = desktopRef(dm[1]);
            continue;
          }
          const estm = text.match(EST_RE);
          if (estm) {
            const card = owner(text);
            if (card) card.est = Number(estm[1]);
            continue;
          }
          const tpm = text.match(TAP_RE);
          if (tpm) {
            const card = owner(text);
            if (card) card.tap = true;
            continue;
          }
          const gm = text.match(TAGLINE_RE);
          if (gm) {
            const card = owner(text);
            if (card) {
              for (const tok of gm[1].split(/\s+/)) {
                if (tok.startsWith("#")) card.tags.push(tok);
                else card.who.push(tok.slice(2, -2));
              }
            }
            continue;
          }
          if (!/^\s/.test(text)) stack.length = 0;
        }
        for (const card of fileCards) {
          if (card.desktop == null && fileDesktop) card.desktop = fileDesktop;
          let col;
          if (card.state === " " || card.state === "!") {
            const key = card.tags.find((t) => t.startsWith("#kb/"))?.match(KB_TAG_RE)?.[1] || card.body.match(KB_TAG_RE)?.[1];
            col = byTag.get(key) || open[0];
          } else {
            col = byState.get(card.state);
            if (col && cutoff && terminalStamp(card, col) < cutoff) col = null;
          }
          if (col) cards.get(col.key).push(card);
        }
      }
      for (const [key, list] of cards) sortColumn(list, config.colsort?.[key]);
      return cards;
    }
    function sortByRank(list) {
      const r = (c) => c.rank == null ? Infinity : c.rank;
      return list.sort((a, b) => r(a) - r(b));
    }
    var SORT_PRESETS = [
      { id: "manual", label: "Manual (rank)", glyph: "\u2261" },
      { id: "latest", label: "Latest first", glyph: "\u2193" },
      { id: "oldest", label: "Oldest first", glyph: "\u2191" },
      { id: "az", label: "A\u2013Z", glyph: "A" }
    ];
    function cardStamp(card) {
      let best = "";
      for (const h of card.history) if (h.stamp > best) best = h.stamp;
      return best || (card.file.basename.match(/^(\d{8})-?(\d{4})/)?.slice(1).join("") ?? "");
    }
    function sortColumn(list, preset) {
      const byLine = (a, b) => a.file.path.localeCompare(b.file.path) || a.line - b.line;
      if (preset === "latest") return list.sort((a, b) => cardStamp(b).localeCompare(cardStamp(a)) || byLine(a, b));
      if (preset === "oldest") return list.sort((a, b) => cardStamp(a).localeCompare(cardStamp(b)) || byLine(a, b));
      if (preset === "az") return list.sort((a, b) => cleanText(a.body).localeCompare(cleanText(b.body)) || byLine(a, b));
      return sortByRank(list);
    }
    function setMetaLine(lines, line, re, text) {
      const base = indentWidth(lines[line]);
      for (let i = line + 1; i < lines.length && lines[i].trim() && indentWidth(lines[i]) > base; i++) {
        if (re.test(lines[i])) {
          lines.splice(i, 1);
          break;
        }
      }
      if (text == null) return;
      const indent = lines[line].match(/^\s*/)[0] + "  ";
      lines.splice((tagLineAt(lines, line) ?? line) + 1, 0, indent + text);
    }
    var setRankLine = (lines, line, rank) => setMetaLine(lines, line, RANK_RE, `%% kbrank ${rank} %%`);
    var setEstLine = (lines, line, min) => setMetaLine(lines, line, EST_RE, min == null ? null : `%% kbest ${min} %%`);
    var setDesktopLine = (lines, line, n) => setMetaLine(lines, line, DESKTOP_RE, n == null ? null : `%% kbdesktop ${n} %%`);
    function tagLineAt(lines, line) {
      const next = lines[line + 1];
      if (next == null || !TAGLINE_RE.test(next)) return null;
      if (indentWidth(next) <= indentWidth(lines[line])) return null;
      return line + 1;
    }
    function editTags(lines, line, fn) {
      const at = tagLineAt(lines, line);
      const tokens = at != null ? lines[at].trim().split(/\s+/) : [];
      const out = fn(tokens).filter(Boolean);
      const indent = lines[line].match(/^\s*/)[0] + "  ";
      if (at != null && !out.length) lines.splice(at, 1);
      else if (at != null) lines[at] = indent + out.join(" ");
      else if (out.length) lines.splice(line + 1, 0, indent + out.join(" "));
    }
    function taskColumn(lines, line, task, config) {
      const stateCol = config.columns.find((col) => col.state === task[2]);
      if (stateCol) return stateCol;
      const at = tagLineAt(lines, line);
      const tagged = `${task[4]} ${at == null ? "" : lines[at]}`.match(KB_TAG_RE)?.[1];
      return config.columns.find((col) => !col.state && col.key === tagged) || config.columns.find((col) => !col.state);
    }
    function normalizeTaskMeta(lines, line) {
      const base = indentWidth(lines[line]);
      let i = line + 1;
      while (i < lines.length) {
        const t = lines[i];
        if (!t.trim() || indentWidth(t) <= base) break;
        i++;
      }
      const end = i;
      const prefix = [], notes = [], logs = [];
      let restAt = end;
      for (i = line + 1; i < end; i++) {
        const t = lines[i];
        if (TAGLINE_RE.test(t) || COLOR_RE.test(t) || ICON_RE.test(t) || METRIC_RE.test(t) || TAP_RE.test(t) || RANK_RE.test(t) || DESKTOP_RE.test(t) || EST_RE.test(t)) prefix.push(t);
        else if (HIST_RE2.test(t) || EI_HIST_RE.test(t)) logs.push(t);
        else if (TASK_RE2.test(t)) {
          restAt = i;
          break;
        } else notes.push(t);
      }
      lines.splice(line + 1, end - (line + 1), ...prefix, ...notes, ...logs, ...lines.slice(restAt, end));
      return line + 1 + prefix.length + notes.length;
    }
    function commentInsertAt(lines, line) {
      return normalizeTaskMeta(lines, line);
    }
    function pct(values, q) {
      const s = values.slice().sort((a, b) => a - b);
      return s[Math.floor((s.length - 1) * q)];
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
    function addTitleCopy(titleEl, text) {
      const btn = titleEl.createSpan({ cls: "bdb-title-copy", attr: { "aria-label": "Copy title" } });
      setIcon(btn, "copy");
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        e.preventDefault();
        await navigator.clipboard.writeText(text);
        setIcon(btn, "check");
        btn.classList.add("bdb-title-copied");
        window.setTimeout(() => {
          setIcon(btn, "copy");
          btn.classList.remove("bdb-title-copied");
        }, 1200);
      });
      return btn;
    }
    function stampNow(d = /* @__PURE__ */ new Date()) {
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
    }
    function stampDigits(s) {
      return String(s).replace(/\D/g, "");
    }
    function stampWrite(s) {
      const d = stampDigits(s);
      return `${d.slice(0, 8)}-${d.slice(8, 12)}`;
    }
    function stampToDate(s) {
      s = stampDigits(s);
      return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12));
    }
    function terminalStamp(card, col) {
      const line = card.body.match(STAMP_RE)?.[0]?.trim();
      return line && stampDigits(line) || card.history.reduce((latest, ev) => ev.to === col.name && ev.stamp > latest ? ev.stamp : latest, "");
    }
    function hhmmMs(ms) {
      const d = new Date(ms);
      return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    }
    function fmtDur(ms) {
      const m = Math.floor(ms / 6e4);
      if (m < 60) return `${m}m`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h`;
      return `${Math.floor(h / 24)}d${h % 24 ? `${h % 24}h` : ""}`;
    }
    function fmtDurCompact(ms) {
      const m = Math.floor(ms / 6e4);
      if (m < 60) return `${m}m`;
      const h = Math.floor(m / 60);
      return `${h}h${m % 60 ? `${m % 60}m` : ""}`;
    }
    async function sweepColumn(app2, config, fromCol, toCol, colCards) {
      const ordered = colCards.slice().sort((a, b) => a.file.path === b.file.path ? b.line - a.line : a.file.path.localeCompare(b.file.path));
      let moved = 0;
      let blocked = 0;
      for (const card of ordered) {
        if (toCol.state && openDescendants(card) > 0) {
          blocked++;
          continue;
        }
        if (await moveCard2(app2, card.file, card.line, toCol, config, { fromCol })) moved++;
      }
      new Notice2(`kanban: swept ${moved} to ${toCol.name}${blocked ? `, ${blocked} blocked` : ""}`);
      return { moved, blocked };
    }
    async function moveCard2(app2, file, line, targetCol, config, { fromCol, at } = {}) {
      const content = await app2.vault.read(file);
      const lines = content.split(/\r?\n/);
      const m = lines[line]?.match(TASK_RE2);
      if (!m) return false;
      fromCol ||= taskColumn(lines, line, m, config);
      const [, pre, , close] = m;
      const body = m[4].replace(KB_TAG_GLOBAL_RE, "").replace(STAMP_RE, "").replace(/\s{2,}/g, " ").trim();
      const firstOpen = config.columns.find((c) => !c.state);
      if (targetCol.state) {
        lines[line] = `${pre}${targetCol.state}${close}${body}`;
      } else {
        lines[line] = `${pre}${m[2] === "!" ? "!" : " "}${close}${body}`;
      }
      const tag = !targetCol.state && targetCol !== firstOpen ? `#kb/${targetCol.key}` : null;
      editTags(lines, line, (tokens) => {
        const rest = tokens.filter((t) => !t.startsWith("#kb/"));
        return tag ? [tag, ...rest] : rest;
      });
      const indent = lines[line].match(/^\s*/)[0];
      lines.splice(normalizeTaskMeta(lines, line), 0, `${indent}  %% kb ${stampWrite(stampNow(at || /* @__PURE__ */ new Date()))} ${fromCol?.name || "?"} > ${targetCol.name} %%`);
      await app2.vault.modify(file, lines.join("\n"));
      return true;
    }
    async function logTapSpan(app2, file, line) {
      const content = await app2.vault.read(file);
      const lines = content.split(/\r?\n/);
      if (!TASK_RE2.test(lines[line] || "")) return false;
      const base = indentWidth(lines[line]);
      let maxMs = 0;
      for (let i = line + 1; i < lines.length; i++) {
        if (lines[i].trim() && indentWidth(lines[i]) <= base) break;
        const h = lines[i].match(HIST_RE2);
        if (h) maxMs = Math.max(maxMs, stampToDate(h[1]).getTime());
      }
      const startMs = Math.max(Date.now(), maxMs + 6e4);
      const start = stampWrite(stampNow(new Date(startMs)));
      const end = stampWrite(stampNow(new Date(startMs + 6e4)));
      const indent = lines[line].match(/^\s*/)[0];
      lines.splice(
        normalizeTaskMeta(lines, line),
        0,
        `${indent}  %% kb ${end} Doing > Idle %%`,
        `${indent}  %% kb ${start} Idle > Doing %%`
      );
      await app2.vault.modify(file, lines.join("\n"));
      return true;
    }
    function fileHasTask(app2, path) {
      const f = path && app2.vault.getAbstractFileByPath(path);
      const li = f && app2.metadataCache.getFileCache(f)?.listItems;
      return !!li && li.some((it) => it.task != null);
    }
    function resolveKanbanConfig(plugin, src, sourcePath) {
      const config = parseKanbanConfig2(src);
      const defaults = plugin.settings?.kanban || {};
      if (!config.columns.length) {
        const d = parseKanbanConfig2(`columns: ${defaults.columns || "Backlog~, Todo, Doing!, Parked~, Done=x, Cancelled=-"}`);
        config.columns = d.columns;
        config.colors = { ...d.colors, ...config.colors };
      }
      if (!Object.keys(config.colors).length && defaults.colors) {
        config.colors = parseColors(defaults.colors);
      }
      if (!config.paths.length && sourcePath) {
        if (fileHasTask(plugin.app, sourcePath)) config.paths = [sourcePath];
      } else if (!config.paths.length && defaults.paths) {
        config.paths = defaults.paths.split(",").map((s) => s.trim()).filter(Boolean);
      }
      if (config.maxage == null) config.maxage = defaults.maxage != null ? defaults.maxage : 7;
      if (config.layout == null) config.layout = defaults.layout === "horizontal" ? "horizontal" : "vertical";
      if (config.autoFold == null) config.autoFold = defaults.autoFold === true || defaults.fold === true;
      if (!config.sweeps.length && defaults.sweep) {
        config.sweeps = parseSweeps(defaults.sweep);
      }
      if (config.lanesort == null && defaults.lanesort) config.lanesort = defaults.lanesort;
      config.colsort = defaults.colsort || {};
      return config;
    }
    async function persistLaneState(plugin, ctx, el, selectedNames, openNames, state) {
      const info = ctx.getSectionInfo?.(el);
      if (!info) return;
      const file = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (!file) return;
      const lines = (await plugin.app.vault.read(file)).split("\n");
      const bodyStart = info.lineStart + 1;
      const body = lines.slice(bodyStart, info.lineEnd);
      const out = [];
      for (let i = 0; i < body.length; i++) {
        if (/^\s*(lanes|open)\s*:/.test(body[i])) {
          while (i + 1 < body.length && /^\s+\S/.test(body[i + 1])) i++;
          continue;
        }
        out.push(body[i]);
      }
      if (selectedNames.length) out.push(`lanes: ${selectedNames.join(", ")}`);
      if (openNames.length) out.push(`open: ${openNames.join(", ")}`);
      state.selfWriteAt = Date.now();
      lines.splice(bodyStart, info.lineEnd - bodyStart, ...out);
      await plugin.app.vault.modify(file, lines.join("\n"));
    }
    async function renderKanbanBlock2(plugin, src, el, ctx) {
      el.empty();
      const scopeFilter = (config2) => {
        if (config2.includeInactive) return config2;
        const previous = config2.cacheFilter;
        config2.cacheFilter = (cache, file) => (!previous || previous(cache, file)) && plugin.api.scopeFrontmatterActive(cache?.frontmatter);
        return config2;
      };
      const config = scopeFilter(resolveKanbanConfig(plugin, src, ctx.sourcePath));
      const states = config.columns.filter((c) => c.state).map((c) => c.state);
      if (new Set(states).size !== states.length) {
        el.createDiv({ text: "kanban: two columns share the same state char" });
        return;
      }
      const board = el.createDiv({ cls: `bdb-kanban bdb-kanban-layout-${config.layout}` });
      const state = { dragging: false };
      state.selectedLanes = config.lanes.length ? config.lanes.length === 1 && config.lanes[0].toLowerCase() === LANE_NONE ? /* @__PURE__ */ new Set() : new Set(config.lanes.map((n) => n.toLowerCase())) : null;
      state.openLanes = new Set(config.open.map((n) => n.toLowerCase()));
      let persistTimer = null;
      state.persist = (selectedNames, openNames) => {
        window.clearTimeout(persistTimer);
        persistTimer = window.setTimeout(() => persistLaneState(plugin, ctx, el, selectedNames, openNames, state), 400);
      };
      const redraw = () => {
        if (!state.dragging) drawBoard(plugin, board, scopeFilter(resolveKanbanConfig(plugin, src, ctx.sourcePath)), state);
      };
      const tick = () => {
        if (!state.dragging) (state.timeUpdaters || []).forEach((fn) => fn());
      };
      const child = new MarkdownRenderChild(el);
      ctx.addChild(child);
      child.registerInterval(window.setInterval(tick, 6e4));
      let pending = null;
      const scheduleRedraw = (file) => {
        if (state.selfWriteAt && Date.now() - state.selfWriteAt < 1500) return;
        if (file && file.extension !== "md") return;
        if (file && config.paths.length && !config.paths.some((p) => file.path.startsWith(p))) return;
        window.clearTimeout(pending);
        pending = window.setTimeout(redraw, 500);
      };
      child.registerEvent(plugin.app.vault.on("modify", scheduleRedraw));
      child.registerDomEvent(window, "bdb-kanban-collapse-all", () => state.collapse?.());
      await drawBoard(plugin, board, config, state);
    }
    function emptyColMap(config) {
      return new Map(config.columns.map((c) => [c.key, []]));
    }
    function laneMetrics(config, cards) {
      const openKeys = config.columns.filter((c) => !c.state).map((c) => c.key);
      const termKeys = config.columns.filter((c) => c.state).map((c) => c.key);
      const actKeys = config.columns.filter((c, i) => !c.state && !c.paused && i !== 0).map((c) => c.key);
      return {
        n: [...cards.values()].flat().length,
        done: termKeys.reduce((s, k) => s + cards.get(k).length, 0),
        open: openKeys.reduce((s, k) => s + cards.get(k).length, 0),
        actionable: actKeys.reduce((s, k) => s + cards.get(k).length, 0)
      };
    }
    function aggregateCards(config, lanes) {
      const cards = emptyColMap(config);
      for (const lane of lanes) {
        for (const [key, list] of lane.cards) cards.get(key).push(...list);
      }
      return cards;
    }
    function compareNames(a, b) {
      const noneLast = (a === "(none)") - (b === "(none)");
      return noneLast || String(a).localeCompare(String(b));
    }
    function laneSplit(config, cards) {
      if (!config.lane && !config.groupby) return [{ name: null, group: null, cards, ...laneMetrics(config, cards) }];
      const lanes = /* @__PURE__ */ new Map();
      for (const [key, list] of cards) {
        for (const card of list) {
          const group = config.groupby ? card.group || "(none)" : null;
          const name = config.lane ? card.lane || "(none)" : null;
          const id = `${group ?? ""}\0${name ?? ""}`;
          if (!lanes.has(id)) lanes.set(id, { group, name, cards: emptyColMap(config) });
          lanes.get(id).cards.get(key).push(card);
        }
      }
      const openKeys = config.columns.filter((c) => !c.state).map((c) => c.key);
      return [...lanes.values()].map((l) => ({ ...l, ...laneMetrics(config, l.cards) })).filter((l) => !config.hidedonelanes || openKeys.some((k) => l.cards.get(k).length)).sort((a, b) => {
        const [skey, dir = "desc"] = (config.lanesort || "total").split("-");
        const sign = dir === "asc" ? 1 : -1;
        const byGroup = compareNames(a.group || "", b.group || "");
        if (byGroup) return byGroup;
        if (skey === "name") return sign * compareNames(a.name, b.name);
        const byKey = sign * ((skey === "open" ? a.open : a.n) - (skey === "open" ? b.open : b.n));
        return byKey || compareNames(a.name, b.name);
      });
    }
    function laneGroupSplit(config, lanes) {
      if (!config.groupby) {
        const cards = aggregateCards(config, lanes);
        return [{ name: null, lanes, cards, ...laneMetrics(config, cards) }];
      }
      const groups = /* @__PURE__ */ new Map();
      for (const lane of lanes) {
        const name = lane.group || "(none)";
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(lane);
      }
      return [...groups.entries()].map(([name, groupLanes]) => {
        const cards = aggregateCards(config, groupLanes);
        return { name, lanes: groupLanes, cards, ...laneMetrics(config, cards) };
      }).sort((a, b) => b.open - a.open || compareNames(a.name, b.name));
    }
    async function drawBoard(plugin, board, config, state = { dragging: false }) {
      const cards = await scanKanbanTasks(plugin.app, config);
      board.empty();
      const cardEls = /* @__PURE__ */ new Map();
      state.timeUpdaters = [];
      state.folded ??= /* @__PURE__ */ new Set();
      state.groupFold ??= /* @__PURE__ */ new Set();
      state.colFold ??= /* @__PURE__ */ new Map();
      const lanes = laneSplit(config, cards);
      const bar = board.createDiv({ cls: "bdb-kanban-toolbar" });
      const collapseBtn = bar.createEl("button", { cls: "bdb-kanban-tool", attr: { "aria-label": "Collapse empty/terminal columns (Shift: all boards)" } });
      setIcon(collapseBtn, "fold-vertical");
      const collapse = async () => {
        for (const group of laneGroupSplit(config, lanes)) {
          if (config.groupby && group.open === 0) state.groupFold.add(group.name);
        }
        for (const lane of lanes) {
          if (lane.name != null && lane.open === 0) state.folded.add(lane.name);
          for (const col of config.columns) {
            if (!lane.cards.get(col.key).length || col.state) state.colFold.set(`${lane.group ?? ""}::${lane.name ?? ""}::${col.key}`, true);
          }
        }
        await drawBoard(plugin, board, config, state);
      };
      state.collapse = collapse;
      collapseBtn.addEventListener("click", (e) => {
        if (e.shiftKey) window.dispatchEvent(new CustomEvent("bdb-kanban-collapse-all"));
        else collapse();
      });
      for (const route of config.sweeps) {
        const fromCol = config.columns.find((c) => c.key === route.from);
        const toCol = config.columns.find((c) => c.key === route.to);
        if (!fromCol || !toCol) continue;
        const btn = bar.createEl("button", {
          cls: "bdb-kanban-tool bdb-kanban-sweep",
          text: `${fromCol.name} > ${toCol.name}`,
          attr: { "aria-label": `Sweep all ${fromCol.name} cards to ${toCol.name}` }
        });
        btn.addEventListener("click", async () => {
          await sweepColumn(plugin.app, config, fromCol, toCol, cards.get(fromCol.key) || []);
          await drawBoard(plugin, board, config, state);
        });
      }
      const norm = (n) => String(n ?? "").toLowerCase();
      state.openLanes ??= /* @__PURE__ */ new Set();
      const visibleLanes = state.selectedLanes ? lanes.filter((l) => state.selectedLanes.has(norm(l.name))) : lanes;
      const laneGroups = laneGroupSplit(config, visibleLanes);
      const selNames = () => !state.selectedLanes ? [] : state.selectedLanes.size === 0 ? [LANE_NONE] : state.selectedLanes.size === lanes.length ? [] : lanes.filter((l) => state.selectedLanes.has(norm(l.name))).map((l) => l.name);
      const openNames = () => lanes.filter((l) => state.openLanes.has(norm(l.name))).map((l) => l.name);
      const persistNow = () => state.persist?.(selNames(), openNames());
      const applyOpen = (name, isOpen) => {
        isOpen ? state.openLanes.add(norm(name)) : state.openLanes.delete(norm(name));
        persistNow();
        drawBoard(plugin, board, config, state);
      };
      const applyGroupOpen = (name, isOpen) => {
        isOpen ? state.groupFold.delete(name) : state.groupFold.add(name);
        drawBoard(plugin, board, config, state);
      };
      if (config.lane && lanes.length > 1) {
        const picker = board.createDiv({ cls: "bdb-kanban-picker" });
        const head = picker.createDiv({ cls: "bdb-kanban-picker-head" });
        const selN = state.selectedLanes ? state.selectedLanes.size : lanes.length;
        head.createSpan({ cls: "bdb-kanban-picker-title", text: `Lanes ${selN}/${lanes.length}` });
      }
      const body = board.createDiv({ cls: "bdb-kanban-body" });
      body.classList.toggle("bdb-kanban-lanelist", !!config.lane || !!config.groupby);
      const renderAggregateRow = (parent, item, opts = {}) => {
        const on = opts.group ? !state.groupFold.has(item.name) : state.openLanes.has(norm(item.name));
        const stalled = item.open > 0 && item.actionable === 0;
        const row = parent.createDiv({ cls: opts.cls + (on ? " is-open" : "") + (stalled ? " is-stalled" : "") });
        const caret = row.createSpan({ cls: "bdb-kanban-lanerow-caret" });
        setIcon(caret, on ? "chevron-down" : "chevron-right");
        row.createSpan({ cls: "bdb-kanban-lanerow-name", text: item.name });
        const meta = row.createSpan({ cls: "bdb-kanban-lanerow-meta" });
        if (stalled) meta.createSpan({ cls: "bdb-kanban-picker-warn", text: "stalled" });
        else meta.createSpan({ cls: "bdb-kanban-lanerow-ok", text: `${item.actionable} next` });
        meta.createSpan({ cls: "bdb-kanban-lanerow-tot", text: `${item.open} open${item.done ? ` \xB7 ${item.done} done` : ""}` });
        const dist = row.createDiv({ cls: "bdb-kanban-lanerow-dist" });
        dist.style.setProperty("--bdb-kanban-lane-cols", String(config.columns.length));
        for (const [index, col] of config.columns.entries()) {
          const n = item.cards.get(col.key).length;
          const chip = dist.createSpan({ cls: "bdb-kanban-lanerow-chip" + (n ? "" : " is-zero") });
          chip.createSpan({ cls: "bdb-kanban-lanerow-dot" }).style.background = columnColor(config, col, index);
          chip.createSpan({ text: `${col.name} ${n}` });
        }
        row.addEventListener("click", () => opts.group ? applyGroupOpen(item.name, !on) : applyOpen(item.name, !on));
      };
      const renderLaneRow = (parent, lane) => {
        const on = state.openLanes.has(norm(lane.name));
        const stalled = lane.open > 0 && lane.actionable === 0;
        const row = parent.createDiv({ cls: "bdb-kanban-lanerow" + (on ? " is-open" : "") + (stalled ? " is-stalled" : "") });
        const caret = row.createSpan({ cls: "bdb-kanban-lanerow-caret" });
        setIcon(caret, on ? "chevron-down" : "chevron-right");
        row.createSpan({ cls: "bdb-kanban-lanerow-name", text: lane.name });
        const meta = row.createSpan({ cls: "bdb-kanban-lanerow-meta" });
        if (stalled) meta.createSpan({ cls: "bdb-kanban-picker-warn", text: "stalled" });
        else meta.createSpan({ cls: "bdb-kanban-lanerow-ok", text: `${lane.actionable} next` });
        meta.createSpan({ cls: "bdb-kanban-lanerow-tot", text: `${lane.open} open${lane.done ? ` \xB7 ${lane.done} done` : ""}` });
        const dist = row.createDiv({ cls: "bdb-kanban-lanerow-dist" });
        dist.style.setProperty("--bdb-kanban-lane-cols", String(config.columns.length));
        for (const [index, col] of config.columns.entries()) {
          const n = lane.cards.get(col.key).length;
          const chip = dist.createSpan({ cls: "bdb-kanban-lanerow-chip" + (n ? "" : " is-zero") });
          chip.createSpan({ cls: "bdb-kanban-lanerow-dot" }).style.background = columnColor(config, col, index);
          chip.createSpan({ text: `${col.name} ${n}` });
        }
        row.addEventListener("click", () => applyOpen(lane.name, !on));
      };
      const tryDrop = async (path, lineStr, fromKey, col, foldKey) => {
        if (!path || fromKey === col.key) return false;
        const file = plugin.app.vault.getAbstractFileByPath(path);
        if (!file) return false;
        state.dragging = false;
        if (col.state) {
          const dragged = [...cards.values()].flat().find((c) => c.file.path === path && c.line === Number(lineStr));
          const blockers = dragged ? openDescendants(dragged) : 0;
          if (blockers) {
            new Notice2(`kanban: ${blockers} open sub-task${blockers > 1 ? "s" : ""} \u2014 close them first`);
            return false;
          }
        }
        await moveCard2(plugin.app, file, Number(lineStr), col, config, {
          fromCol: config.columns.find((c) => c.key === fromKey)
        });
        state.selfWriteAt = Date.now();
        state.colFold.delete(foldKey);
        return true;
      };
      for (const group of laneGroups) {
        if (config.groupby) renderAggregateRow(body, group, { cls: "bdb-kanban-lanerow bdb-kanban-grouprow", group: true });
        if (config.groupby && state.groupFold.has(group.name)) continue;
        for (const lane of group.lanes) {
          if (config.lane) renderLaneRow(body, lane);
          if (config.lane && !state.openLanes.has(norm(lane.name))) continue;
          const host = lane.name != null || config.groupby ? body.createDiv({ cls: "bdb-kanban-lane-open bdb-kanban-lane-row" }) : body;
          for (const [index, col] of config.columns.entries()) {
            if (config.only.length && !config.only.includes(col.key)) continue;
            const colCards = lane.cards.get(col.key);
            const colEl = host.createDiv({ cls: "bdb-kanban-col" });
            if (col.live) colEl.classList.add("bdb-kanban-col-live");
            colEl.style.setProperty("--kb-col-color", columnColor(config, col, index));
            const foldKey = `${lane.group ?? ""}::${lane.name ?? ""}::${col.key}`;
            const folded = state.colFold.get(foldKey) ?? (config.autoFold && !colCards.length);
            if (folded) colEl.classList.add("bdb-kanban-col-folded");
            const titleEl = colEl.createDiv({ cls: "bdb-kanban-col-title", text: `${col.name} (${colCards.length})` });
            titleEl.addEventListener("click", async (e) => {
              if (e.target.closest("button")) return;
              state.colFold.set(foldKey, !folded);
              await drawBoard(plugin, board, config, state);
            });
            if (!folded) {
              const current = SORT_PRESETS.find((p) => p.id === config.colsort[col.key]) || SORT_PRESETS[0];
              const sortBtn = titleEl.createEl("button", {
                cls: "bdb-kanban-sort",
                text: current.glyph,
                attr: { "aria-label": `Sort: ${current.label}` }
              });
              sortBtn.addEventListener("click", (e) => {
                const menu = new Menu();
                for (const p of SORT_PRESETS) menu.addItem((item) => item.setTitle(p.label).setChecked(p === current).onClick(async () => {
                  const colsort = { ...config.colsort, [col.key]: p.id };
                  plugin.settings.kanban.colsort = colsort;
                  config.colsort = colsort;
                  await plugin.saveSettings();
                  await drawBoard(plugin, board, config, state);
                }));
                menu.showAtMouseEvent(e);
              });
            }
            if (!folded) for (const route of config.sweeps.filter((s) => s.from === col.key)) {
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
              if (await tryDrop(path, lineStr, fromKey, col, foldKey)) await drawBoard(plugin, board, config, state);
            });
            if (Platform.isMobile) colEl.addEventListener("click", async (e) => {
              if (!state.picked || e.target.closest(".bdb-kanban-card")) return;
              const p = state.picked;
              const moved = await tryDrop(p.path, p.line, p.fromKey, col, foldKey);
              if (moved) state.picked = null;
              if (moved) await drawBoard(plugin, board, config, state);
            });
            const parents = folded ? [] : colCards.filter((c) => c.children.length);
            const leaves = folded ? [] : colCards.filter((c) => !c.children.length);
            for (const card of [...parents, ...leaves]) {
              if (parents.length && leaves.length && card === leaves[0]) list.createDiv({ cls: "bdb-kanban-sep" });
              const cardEl = list.createDiv({ cls: "bdb-kanban-card", attr: { draggable: "true" } });
              const kbcolor = card.color || app.metadataCache.getFileCache(card.file)?.frontmatter?.kbcolor;
              if (kbcolor) {
                cardEl.classList.add("bdb-kanban-card-tinted");
                cardEl.style.setProperty("--kb-card-color", kbcolor);
              }
              if (card.children.length) cardEl.classList.add("bdb-kanban-card-parent");
              if (col.live) cardEl.classList.add("bdb-kanban-card-live");
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
              const copyBtn = cardEl.createSpan({ cls: "bdb-kanban-card-copy", attr: { "aria-label": "Copy task" } });
              setIcon(copyBtn, "copy");
              copyBtn.addEventListener("click", async (e) => {
                e.stopPropagation();
                await navigator.clipboard.writeText(cleanText(card.body));
                setIcon(copyBtn, "check");
                copyBtn.classList.add("bdb-kanban-card-copied");
                window.setTimeout(() => {
                  setIcon(copyBtn, "copy");
                  copyBtn.classList.remove("bdb-kanban-card-copied");
                }, 1200);
              });
              const total = countDescendants(card);
              if (total) {
                const closed = total - openDescendants(card);
                const host2 = textEl.querySelector("p") || textEl;
                const pill = host2.createSpan({ cls: "bdb-kanban-card-rollup", text: `${closed}/${total}` });
                if (closed === total) pill.classList.add("bdb-kanban-card-rollup-full");
              }
              if (card.who.length) {
                const whoEl = cardEl.createDiv({ cls: "bdb-ei-who" });
                for (const name of card.who) whoEl.createSpan({ cls: "bdb-ei-who-pill", text: name });
              }
              if (config.mode === "habits") {
                const { habitStats, fmtHours } = require_habits();
                const fm = app.metadataCache.getFileCache(card.file)?.frontmatter || {};
                const metric = fm.metric === "count" ? "count" : "sum";
                const st = habitStats(card.history, metric, /* @__PURE__ */ new Date());
                const foot = cardEl.createDiv({ cls: "bdb-kanban-card-habit" });
                if (!st) {
                  foot.createSpan({ text: "no logs yet" });
                } else {
                  const f = (v) => metric === "count" ? (Number.isInteger(v) ? `${v}` : v.toFixed(1)) + "x" : fmtHours(v);
                  const arrow = st.trend > 0.05 ? "\u2191" : st.trend < -0.05 ? "\u2193" : "\u2192";
                  foot.setAttribute(
                    "title",
                    `min ${f(st.min)} \xB7 mean ${f(st.mean)} \xB7 max ${f(st.max)} \xB7 ${st.days}d logged`
                  );
                  foot.createSpan({ cls: "bdb-kanban-habit-trend", text: arrow });
                  if (st.open) foot.createSpan({ cls: "bdb-kanban-habit-live", text: "\u25CF live" });
                  foot.createSpan({ cls: "bdb-kanban-habit-stat", text: `today ${f(st.today)}` });
                  foot.createSpan({ cls: "bdb-kanban-habit-sep", text: "\xB7" });
                  foot.createSpan({ cls: "bdb-kanban-habit-stat", text: `7d ${f(st.avg7)}` });
                  foot.createSpan({ cls: "bdb-kanban-habit-sep", text: "\xB7" });
                  foot.createSpan({ cls: "bdb-kanban-habit-stat", text: `${st.streak}d streak` });
                }
              } else if (card.history.length) {
                const es = chrono(card.history);
                const colorOf = new Map(config.columns.map((c, i) => [c.name, columnColor(config, c, i)]));
                const idle = new Set(config.columns.filter((c) => c.paused).map((c) => c.name));
                const terminal = !!col.state;
                const birthM = card.file.name.match(/^(\d{8})-(\d{4})/);
                const birth = birthM ? stampToDate(birthM[1] + birthM[2]) : null;
                const visits = [];
                if (birth) {
                  const start = birth.getTime();
                  const end = stampToDate(es[0].stamp).getTime();
                  visits.push({ name: es[0].from, start, end, dur: Math.max(end - start, 0) });
                }
                for (let i = 0; i < es.length; i++) {
                  const isLast = i === es.length - 1;
                  if (isLast && terminal) break;
                  const start = stampToDate(es[i].stamp).getTime();
                  const end = (isLast ? /* @__PURE__ */ new Date() : stampToDate(es[i + 1].stamp)).getTime();
                  visits.push({ name: es[i].to, start, end, dur: end - start });
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
                const liveVisit = !terminal && inSync ? visits[visits.length - 1] : null;
                const bars = flow.createDiv({ cls: "bdb-kanban-card-bars" });
                const bar2 = bars.createDiv({ cls: "bdb-kanban-card-bar" });
                for (const v of visits) {
                  const span = bar2.createSpan();
                  span.style.flexGrow = String(Math.max(v.dur, 1));
                  span.style.background = colorOf.get(v.name) || "var(--background-modifier-border)";
                  span.setAttribute("title", `${v.name}: ${hhmmMs(v.start)}-${hhmmMs(v.end)} \xB7 ${fmtDurCompact(v.dur)}`);
                  if (v === liveVisit) span.classList.add("bdb-kanban-live-span");
                }
                const nowEl = flow.createSpan({
                  cls: "bdb-kanban-card-now",
                  text: terminal ? `${fmtDur(active)} spent \xB7 ${fmtDur(total2)} total` : since == null ? col.name : `${col.name} ${fmtDur(since)} \xB7 ${fmtDur(active)} spent`
                });
                const ages = !terminal && col.paused && col !== config.columns[0];
                const ageT = (col.age || 1) * 864e5;
                const applyAge = (ms) => {
                  if (!ages || ms == null) return;
                  cardEl.classList.toggle("bdb-kanban-age-red", ms > 3 * ageT);
                  cardEl.classList.toggle("bdb-kanban-age-amber", ms > ageT && ms <= 3 * ageT);
                };
                applyAge(since);
                if (liveVisit) {
                  const startMs = stampToDate(last.stamp).getTime();
                  const activeBase = active - (idle.has(col.name) ? 0 : liveVisit.dur);
                  state.timeUpdaters.push(() => {
                    const ms = Date.now() - startMs;
                    const act = activeBase + (idle.has(col.name) ? 0 : ms);
                    nowEl.textContent = `${col.name} ${fmtDur(ms)} \xB7 ${fmtDur(act)} spent`;
                    for (const sp of cardEl.querySelectorAll(".bdb-kanban-live-span")) {
                      sp.style.flexGrow = String(Math.max(ms, 1));
                      sp.setAttribute("title", `${col.name}: ${hhmmMs(startMs)}-${hhmmMs(Date.now())} \xB7 ${fmtDurCompact(ms)}`);
                    }
                    applyAge(ms);
                  });
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
              if (Platform.isMobile) cardEl.addEventListener("click", (e) => {
                if (e.target.closest("a, .bdb-kanban-card-meta, .bdb-kanban-card-crumb")) return;
                e.stopPropagation();
                const wasPicked = state.picked && state.picked.el === cardEl;
                board.querySelectorAll(".bdb-kanban-picked").forEach((el) => el.classList.remove("bdb-kanban-picked"));
                if (wasPicked) {
                  state.picked = null;
                  return;
                }
                state.picked = { el: cardEl, path: card.file.path, line: card.line, fromKey: col.key };
                state.card = card;
                cardEl.classList.add("bdb-kanban-picked");
              });
              cardEl.querySelector(".bdb-kanban-card-meta").addEventListener("click", (e) => {
                openFileAtLine(plugin.app, card.file, card.line, e.ctrlKey || e.metaKey);
              });
            }
          }
        }
      }
      const fit = (tries = 0) => {
        if (!board.isConnected) {
          if (tries < 120) window.requestAnimationFrame(() => fit(tries + 1));
          return;
        }
        const lists = [...board.querySelectorAll(".bdb-kanban-cards")].filter((l) => (l.closest("details")?.open ?? true) && !l.closest(".bdb-kanban-col-folded"));
        if (!lists.length) return;
        const scroller = board.closest(".markdown-preview-view, .cm-scroller, .view-content");
        const savedTop = scroller ? scroller.scrollTop : null;
        for (const l of lists) {
          l.style.flex = "0 0 auto";
          l.style.maxHeight = "none";
        }
        const heights = lists.map((l) => l.offsetHeight);
        for (const l of lists) l.style.flex = "";
        let H = pct(heights, 0.75);
        const hMax = Math.max(...heights);
        if (hMax <= H * 1.2) H = hMax;
        H = Math.max(H, 280);
        H = Math.min(H, Math.round(window.innerHeight * 0.7));
        for (const [i, l] of lists.entries()) {
          l.style.maxHeight = `${Math.round(H)}px`;
          l.classList.toggle("bdb-kanban-clipped", heights[i] > H + 4);
        }
        if (scroller && savedTop != null) scroller.scrollTop = savedTop;
      };
      void fit;
    }
    module2.exports = {
      parseKanbanConfig: parseKanbanConfig2,
      parseSweeps,
      scanKanbanTasks,
      moveCard: moveCard2,
      sweepColumn,
      setRankLine,
      setDesktopLine,
      setEstLine,
      RANK_RE,
      DESKTOP_RE,
      EST_RE,
      logTapSpan,
      renderKanbanBlock: renderKanbanBlock2,
      drawBoard,
      resolveKanbanConfig,
      editTags,
      tagLineAt,
      commentInsertAt,
      taskColumn,
      openDescendants,
      cleanText,
      addTitleCopy,
      stampNow,
      stampToDate,
      stampDigits,
      stampWrite,
      fmtDur,
      TASK_RE: TASK_RE2,
      TASK_END_RE: TASK_END_RE2,
      STAMP_RE,
      TAGLINE_RE,
      COLOR_RE,
      HIST_RE: HIST_RE2,
      EI_HIST_RE,
      terminalStamp,
      columnColor,
      colKey
    };
  }
});

// src/ei.js
var require_ei = __commonJS({
  "src/ei.js"(exports2, module2) {
    var { MarkdownRenderChild, Notice: Notice2, Modal } = require("obsidian");
    var { renderInteractive, openFileAtLine } = require_render();
    var {
      scanKanbanTasks,
      moveCard: moveCard2,
      resolveKanbanConfig,
      editTags,
      openDescendants,
      columnColor,
      colKey,
      TASK_RE: TASK_RE2,
      STAMP_RE
    } = require_kanban();
    function parseDoors(text) {
      const out = [];
      for (const part of (text || "").split(/[,\n]/)) {
        let spec = part.trim();
        if (!spec) continue;
        const who = /\s\+who\b/.test(spec);
        spec = spec.replace(/\s\+who\b/, "").trim();
        const [name, target] = spec.split(">").map((s) => s.trim());
        if (name && target) out.push({ name, target: colKey(target), who });
      }
      return out;
    }
    function resolveEiConfig(plugin, src) {
      const config = { paths: [], from: null, doors: [] };
      let lastKey = null;
      for (const rawLine of (src || "").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const m = line.match(/^(paths|from|doors)\s*:\s*(.*)$/);
        const key = m ? m[1] : lastKey;
        const value = m ? m[2].trim() : line;
        lastKey = key;
        if (!key || !value) continue;
        if (key === "from") config.from = value;
        else if (key === "doors") config.doors.push(...parseDoors(value));
        else config.paths.push(...value.split(",").map((s) => s.trim()).filter(Boolean));
      }
      const d = plugin.settings?.ei || {};
      if (!config.paths.length && d.paths) config.paths = d.paths.split(",").map((s) => s.trim()).filter(Boolean);
      if (!config.from && d.from) config.from = d.from;
      if (!config.doors.length) config.doors = parseDoors(d.doors || "Do > Todo\nDelegate > Waiting +who\nDelete > Cancelled");
      return config;
    }
    async function editCardTags(app2, card, who) {
      const lines = (await app2.vault.read(card.file)).split(/\r?\n/);
      if (!TASK_RE2.test(lines[card.line] || "")) return false;
      editTags(lines, card.line, (tokens) => {
        const out = tokens.filter((t) => !t.startsWith("#ei/"));
        if (who && !out.includes(`[[${who}]]`)) out.push(`[[${who}]]`);
        return out;
      });
      await app2.vault.modify(card.file, lines.join("\n"));
      return true;
    }
    function askWho(app2) {
      return new Promise((resolve) => {
        const modal = new Modal(app2);
        let done = false;
        modal.titleEl.setText("Delegate to");
        const input = modal.contentEl.createEl("input", {
          type: "text",
          attr: { placeholder: "Person \u2014 becomes a [[wikilink]]" }
        });
        input.style.width = "100%";
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && input.value.trim()) {
            done = true;
            const v = input.value.trim();
            modal.close();
            resolve(v);
          }
        });
        modal.onClose = () => {
          if (!done) resolve(null);
        };
        modal.open();
        window.setTimeout(() => input.focus(), 0);
      });
    }
    async function renderEiBlock2(plugin, src, el, ctx) {
      el.empty();
      const root = el.createDiv({ cls: "bdb-ei" });
      const state = { dragging: false };
      const redraw = () => {
        if (!state.dragging) drawEi(plugin, root, src, state);
      };
      const child = new MarkdownRenderChild(el);
      ctx.addChild(child);
      child.registerInterval(window.setInterval(redraw, 6e4));
      let pending = null;
      child.registerEvent(plugin.app.vault.on("modify", () => {
        window.clearTimeout(pending);
        pending = window.setTimeout(redraw, 500);
      }));
      await drawEi(plugin, root, src, state);
    }
    async function drawEi(plugin, root, src, state) {
      root.empty();
      const app2 = plugin.app;
      const ei = resolveEiConfig(plugin, src);
      const kb = resolveKanbanConfig(plugin, "");
      if (ei.paths.length) kb.paths = ei.paths;
      const open = kb.columns.filter((c) => !c.state);
      const first = ei.from ? open.find((c) => c.key === colKey(ei.from)) : open[0];
      if (!first) {
        root.createDiv({ text: `ei: no open kanban column${ei.from ? ` named "${ei.from}"` : ""}` });
        return;
      }
      const doors = ei.doors.map((d) => ({ ...d, col: kb.columns.find((c) => c.key === d.target) || null }));
      const backlog = (await scanKanbanTasks(app2, kb)).get(first.key) || [];
      const tray = root.createDiv({ cls: "bdb-ei-zone bdb-ei-tray" });
      tray.style.setProperty("--ei-color", columnColor(kb, first, kb.columns.indexOf(first)));
      tray.createDiv({ cls: "bdb-ei-zone-title", text: `${first.name} (${backlog.length})` });
      const trayList = tray.createDiv({ cls: "bdb-ei-cards" });
      tray.createDiv({ cls: "bdb-ei-hint", text: "drag right to decide" });
      for (const card of backlog) await eiCard(plugin, trayList, card, state);
      const grid = root.createDiv({ cls: "bdb-ei-grid" });
      for (const door of doors) {
        const zoneEl = grid.createDiv({ cls: "bdb-ei-zone" });
        zoneEl.style.setProperty(
          "--ei-color",
          door.col ? columnColor(kb, door.col, kb.columns.indexOf(door.col)) : "var(--text-faint)"
        );
        zoneEl.createDiv({ cls: "bdb-ei-zone-title", text: door.name });
        zoneEl.createDiv({ cls: "bdb-ei-cards" });
        zoneEl.createDiv({
          cls: "bdb-ei-hint",
          text: door.col ? `${door.who ? "who? " : ""}\u2192 ${door.col.name}${door.col.state ? ` [${door.col.state}]` : ""}` : `no "${door.target}" column on the kanban`
        });
        zoneEl.addEventListener("dragover", (e) => {
          e.preventDefault();
          zoneEl.classList.add("bdb-ei-over");
        });
        zoneEl.addEventListener("dragleave", () => zoneEl.classList.remove("bdb-ei-over"));
        zoneEl.addEventListener("drop", async (e) => {
          e.preventDefault();
          zoneEl.classList.remove("bdb-ei-over");
          state.dragging = false;
          const [path, lineStr] = (e.dataTransfer.getData("text/plain") || "").split("::");
          const card = backlog.find((c) => c.file.path === path && c.line === Number(lineStr));
          if (!card) return;
          if (!door.col) {
            new Notice2(`ei: add a "${door.target}" column to your kanban first`);
            return;
          }
          if (door.col.state && openDescendants(card) > 0) {
            new Notice2("ei: open sub-tasks \u2014 close them first");
            return;
          }
          let who = null;
          if (door.who) {
            who = await askWho(app2);
            if (who == null) return;
          }
          await editCardTags(app2, card, who);
          await moveCard2(app2, card.file, card.line, door.col, kb, { fromCol: first });
          await drawEi(plugin, root, src, state);
        });
      }
    }
    async function eiCard(plugin, list, card, state) {
      const cardEl = list.createDiv({ cls: "bdb-ei-card", attr: { draggable: "true" } });
      const display = card.body.replace(/#[\w/-]+/g, "").replace(STAMP_RE, "").replace(/\s{2,}/g, " ").trim();
      await renderInteractive(plugin, display, cardEl.createDiv({ cls: "bdb-kanban-card-text" }), card.file.path);
      if (card.who.length) {
        const whoEl = cardEl.createDiv({ cls: "bdb-ei-who" });
        for (const name of card.who) whoEl.createSpan({ cls: "bdb-ei-who-pill", text: name });
      }
      const meta = cardEl.createDiv({ cls: "bdb-kanban-card-meta", text: card.file.basename });
      meta.addEventListener("click", (e) => openFileAtLine(plugin.app, card.file, card.line, e.ctrlKey || e.metaKey));
      cardEl.addEventListener("dragstart", (e) => {
        state.dragging = true;
        e.dataTransfer.setData("text/plain", `${card.file.path}::${card.line}`);
        e.dataTransfer.effectAllowed = "move";
      });
      cardEl.addEventListener("dragend", () => {
        state.dragging = false;
      });
    }
    module2.exports = { renderEiBlock: renderEiBlock2, resolveEiConfig, parseDoors };
  }
});

// src/report.js
var require_report = __commonJS({
  "src/report.js"(exports2, module2) {
    var { TASK_RE: TASK_RE2, STAMP_RE, stampToDate, stampDigits, stampWrite, parseKanbanConfig: parseKanbanConfig2, fmtDur, addTitleCopy } = require_kanban();
    var { openFileAtLine } = require_render();
    var { chrono } = require_activity();
    var { MarkdownRenderChild, Modal, Notice: Notice2, getFrontMatterInfo, parseYaml } = require("obsidian");
    var HIST_RE2 = /^\s*%%\s?kb (\d{8}-?\d{4}) (.+?) > (.+?)\s?%%\s*$/;
    var COLOR_RE = /^\s*%%\s?kbcolor (#[0-9a-fA-F]{3,8}|[a-zA-Z]+)\s?%%\s*$/;
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
    var _colCache = {};
    var _cycleIdx = 0;
    function colColor(name) {
      const k = (name || "").toLowerCase().replace(/\s+/g, "-");
      if (_colCache[k]) return _colCache[k];
      return _colCache[k] = COL_PALETTE[k] || COL_CYCLE[_cycleIdx++ % COL_CYCLE.length];
    }
    function projColor(name) {
      let h = 0;
      for (const c of String(name)) h = h * 31 + c.charCodeAt(0) >>> 0;
      return `hsl(${h % 360} 52% 55%)`;
    }
    function indentWidth(text) {
      let w = 0;
      for (const ch of text.match(/^\s*/)[0]) w += ch === "	" ? 4 : 1;
      return w;
    }
    function fmtClock(d) {
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
    function fmtDateTitle(dateStr) {
      return `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
    }
    function shiftDateStr(dateStr, { years = 0, months = 0, days = 0 } = {}) {
      const d = new Date(+dateStr.slice(0, 4), +dateStr.slice(4, 6) - 1, +dateStr.slice(6, 8));
      if (years) d.setFullYear(d.getFullYear() + years);
      if (months) d.setMonth(d.getMonth() + months);
      if (days) d.setDate(d.getDate() + days);
      return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    }
    function parseDateStr(dateStr) {
      return new Date(+dateStr.slice(0, 4), +dateStr.slice(4, 6) - 1, +dateStr.slice(6, 8));
    }
    function toDateStr(d) {
      return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    }
    function rangeDates(startStr, endStr) {
      const out = [];
      for (let d = parseDateStr(startStr), end = parseDateStr(endStr); d <= end; d.setDate(d.getDate() + 1)) {
        out.push(toDateStr(d));
      }
      return out;
    }
    function weekBounds(dateStr) {
      const d = parseDateStr(dateStr);
      const dow = (d.getDay() + 6) % 7;
      d.setDate(d.getDate() - dow);
      const start = toDateStr(d);
      d.setDate(d.getDate() + 6);
      const end = toDateStr(d);
      return { start, end };
    }
    function reportRange(state) {
      if (state.mode === "week") {
        const { start, end } = weekBounds(state.dateStr);
        return { start, end, dates: rangeDates(start, end), label: `${fmtDateTitle(start)} .. ${fmtDateTitle(end)}` };
      }
      if (state.mode === "7d") {
        const end = state.dateStr;
        const start = shiftDateStr(end, { days: -6 });
        return { start, end, dates: rangeDates(start, end), label: `${fmtDateTitle(start)} .. ${fmtDateTitle(end)}` };
      }
      return { start: state.dateStr, end: state.dateStr, dates: [state.dateStr], label: fmtDateTitle(state.dateStr) };
    }
    function dayOfWeekLabel(dateStr) {
      return parseDateStr(dateStr).toLocaleDateString(void 0, { weekday: "long" });
    }
    function weekNumberLabel(dateStr) {
      const d = parseDateStr(dateStr);
      const utc = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
      const day = utc.getUTCDay() || 7;
      utc.setUTCDate(utc.getUTCDate() + 4 - day);
      const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
      const week = Math.ceil(((utc - yearStart) / 864e5 + 1) / 7);
      return `Week ${week}`;
    }
    async function collectReportData(app2, startStr, endStr, paths2, isActive) {
      const tasks = [], standing = [];
      const files = app2.vault.getMarkdownFiles().filter((f) => {
        if (paths2.length && !paths2.some((p) => f.path.startsWith(p))) return false;
        return !!app2.metadataCache.getFileCache(f)?.listItems?.some((it) => it.task != null);
      });
      for (const file of files) {
        const raw = await app2.vault.cachedRead(file);
        const info = getFrontMatterInfo(raw);
        const fm = info.frontmatter ? parseYaml(info.frontmatter) || {} : {};
        const lines = raw.split(/\r?\n/);
        const stack = [], cards = [];
        for (let li = 0; li < lines.length; li++) {
          const text = lines[li];
          const tm = text.match(TASK_RE2);
          if (tm) {
            const indent = indentWidth(text);
            while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
            const card = { body: tm[4].replace(STAMP_RE, "").trim(), history: [], indent, file, line: li, color: null, fm };
            stack.push({ indent, card });
            cards.push(card);
            continue;
          }
          const hm = text.match(HIST_RE2);
          if (hm) {
            const hi = indentWidth(text);
            for (let i = stack.length - 1; i >= 0; i--) {
              if (stack[i].indent < hi) {
                stack[i].card.history.push({ stamp: stampDigits(hm[1]), from: hm[2], to: hm[3], line: li, seq: li });
                break;
              }
            }
            continue;
          }
          const cm = text.match(COLOR_RE);
          if (cm) {
            const ci = indentWidth(text);
            for (let i = stack.length - 1; i >= 0; i--) {
              if (stack[i].indent < ci) {
                stack[i].card.color = cm[1];
                break;
              }
            }
          }
        }
        for (const card of cards) {
          const rangeMoves = card.history.filter((h) => {
            const ds = h.stamp.slice(0, 8);
            return ds >= startStr && ds <= endStr;
          });
          if (rangeMoves.length) {
            tasks.push({ ...card, history: rangeMoves });
            continue;
          }
          const upto = card.history.filter((h) => h.stamp.slice(0, 8) <= endStr);
          if (!upto.length) continue;
          const last = chrono(upto).at(-1);
          if (isActive(last.to)) standing.push({ ...card, col: last.to });
        }
      }
      return { tasks, standing };
    }
    function buildSegments(history2, rangeStart, rangeEnd) {
      const events = chrono(history2);
      const segs = [];
      segs.push({ col: events[0].from, start: rangeStart, end: stampToDate(events[0].stamp), startIdx: null, endIdx: 0 });
      for (let i = 0; i < events.length; i++) {
        const end = i + 1 < events.length ? stampToDate(events[i + 1].stamp) : rangeEnd;
        segs.push({ col: events[i].to, start: stampToDate(events[i].stamp), end, startIdx: i, endIdx: i + 1 < events.length ? i + 1 : null });
      }
      return segs.filter((s) => s.end > s.start);
    }
    function hhmmInput(d) {
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
    function stampForDateTime(dateStr, hhmm) {
      const digits = String(hhmm || "").replace(/[^0-9]/g, "");
      if (digits.length !== 4) return null;
      return `${dateStr}${digits}`;
    }
    function stampToMs(stamp) {
      return stampToDate(stamp).getTime();
    }
    function formatDragStamp(ms) {
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
    function fmtDurGranular(ms) {
      const m = Math.floor(ms / 6e4);
      if (m < 60) return `${m}m`;
      const h = Math.floor(m / 60);
      const mm = m % 60;
      return mm ? `${h}h ${mm}m` : `${h}h`;
    }
    async function rewriteReportSegmentTimes(app2, task, seg, dateStr, startVal, endVal) {
      const startStamp = seg.startIdx == null ? null : stampForDateTime(dateStr, startVal);
      const endStamp = seg.endIdx == null ? null : stampForDateTime(dateStr, endVal);
      if (seg.startIdx != null && !startStamp || seg.endIdx != null && !endStamp) throw new Error("time must be HH:MM");
      if (seg.startIdx != null && seg.endIdx != null && startStamp >= endStamp) throw new Error("start must be before end");
      const events = task.chrono(history);
      const prev = seg.startIdx > 0 ? events[seg.startIdx - 1].stamp : `${dateStr}0000`;
      const next = seg.endIdx == null ? null : seg.endIdx + 1 < events.length ? events[seg.endIdx + 1].stamp : `${dateStr}2359`;
      if (startStamp && startStamp <= prev) throw new Error("start would overlap previous segment");
      if (endStamp && endStamp >= next) throw new Error("end would overlap next segment");
      if (startStamp && endStamp && startStamp >= endStamp) throw new Error("start must be before end");
      const content = await app2.vault.read(task.file);
      const lines = content.split(/\r?\n/);
      const refs = [
        ...seg.startIdx == null ? [] : [events[seg.startIdx]],
        ...seg.endIdx == null ? [] : [events[seg.endIdx]]
      ];
      for (const ref of refs) {
        const li = ref.line;
        const m = lines[li]?.match(HIST_RE2);
        if (!m) throw new Error("history line not found");
        const newStamp = ref === events[seg.startIdx] ? startStamp : endStamp;
        lines[li] = lines[li].replace(m[1], stampWrite(newStamp));
      }
      await app2.vault.modify(task.file, lines.join("\n"));
    }
    function dragBounds(task, seg, dateStr, maxT) {
      const events = task.chrono(history);
      return {
        prev: seg.startIdx > 0 ? stampToMs(events[seg.startIdx - 1].stamp) : new Date(+dateStr.slice(0, 4), +dateStr.slice(4, 6) - 1, +dateStr.slice(6, 8), 0, 0, 0).getTime(),
        next: seg.endIdx == null ? maxT : seg.endIdx + 1 < events.length ? stampToMs(events[seg.endIdx + 1].stamp) : new Date(+dateStr.slice(0, 4), +dateStr.slice(4, 6) - 1, +dateStr.slice(6, 8), 23, 59, 0).getTime()
      };
    }
    function reportSegDragMode(seg, localX, segWidthPx, edgePx) {
      const canStart = seg.startIdx != null;
      const canEnd = seg.endIdx != null;
      if (canStart && canEnd) {
        if (localX <= edgePx) return "start";
        if (localX >= segWidthPx - edgePx) return "end";
        return "move";
      }
      if (canStart && localX <= edgePx) return "start";
      if (canEnd && localX >= segWidthPx - edgePx) return "end";
      return null;
    }
    function showDragBubble(text, x, y) {
      let el = document.querySelector(".bdb-report-drag-bubble");
      if (!el) {
        el = document.createElement("div");
        el.className = "bdb-report-drag-bubble";
        document.body.appendChild(el);
      }
      el.textContent = text;
      const pad = 12;
      const width = el.offsetWidth || 0;
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const clamped = Math.max(pad + width / 2, Math.min(vw - pad - width / 2, x));
      const anchor = width ? (x - (clamped - width / 2)) / width * 100 : 50;
      el.style.left = `${clamped}px`;
      el.style.top = `${y}px`;
      el.style.setProperty("--bdb-bubble-anchor", `${Math.max(10, Math.min(90, anchor))}%`);
      el.classList.add("is-visible");
      return el;
    }
    function hideDragBubble() {
      document.querySelector(".bdb-report-drag-bubble")?.classList.remove("is-visible");
    }
    function showOriginBubble(text, x, y, color) {
      let el = document.querySelector(".bdb-report-origin-bubble");
      if (!el) {
        el = document.createElement("div");
        el.className = "bdb-report-origin-bubble";
        document.body.appendChild(el);
      }
      el.textContent = text;
      const pad = 12;
      const width = el.offsetWidth || 0;
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const clamped = Math.max(pad + width / 2, Math.min(vw - pad - width / 2, x));
      const anchor = width ? (x - (clamped - width / 2)) / width * 100 : 50;
      el.style.left = `${clamped}px`;
      el.style.top = `${y}px`;
      el.style.setProperty("--bdb-bubble-anchor", `${Math.max(10, Math.min(90, anchor))}%`);
      if (color) el.style.setProperty("--bdb-origin-color", color);
      if (color) el.style.setProperty("--bdb-origin-color-mix", `color-mix(in srgb, ${color} 78%, black)`);
      el.classList.add("is-visible");
      return el;
    }
    function hideOriginBubble() {
      document.querySelector(".bdb-report-origin-bubble")?.classList.remove("is-visible");
    }
    function setReportGuidesVisible(el, on, topPx = null) {
      if (!el) return;
      if (topPx != null) el.style.top = `${topPx}px`;
      el.classList.toggle("is-visible", !!on);
    }
    var activeReportDrag = null;
    var reportEscBound = false;
    function ensureReportEscHandler() {
      if (reportEscBound) return;
      reportEscBound = true;
      window.addEventListener("keydown", (ev) => {
        if (ev.key !== "Escape" || !activeReportDrag?.cancel) return;
        ev.preventDefault();
        ev.stopPropagation();
        activeReportDrag.cancel();
      }, true);
    }
    function editSegmentTimes(app2, task, seg, dateStr) {
      return new Promise((resolve) => {
        const modal = new Modal(app2);
        let done = false;
        modal.titleEl.setText(`Edit ${seg.col}`);
        const start = modal.contentEl.createEl("input", { type: "time", value: hhmmInput(seg.start) });
        const end = modal.contentEl.createEl("input", { type: "time", value: hhmmInput(seg.end) });
        start.style.display = end.style.display = "block";
        start.style.width = end.style.width = "100%";
        start.style.marginBottom = "8px";
        if (seg.startIdx == null) {
          start.disabled = true;
          modal.contentEl.createDiv({ text: "Carryover segment: start stays at day start." });
        }
        if (seg.endIdx == null) {
          end.disabled = true;
          modal.contentEl.createDiv({ text: "Running segment: end stays at now." });
        }
        const info = modal.contentEl.createDiv({ text: `${fmtClock(seg.start)}-${fmtClock(seg.end)} \xB7 ${fmtDur(seg.end - seg.start)}` });
        const actions = modal.contentEl.createDiv();
        actions.style.display = "flex";
        actions.style.gap = "8px";
        actions.style.marginTop = "12px";
        const save = actions.createEl("button", { text: "Save" });
        const cancel = actions.createEl("button", { text: "Cancel" });
        const submit = async () => {
          try {
            await rewriteReportSegmentTimes(app2, task, seg, dateStr, start.value, end.value);
            done = true;
            modal.close();
            resolve(true);
          } catch (err) {
            new Notice2(`report: ${err.message}`);
          }
        };
        save.addEventListener("click", submit);
        cancel.addEventListener("click", () => {
          done = true;
          modal.close();
          resolve(false);
        });
        end.addEventListener("keydown", (e) => {
          if (e.key === "Enter") void submit();
        });
        start.addEventListener("keydown", (e) => {
          if (e.key === "Enter") void submit();
        });
        modal.onClose = () => {
          if (!done) resolve(false);
        };
        modal.open();
        window.setTimeout(() => start.focus(), 0);
      });
    }
    function renderPending(plugin, wrap, standing) {
      if (!standing.length) return;
      wrap.createEl("div", { cls: "bdb-report-pending-title", text: "Still pending (no move today)" });
      for (const card of standing) {
        const row = wrap.createEl("div", { cls: "bdb-report-pending-row" });
        row.createEl("i", { cls: "bdb-report-legend-dot" }).style.background = colColor(card.col);
        const lbl = row.createEl("span", { cls: "bdb-report-pending-label", text: card.body, attr: { "aria-label": `${card.col}: ${card.body}` } });
        lbl.addEventListener("click", (e) => openFileAtLine(plugin.app, card.file, card.line, e.ctrlKey || e.metaKey));
      }
    }
    async function renderReportRangeSection(plugin, host, startStr, endStr, config, activeNames, pausedNames, terminalNames, redraw, { showSubtitle = false, label = null, interactive = true } = {}) {
      const title = label || (startStr === endStr ? fmtDateTitle(startStr) : `${fmtDateTitle(startStr)} .. ${fmtDateTitle(endStr)}`);
      const visibleKeys = new Set((config.only?.length ? config.only : ["todo", "doing", "parked", "done", "cancelled"]).map((s) => String(s).toLowerCase()));
      const { tasks, standing } = await collectReportData(plugin.app, startStr, endStr, config.paths, (n) => activeNames.has((n || "").toLowerCase()));
      const section = host.createDiv({ cls: "bdb-report-day" });
      if (showSubtitle) section.createDiv({ cls: "bdb-report-subtitle", text: title });
      if (!tasks.length && !standing.length) {
        section.createEl("div", { cls: "bdb-report-empty", text: `No task movements on ${title}` });
        return;
      }
      if (!tasks.length) {
        section.createEl("div", { cls: "bdb-report-empty", text: `No task movements on ${title}` });
        renderPending(plugin, section, standing);
        return;
      }
      const dayStart = parseDateStr(startStr);
      dayStart.setHours(0, 0, 0, 0);
      const endOfDay = parseDateStr(endStr);
      endOfDay.setHours(23, 59, 59, 999);
      const allStamps = tasks.flatMap((t) => t.history.map((h) => stampToDate(h.stamp).getTime()));
      const pad = 15 * 6e4;
      const minT = dayStart.getTime();
      const now = /* @__PURE__ */ new Date();
      const todayStr = toDateStr(now);
      const maxEvent = Math.max(...allStamps) + pad;
      const maxT = endStr < todayStr ? endOfDay.getTime() : Math.min(endOfDay.getTime(), Math.max(maxEvent, now.getTime()));
      const rangeMs = maxT - minT || 1;
      const pct = (t) => Math.max(0, Math.min(100, (t.getTime() - minT) / rangeMs * 100)).toFixed(2);
      const fmt = fmtClock;
      const pxToMinuteMs = (dx, width) => Math.round(dx / Math.max(width, 1) * rangeMs / 6e4) * 6e4;
      section.dataset.zoom = section.dataset.zoom || "1";
      section.dataset.pan = section.dataset.pan || "0";
      const applyZoom = (z, anchor01) => {
        section.dataset.zoom = String(z);
        const pan = Number(section.dataset.pan || "0");
        section.style.setProperty("--bdb-report-zoom", String(z));
        section.style.setProperty("--bdb-report-zoom-shift", `${pan - (z - 1) * anchor01 * 100}%`);
      };
      const applyPan = (pan) => {
        const zoom = Number(section.dataset.zoom || "1");
        const minPan = -(zoom - 1) * 100;
        const clamped = Math.max(minPan, Math.min(0, pan));
        section.dataset.pan = String(clamped);
        section.style.setProperty("--bdb-report-zoom", String(zoom));
        section.style.setProperty("--bdb-report-zoom-shift", `${clamped}%`);
      };
      applyPan(Number(section.dataset.pan || "0"));
      const rulerBar = section.createEl("div", { cls: "bdb-report-ruler" });
      const rulerInner = rulerBar.createDiv({ cls: "bdb-report-ruler-inner" });
      for (let i = 0; i <= 4; i++) {
        const tick = rulerInner.createEl("span", { cls: "bdb-report-tick", text: fmt(new Date(minT + rangeMs * i / 4)) });
        tick.style.left = `${i / 4 * 100}%`;
      }
      section.addEventListener("wheel", (e) => {
        const rect = rulerBar.getBoundingClientRect();
        if (e.altKey) {
          e.preventDefault();
          applyPan(Number(section.dataset.pan || "0") - (e.deltaY + e.deltaX) * 0.08);
          return;
        }
        if (!(e.metaKey || e.ctrlKey)) return;
        e.preventDefault();
        const anchor01 = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(rect.width, 1)));
        const cur = Number(section.dataset.zoom || "1");
        const next = Math.max(1, Math.min(20, e.deltaY < 0 ? cur * 1.12 : cur / 1.12));
        applyZoom(next, anchor01);
      }, { passive: false });
      for (const task of tasks) {
        task._segs = buildSegments(task.history, new Date(minT), new Date(maxT));
        task._active = task._segs.reduce((s, seg) => {
          const k = (seg.col || "").toLowerCase();
          return s + (!pausedNames.has(k) && !terminalNames.has(k) ? seg.end - seg.start : 0);
        }, 0);
        task._done = task._segs.some((seg) => terminalNames.has((seg.col || "").toLowerCase()));
      }
      const guidePcts = [...new Set(tasks.flatMap((t) => t._segs.flatMap((seg) => {
        const k = (seg.col || "").toLowerCase();
        if (pausedNames.has(k) || terminalNames.has(k)) return [];
        return [pct(seg.start), pct(seg.end)];
      })))];
      const midnightPcts = [];
      if (startStr !== endStr) {
        for (let d = new Date(dayStart); ; ) {
          d.setDate(d.getDate() + 1);
          if (d > endOfDay) break;
          midnightPcts.push(pct(d));
        }
      }
      const midnightsEl = section.createDiv({ cls: "bdb-report-midnights" });
      for (const p of midnightPcts) {
        const line = midnightsEl.createDiv({ cls: "bdb-report-midnight" });
        line.style.left = `${p}%`;
      }
      const guidesEl = section.createDiv({ cls: "bdb-report-guides" });
      for (const p of guidePcts) {
        const line = guidesEl.createDiv({ cls: "bdb-report-guide" });
        line.style.left = `${p}%`;
      }
      const renderRow = (task) => {
        const row = section.createEl("div", { cls: "bdb-report-row" });
        const lbl = row.createEl("div", { cls: "bdb-report-label", text: task.body, attr: { "aria-label": task.body } });
        lbl.addEventListener("click", (e) => openFileAtLine(plugin.app, task.file, task.line, e.ctrlKey || e.metaKey));
        const bar = row.createEl("div", { cls: "bdb-report-bar" });
        const barInner = bar.createDiv({ cls: "bdb-report-bar-inner" });
        const cardColor = task.color || task.fm?.kbcolor || null;
        for (const seg of task._segs) {
          const key = (seg.col || "").toLowerCase();
          if (!visibleKeys.has(key)) continue;
          if (terminalNames.has(key)) {
            const m = barInner.createEl("div", { cls: "bdb-report-mark" });
            m.style.cssText = `left:${pct(seg.start)}%;background:${cardColor || colColor(seg.col)}`;
            continue;
          }
          const s = barInner.createEl("div", { cls: "bdb-report-seg" });
          s.style.cssText = `left:${pct(seg.start)}%;width:${Math.max(0.5, pct(seg.end) - pct(seg.start))}%;background:${cardColor || colColor(seg.col)}`;
          const tip = `${task.body} \xB7 ${seg.col}: ${fmt(seg.start)}\u2013${fmt(seg.end)} \xB7 ${fmtDurGranular(seg.end - seg.start)}`;
          s.dataset.bdbTip = tip;
          s.addEventListener("pointerenter", (e) => {
            if (!activeReportDrag) showDragBubble(tip, e.clientX, e.clientY - 14);
          });
          s.addEventListener("pointerleave", () => {
            if (!activeReportDrag) hideDragBubble();
            s.classList.remove("is-drag-start", "is-drag-end", "is-drag-move");
          });
          s.addEventListener("pointermove", (e) => {
            if (!activeReportDrag) showDragBubble(tip, e.clientX, e.clientY - 14);
            if (!interactive) return;
            const localX = e.clientX - s.getBoundingClientRect().left;
            const segWidthPx = s.getBoundingClientRect().width;
            const mode = reportSegDragMode(seg, localX, segWidthPx, 10);
            s.classList.toggle("is-drag-start", mode === "start");
            s.classList.toggle("is-drag-end", mode === "end");
            s.classList.toggle("is-drag-move", mode === "move");
          });
          if (interactive && (seg.startIdx != null || seg.endIdx != null)) {
            s.addEventListener("pointerdown", (e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              const rect = bar.getBoundingClientRect();
              const segStartMs = seg.start.getTime(), segEndMs = seg.end.getTime();
              const localX = e.clientX - s.getBoundingClientRect().left;
              const segWidthPx = s.getBoundingClientRect().width;
              const mode = reportSegDragMode(seg, localX, segWidthPx, 10);
              if (!mode) return;
              const bounds = dragBounds(task, seg, startStr, maxT);
              let moved = false, cancelled = false, draftStart = segStartMs, draftEnd = segEndMs;
              const originText = mode === "move" ? `${formatDragStamp(segStartMs)}-${formatDragStamp(segEndMs)}` : formatDragStamp(mode === "end" ? segEndMs : segStartMs);
              setReportGuidesVisible(guidesEl, true, rulerBar.offsetTop + rulerBar.offsetHeight + 4);
              showOriginBubble(originText, e.clientX, rect.top - 18, cardColor || colColor(seg.col));
              const paint = () => {
                s.style.left = `${(draftStart - minT) / rangeMs * 100}%`;
                s.style.width = `${Math.max(0.5, (draftEnd - draftStart) / rangeMs * 100)}%`;
              };
              const updateBubble = (x, y) => showDragBubble(mode === "move" ? `${formatDragStamp(draftStart)}-${formatDragStamp(draftEnd)}` : formatDragStamp(mode === "end" ? draftEnd : draftStart), x, y - 18);
              const onMove = (ev) => {
                const delta = pxToMinuteMs(ev.clientX - e.clientX, rect.width);
                moved = moved || Math.abs(delta) >= 6e4;
                if (mode === "start") draftStart = Math.max(bounds.prev + 6e4, Math.min(segEndMs - 6e4, segStartMs + delta));
                else if (mode === "end") draftEnd = Math.min(bounds.next - 6e4, Math.max(segStartMs + 6e4, segEndMs + delta));
                else {
                  const span = segEndMs - segStartMs, minStart = bounds.prev + 6e4, maxStart = bounds.next - span - 6e4;
                  draftStart = Math.max(minStart, Math.min(maxStart, segStartMs + delta));
                  draftEnd = draftStart + span;
                }
                paint();
                updateBubble(ev.clientX, rect.top);
              };
              const cancelDrag = () => {
                cancelled = true;
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
                hideDragBubble();
                hideOriginBubble();
                setReportGuidesVisible(guidesEl, false);
                activeReportDrag = null;
                s.style.cssText = `left:${pct(seg.start)}%;width:${Math.max(0.5, pct(seg.end) - pct(seg.start))}%;background:${cardColor || colColor(seg.col)}`;
              };
              activeReportDrag = { cancel: cancelDrag };
              const onUp = async () => {
                activeReportDrag = null;
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
                hideDragBubble();
                hideOriginBubble();
                setReportGuidesVisible(guidesEl, false);
                if (cancelled) return;
                if (!moved) {
                  s.style.cssText = `left:${pct(seg.start)}%;width:${Math.max(0.5, pct(seg.end) - pct(seg.start))}%;background:${cardColor || colColor(seg.col)}`;
                  if (await editSegmentTimes(plugin.app, task, seg, startStr)) await redraw();
                  return;
                }
                try {
                  await rewriteReportSegmentTimes(plugin.app, task, seg, startStr, hhmmInput(new Date(draftStart)), hhmmInput(new Date(draftEnd)));
                  await redraw();
                } catch (err) {
                  new Notice2(`report: ${err.message}`);
                  s.style.cssText = `left:${pct(seg.start)}%;width:${Math.max(0.5, pct(seg.end) - pct(seg.start))}%;background:${cardColor || colColor(seg.col)}`;
                }
              };
              updateBubble(e.clientX, rect.top);
              window.addEventListener("pointermove", onMove);
              window.addEventListener("pointerup", onUp, { once: true });
            });
          }
        }
      };
      const rollup = (list) => `${list.length}t \xB7 ${fmtDur(list.reduce((s, t) => s + t._active, 0))} active \xB7 ${list.filter((t) => t._done).length} done`;
      const laneKey = config.lane;
      const groupOf = (task) => {
        let v = task.fm?.[laneKey];
        if (Array.isArray(v)) v = v[0];
        v = v == null ? "" : String(v).replace(/^\[\[|\]\]$/g, "").replace(/\|.*$/, "").trim();
        return v || "(none)";
      };
      if (!laneKey) {
        section.createEl("div", { cls: "bdb-report-rollup", text: rollup(tasks) });
        for (const task of tasks) renderRow(task);
      } else {
        const groups = /* @__PURE__ */ new Map();
        for (const task of tasks) (groups.get(groupOf(task)) || groups.set(groupOf(task), []).get(groupOf(task))).push(task);
        for (const [name, list] of [...groups.entries()].sort((a, b) => (a[0] === "(none)") - (b[0] === "(none)") || b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
          const head = section.createEl("div", { cls: "bdb-report-group" });
          const nameEl = head.createEl("span", { cls: "bdb-report-group-name", text: name });
          addTitleCopy(nameEl, name);
          head.createEl("span", { cls: "bdb-report-group-stat", text: rollup(list) });
          for (const task of list) renderRow(task);
        }
      }
      renderPending(plugin, section, standing);
      const legendCols = [...new Set(tasks.flatMap((t) => t.history.flatMap((h) => [h.from, h.to])))].filter((c) => visibleKeys.has((c || "").toLowerCase()));
      const legend = section.createEl("div", { cls: "bdb-report-legend" });
      for (const col of legendCols) {
        const item = legend.createEl("span", { cls: "bdb-report-legend-item" });
        item.createEl("i", { cls: "bdb-report-legend-dot" }).style.background = colColor(col);
        item.appendText(col);
      }
    }
    async function renderDaySummary(plugin, host, startStr, endStr, config, activeNames, pausedNames, terminalNames) {
      const { tasks, standing } = await collectReportData(plugin.app, startStr, endStr, config.paths, (n) => activeNames.has((n || "").toLowerCase()));
      const section = host.createDiv({ cls: "bdb-report-summary" });
      if (!tasks.length) {
        section.createDiv({ cls: "bdb-report-empty", text: "No task movements" });
        renderPending(plugin, section, standing);
        return;
      }
      const dayStart = parseDateStr(startStr);
      dayStart.setHours(0, 0, 0, 0);
      const endOfDay = parseDateStr(endStr);
      endOfDay.setHours(23, 59, 59, 999);
      const now = /* @__PURE__ */ new Date();
      const todayStr = toDateStr(now);
      const allStamps = tasks.flatMap((t) => t.history.map((h) => stampToDate(h.stamp).getTime()));
      const maxEvent = Math.max(...allStamps) + 15 * 6e4;
      const maxT = endStr < todayStr ? endOfDay.getTime() : Math.min(endOfDay.getTime(), Math.max(maxEvent, now.getTime()));
      const colTime = /* @__PURE__ */ new Map();
      const colCount = /* @__PURE__ */ new Map();
      for (const task of tasks) {
        task._segs = buildSegments(task.history, dayStart, new Date(maxT));
        task._active = 0;
        task._done = false;
        const seen = /* @__PURE__ */ new Set();
        for (const seg of task._segs) {
          const k = (seg.col || "").toLowerCase();
          seen.add(seg.col);
          if (terminalNames.has(k)) {
            task._done = true;
            continue;
          }
          const dur = seg.end - seg.start;
          if (!pausedNames.has(k)) task._active += dur;
          colTime.set(seg.col, (colTime.get(seg.col) || 0) + dur);
        }
        for (const c of seen) colCount.set(c, (colCount.get(c) || 0) + 1);
      }
      const totalActive = tasks.reduce((s, t) => s + t._active, 0);
      const doneN = tasks.filter((t) => t._done).length;
      const groups = [];
      if (config.lane) {
        const groupOf = (task) => {
          let v = task.fm?.[config.lane];
          if (Array.isArray(v)) v = v[0];
          v = v == null ? "" : String(v).replace(/^\[\[|\]\]$/g, "").replace(/\|.*$/, "").trim();
          return v || "(none)";
        };
        const m = /* @__PURE__ */ new Map();
        for (const t of tasks) {
          const g = groupOf(t);
          (m.get(g) || m.set(g, []).get(g)).push(t);
        }
        groups.push(...[...m.entries()].sort((a, b) => b[1].length - a[1].length));
      }
      section.createDiv({ cls: "bdb-report-summary-head", text: `${tasks.length} tasks \xB7 ${fmtDur(totalActive)} active \xB7 ${doneN} done` });
      const sumBar = (caption, segs) => {
        if (!segs.length) return;
        const row = section.createDiv({ cls: "bdb-report-sumbar-row" });
        row.createSpan({ cls: "bdb-report-sumbar-cap", text: caption });
        const track = row.createDiv({ cls: "bdb-report-sumbar" });
        for (const x of segs) {
          const seg = track.createDiv({ cls: "bdb-report-sumbar-seg" });
          seg.style.flexGrow = String(Math.max(x.size, 1));
          seg.style.background = x.color;
          seg.setAttribute("title", x.tip);
          seg.createSpan({ cls: "bdb-report-sumbar-lbl", text: x.label });
        }
      };
      sumBar("Projects", groups.map(([name, arr]) => ({
        size: arr.length,
        color: projColor(name),
        label: `${name} ${arr.length}`,
        tip: `${name}: ${arr.length}t \xB7 ${fmtDur(arr.reduce((s, t) => s + t._active, 0))} active \xB7 ${arr.filter((t) => t._done).length} done`
      })));
      sumBar("Columns", [...colCount.entries()].sort((a, b) => b[1] - a[1]).map(([col, n]) => ({
        size: n,
        color: colColor(col),
        label: `${col} ${n}`,
        tip: `${col}: ${n}t \xB7 ${fmtDur(colTime.get(col) || 0)} active`
      })));
    }
    async function drawReport(plugin, source, el, ctx, redraw, state) {
      ensureReportEscHandler();
      let dateStr = state?.dateStr || (source || "").trim().replace(/[^0-9]/g, "").substring(0, 8);
      if (!dateStr) {
        const m = ctx.sourcePath.match(/(\d{8})/);
        dateStr = m ? m[1] : null;
      }
      if (!dateStr) {
        const t = /* @__PURE__ */ new Date();
        dateStr = `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, "0")}${String(t.getDate()).padStart(2, "0")}`;
      }
      if (state) state.dateStr = dateStr;
      const DEFAULT_COLS = "columns: Backlog~, Todo, Doing!, Parked~, Done=x, Cancelled=-";
      const config = parseKanbanConfig2(source || "");
      const cols = config.columns.length ? config.columns : parseKanbanConfig2(DEFAULT_COLS).columns;
      const activeNames = new Set(cols.filter((c) => !c.state && !c.paused).map((c) => c.name.toLowerCase()));
      const visibleKeys = new Set((config.only?.length ? config.only : ["todo", "doing", "parked", "done", "cancelled"]).map((s) => String(s).toLowerCase()));
      const pausedNames = new Set(cols.filter((c) => c.paused).map((c) => c.name.toLowerCase()));
      const terminalNames = new Set(cols.filter((c) => c.state).map((c) => c.name.toLowerCase()));
      const wrap = el.createEl("div", { cls: "bdb-report" });
      const head = wrap.createDiv({ cls: "bdb-report-head" });
      const mode = state.mode || "day";
      const range = reportRange({ mode, dateStr });
      const modeWrap = head.createDiv({ cls: "bdb-report-modes" });
      for (const key of ["day", "week", "7d"]) {
        const btn = modeWrap.createEl("button", { cls: `bdb-report-mode${mode === key ? " is-active" : ""}`, text: key === "day" ? "D" : key === "week" ? "W" : "7D", attr: { type: "button" } });
        btn.addEventListener("click", async () => {
          state.mode = key;
          await redraw();
        });
      }
      const sumBtn = modeWrap.createEl("button", { cls: `bdb-report-mode${state.summary ? " is-active" : ""}`, text: "\u03A3", attr: { type: "button", "aria-label": "Toggle day summary" } });
      sumBtn.addEventListener("click", async () => {
        state.summary = !state.summary;
        await redraw();
      });
      const dock = head.createDiv({ cls: "bdb-report-dock" });
      const dateBtn = dock.createEl("button", { cls: "bdb-report-title", text: fmtDateTitle(dateStr), attr: { type: "button", "aria-label": "Pick report date" } });
      const metaEl = dock.createDiv({ cls: "bdb-report-meta" });
      const picker = head.createEl("input", { attr: { type: "date" } });
      picker.value = fmtDateTitle(dateStr);
      picker.style.position = "absolute";
      picker.style.opacity = "0";
      picker.style.pointerEvents = "none";
      const nav = dock.createDiv({ cls: "bdb-report-nav" });
      const today = (() => {
        const t = /* @__PURE__ */ new Date();
        return `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, "0")}${String(t.getDate()).padStart(2, "0")}`;
      })();
      dateBtn.addEventListener("click", () => picker.showPicker ? picker.showPicker() : picker.click());
      picker.addEventListener("change", async () => {
        const picked = picker.value.replace(/[^0-9]/g, "");
        if (picked.length === 8) {
          state.dateStr = picked;
          await redraw();
        }
      });
      dateBtn.setText(mode === "week" ? range.label : fmtDateTitle(dateStr));
      metaEl.setText(mode === "week" ? weekNumberLabel(dateStr) : mode === "7d" ? "Rolling 7 days" : dayOfWeekLabel(dateStr));
      nav.empty();
      const addJump = (label, delta, explicitDate = null) => {
        const btn = nav.createEl("button", { cls: "bdb-report-navbtn", text: label, attr: { type: "button" } });
        if (label === "\u2022") btn.classList.add("is-today");
        btn.addEventListener("click", async () => {
          state.dateStr = explicitDate || shiftDateStr(dateStr, delta);
          await redraw();
        });
      };
      addJump("-Y", { years: -1 });
      addJump("-M", { months: -1 });
      addJump("-W", { days: -7 });
      if (mode !== "week") addJump("-D", { days: -1 });
      addJump("\u2022", {}, today);
      if (mode !== "week") addJump("D+", { days: 1 });
      addJump("W+", { days: 7 });
      addJump("M+", { months: 1 });
      addJump("Y+", { years: 1 });
      if (state.summary) {
        await renderDaySummary(plugin, wrap, range.start, range.end, config, activeNames, pausedNames, terminalNames);
      } else if (mode === "week" || mode === "7d") {
        await renderReportRangeSection(plugin, wrap, range.start, range.end, config, activeNames, pausedNames, terminalNames, redraw, {
          showSubtitle: false,
          label: range.label,
          interactive: false
        });
      } else {
        await renderReportRangeSection(plugin, wrap, dateStr, dateStr, config, activeNames, pausedNames, terminalNames, redraw, {
          showSubtitle: false,
          label: fmtDateTitle(dateStr),
          interactive: true
        });
      }
    }
    async function renderReportBlock2(plugin, source, el, ctx) {
      const state = { dateStr: null, mode: "day" };
      const child = new MarkdownRenderChild(el);
      ctx.addChild(child);
      const draw = async () => {
        el.empty();
        try {
          await drawReport(plugin, source, el, ctx, draw, state);
        } catch (e) {
          console.error("bdb report", e);
        }
      };
      child.registerInterval(window.setInterval(() => {
        const today = toDateStr(/* @__PURE__ */ new Date());
        const r = reportRange({ mode: state.mode || "day", dateStr: state.dateStr || today });
        if (r.start <= today && today <= r.end) draw();
      }, 6e4));
      await draw();
    }
    module2.exports = { renderReportBlock: renderReportBlock2, collectDayTasks: async (app2, dateStr, paths2) => (await collectReportData(app2, dateStr, dateStr, paths2, () => false)).tasks };
  }
});

// src/scopes.js
var require_scopes = __commonJS({
  "src/scopes.js"(exports2, module2) {
    var { MarkdownRenderChild, Notice: Notice2 } = require("obsidian");
    async function renderScopesBlock2(plugin, src, el, ctx) {
      const child = new MarkdownRenderChild(el);
      ctx.addChild(child);
      const expanded = /* @__PURE__ */ new Set();
      let timer;
      const refresh = async () => {
        el.empty();
        const groups = await plugin.api.scopeCatalog();
        const root = el.createDiv({ cls: "bdb-scopes" });
        for (const group of groups) {
          const section = root.createEl("details", { cls: "bdb-scopes-org" });
          section.open = expanded.has(group.org);
          section.addEventListener("toggle", () => section.open ? expanded.add(group.org) : expanded.delete(group.org));
          const head = section.createEl("summary", { cls: "bdb-scopes-org-head" });
          head.createSpan({ cls: "bdb-scopes-org-name", text: group.org });
          const orgToggle = head.createEl("button", {
            cls: `bdb-scopes-toggle ${group.active ? "is-active" : "is-inactive"}`,
            text: group.active ? "Active" : "Inactive",
            attr: { "aria-pressed": String(group.active), "aria-label": `${group.org} organization is ${group.active ? "active" : "inactive"}` }
          });
          orgToggle.addEventListener("click", async (event) => {
            event.stopPropagation();
            try {
              await plugin.api.setScopeStatus({ org: group.org, active: !group.active });
            } catch (err) {
              new Notice2(`Scope update failed: ${err.message}`);
            }
          });
          const projects = section.createDiv({ cls: "bdb-scopes-projects" });
          for (const project of group.projects) {
            const row = projects.createDiv({ cls: "bdb-scopes-project" });
            row.createSpan({ cls: "bdb-scopes-project-name", text: project.name });
            row.createSpan({ cls: "bdb-scopes-count", text: `${project.count} notes` });
            const toggle = row.createEl("button", {
              cls: `bdb-scopes-toggle ${project.active ? "is-active" : "is-inactive"}`,
              text: project.active ? "Active" : "Inactive",
              attr: { "aria-pressed": String(project.active), "aria-label": `${group.org} / ${project.name} is ${project.active ? "active" : "inactive"}` }
            });
            toggle.addEventListener("click", async () => {
              try {
                await plugin.api.setScopeStatus({ org: group.org, project: project.name, active: !project.active });
              } catch (err) {
                new Notice2(`Scope update failed: ${err.message}`);
              }
            });
          }
        }
      };
      const schedule = () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => refresh().catch((err) => new Notice2(`Scope refresh failed: ${err.message}`)), 350);
      };
      child.register(() => window.clearTimeout(timer));
      for (const event of ["modify", "create", "delete", "rename"]) {
        child.registerEvent(plugin.app.vault.on(event, (file) => {
          if (!file || file.extension === "md") schedule();
        }));
      }
      await refresh();
    }
    module2.exports = { renderScopesBlock: renderScopesBlock2 };
  }
});

// src/activity.js
var require_activity2 = __commonJS({
  "src/activity.js"(exports2, module2) {
    var { scanKanbanTasks, resolveKanbanConfig, cleanText } = require_kanban();
    var { parseActivity, stints, overlapMs, union, stampMs } = require_activity();
    var LOG_DIR = ".activity";
    var HOUR_PX = 56;
    function dayBounds(dateStr) {
      const lo = stampMs(dateStr + "0000");
      const end = new Date(lo);
      end.setHours(23, 59, 59, 999);
      return { lo, hi: end.getTime() };
    }
    function fmt(ms) {
      const m = Math.round(ms / 6e4);
      if (m < 60) return `${m}m`;
      return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ""}`;
    }
    function hhmm(ms) {
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
    function hue(s) {
      let h = 0;
      for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 360;
      return h;
    }
    async function loadDay(plugin, dateStr, config) {
      const { lo, hi } = dayBounds(dateStr);
      const path = `${LOG_DIR}/${dateStr}.jsonl`;
      const adapter = plugin.app.vault.adapter;
      const text = await adapter.exists(path) ? await adapter.read(path) : "";
      const spans = parseActivity(text).map((x) => ({ ...x, s: Math.max(x.s, lo), e: Math.min(x.e, hi) })).filter((x) => x.e > x.s);
      const today = dateStr === stampOf(/* @__PURE__ */ new Date());
      const openEnd = (s) => today ? Date.now() : Math.min(hi, s + 864e5);
      const doing = [];
      const byCol = await scanKanbanTasks(plugin.app, config);
      for (const [key, list] of byCol) for (const card of list) {
        for (const x of stints(card.history, "doing", lo, hi, openEnd, key === "doing")) doing.push({ ...x, body: cleanText(card.body) });
      }
      doing.sort((a, b) => a.s - b.s);
      return { lo, hi, spans, doing, logged: !!text };
    }
    function stampOf(d) {
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
    }
    function totals({ spans, doing }) {
      const active = union(spans), inDoing = union(doing);
      const sum = (xs) => xs.reduce((t, x) => t + x.e - x.s, 0);
      const both = overlapMs(active, inDoing);
      return { active: sum(active), doing: sum(inDoing), idleDoing: sum(inDoing) - both, untracked: sum(active) - both };
    }
    function byApp(spans) {
      const apps = /* @__PURE__ */ new Map();
      for (const x of spans) {
        const a = apps.get(x.app) || { ms: 0, titles: /* @__PURE__ */ new Map() };
        a.ms += x.e - x.s;
        const t = x.title || x.url || "";
        if (t) a.titles.set(t, (a.titles.get(t) || 0) + x.e - x.s);
        apps.set(x.app, a);
      }
      return [...apps.entries()].sort((a, b) => b[1].ms - a[1].ms).map(([app2, a]) => ({ app: app2, ms: a.ms, top: [...a.titles.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || "" }));
    }
    async function activitySummary(plugin, dateStr, config) {
      const day = await loadDay(plugin, dateStr, config);
      if (!day.logged) return `
# ${dateStr} \u2014 no activity log (${LOG_DIR}/${dateStr}.jsonl)`;
      const t = totals(day);
      const head = `# ${dateStr} \u2014 active ${fmt(t.active)} \xB7 doing ${fmt(t.doing)} \xB7 doing without activity ${fmt(t.idleDoing)} \xB7 activity outside doing ${fmt(t.untracked)}`;
      return "\n" + [head, ...byApp(day.spans).map((r) => `${r.app}	${fmt(r.ms)}	${r.top}`)].join("\n");
    }
    function blockDate(src, ctx) {
      const m = src.match(/^\s*date:\s*(\d{8})\s*$/m);
      if (m) return m[1];
      const name = (ctx.sourcePath || "").split("/").pop();
      const d = name.match(/^(\d{8})-\d{4}/);
      return d ? d[1] : stampOf(/* @__PURE__ */ new Date());
    }
    function renderActivityBlock2(plugin, src, el, ctx) {
      const dateStr = blockDate(src, ctx);
      const config = resolveKanbanConfig(plugin, "", null);
      const root = el.createDiv({ cls: "bdb-activity" });
      const draw = async () => {
        const day = await loadDay(plugin, dateStr, config);
        root.empty();
        const t = totals(day);
        const head = root.createDiv({ cls: "bdb-activity-head" });
        head.createSpan({ cls: "bdb-activity-date", text: dateStr });
        for (const [label, ms] of [["Active", t.active], ["Doing", t.doing], ["Doing, no activity", t.idleDoing], ["Activity outside Doing", t.untracked]]) {
          const stat = head.createSpan({ cls: "bdb-activity-stat" });
          stat.createSpan({ cls: "bdb-activity-stat-label", text: label });
          stat.createSpan({ cls: "bdb-activity-stat-value", text: fmt(ms) });
        }
        if (!day.logged && !day.doing.length) {
          root.createDiv({ cls: "bdb-activity-empty", text: `No activity log at ${LOG_DIR}/${dateStr}.jsonl` });
          return;
        }
        const all = [...day.spans, ...day.doing];
        const from = new Date(Math.min(...all.map((x) => x.s)));
        from.setMinutes(0, 0, 0);
        const to = new Date(Math.max(...all.map((x) => x.e)));
        if (to.getMinutes() || to.getSeconds()) to.setHours(to.getHours() + 1, 0, 0, 0);
        const hours = Math.max(1, Math.round((to - from) / 36e5));
        const px = (ms) => (ms - from.getTime()) / 36e5 * HOUR_PX;
        const grid = root.createDiv({ cls: "bdb-activity-grid" });
        grid.style.setProperty("--bdb-activity-height", `${hours * HOUR_PX}px`);
        const axis = grid.createDiv({ cls: "bdb-activity-axis" });
        for (let h = 0; h <= hours; h++) {
          const tick = axis.createDiv({ cls: "bdb-activity-tick", text: hhmm(from.getTime() + h * 36e5) });
          tick.style.setProperty("--bdb-top", `${h * HOUR_PX}px`);
        }
        const lane = (title, items, cls, label, tip, color) => {
          const col = grid.createDiv({ cls: "bdb-activity-lane" });
          col.createDiv({ cls: "bdb-activity-lane-title", text: title });
          const body = col.createDiv({ cls: "bdb-activity-lane-body" });
          for (const x of items) {
            const b = body.createDiv({ cls });
            b.style.setProperty("--bdb-top", `${px(x.s)}px`);
            b.style.setProperty("--bdb-h", `${Math.max(2, px(x.e) - px(x.s))}px`);
            if (color) b.style.setProperty("--bdb-hue", String(color(x)));
            b.setAttr("aria-label", tip(x));
            if (px(x.e) - px(x.s) >= 16) b.createSpan({ cls: "bdb-activity-block-label", text: label(x) });
          }
        };
        lane(
          "Activity",
          day.spans,
          "bdb-activity-block",
          (x) => `${x.app}${x.title ? " \xB7 " + x.title : ""}`,
          (x) => `${hhmm(x.s)}-${hhmm(x.e)} ${fmt(x.e - x.s)}
${x.app}${x.title ? "\n" + x.title : ""}${x.url ? "\n" + x.url : ""}${x.space ? "\nDesktop " + x.space : ""}`,
          (x) => hue(x.app)
        );
        lane(
          "Doing",
          day.doing,
          "bdb-activity-block bdb-activity-doing",
          (x) => x.body,
          (x) => `${hhmm(x.s)}-${hhmm(x.e)} ${fmt(x.e - x.s)}
${x.body}`
        );
        const apps = byApp(day.spans).slice(0, 8);
        if (apps.length) {
          const list = root.createDiv({ cls: "bdb-activity-apps" });
          for (const r of apps) {
            const row = list.createDiv({ cls: "bdb-activity-app" });
            const dot = row.createSpan({ cls: "bdb-activity-app-dot" });
            dot.style.setProperty("--bdb-hue", String(hue(r.app)));
            row.createSpan({ cls: "bdb-activity-app-name", text: r.app });
            row.createSpan({ cls: "bdb-activity-app-title", text: r.top });
            row.createSpan({ cls: "bdb-activity-app-time", text: fmt(r.ms) });
          }
        }
      };
      draw().catch((err) => root.setText("activity: " + err.message));
      if (dateStr === stampOf(/* @__PURE__ */ new Date())) {
        const child = new (require("obsidian")).MarkdownRenderChild(el);
        child.registerInterval(window.setInterval(() => draw().catch(() => {
        }), 6e4));
        ctx.addChild(child);
      }
    }
    module2.exports = { renderActivityBlock: renderActivityBlock2, activitySummary };
  }
});

// src/templates.js
var require_templates = __commonJS({
  "src/templates.js"(exports2, module2) {
    var { stringifyYaml, normalizePath, Modal, Setting } = require("obsidian");
    var TEMPLATE_DIR = "90-99 Obsidian Meta/Templates";
    var PROVENANCE_KEYS = ["template", "template-version"];
    function extractProps(plugin, file) {
      const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter || {};
      const { position, ...props } = fm;
      return props;
    }
    function selectProps(props) {
      return props;
    }
    function serializeTemplate(props, { name, version }) {
      const rest = { ...props };
      for (const k of PROVENANCE_KEYS) delete rest[k];
      const body = { ...rest, template: name, "template-version": version };
      return `---
${stringifyYaml(body)}---
`;
    }
    async function ensureDir(plugin, dir) {
      const norm = normalizePath(dir);
      if (!plugin.app.vault.getAbstractFileByPath(norm)) {
        await plugin.app.vault.createFolder(norm).catch(() => {
        });
      }
    }
    function templateDir(plugin) {
      let dir = plugin.settings?.templates?.dir || TEMPLATE_DIR;
      const base = plugin.app.vault.adapter?.basePath;
      if (base && dir.startsWith(base)) dir = dir.slice(base.length);
      return normalizePath(dir.replace(/^\/+/, ""));
    }
    async function writeTemplate(plugin, name, content) {
      const dir = templateDir(plugin);
      const path = normalizePath(`${dir}/${name}.md`);
      if (plugin.app.vault.getAbstractFileByPath(path)) {
        throw new Error(`template exists: ${path} (rename or delete it first)`);
      }
      await ensureDir(plugin, dir);
      await plugin.app.vault.create(path, content);
      return path;
    }
    async function saveTemplate(plugin, name) {
      const clean = String(name || "").trim();
      if (!clean) throw new Error('template name required: kb.saveTemplate("Project ABC")');
      const file = plugin.app.workspace.getActiveFile();
      if (!file) throw new Error("no active note");
      const props = selectProps(extractProps(plugin, file));
      const content = serializeTemplate(props, { name: clean, version: 1 });
      const path = await writeTemplate(plugin, clean, content);
      return `ok template -> ${path}`;
    }
    var NameModal = class extends Modal {
      constructor(app2, defaultName, onSubmit) {
        super(app2);
        this.value = defaultName || "";
        this.onSubmit = onSubmit;
        this.done = false;
      }
      onOpen() {
        this.titleEl.setText("Save properties as template");
        new Setting(this.contentEl).setName("Template name").addText((t) => {
          t.setValue(this.value).onChange((v) => {
            this.value = v;
          });
          t.inputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") this.submit();
          });
          setTimeout(() => {
            t.inputEl.focus();
            t.inputEl.select();
          }, 0);
        });
        new Setting(this.contentEl).addButton((b) => b.setButtonText("Save").setCta().onClick(() => this.submit()));
      }
      submit() {
        this.done = true;
        this.close();
        this.onSubmit(this.value.trim() || null);
      }
      onClose() {
        this.contentEl.empty();
        if (!this.done) this.onSubmit(null);
      }
    };
    async function saveTemplateCommand2(plugin) {
      const { Notice: Notice2 } = require("obsidian");
      const file = plugin.app.workspace.getActiveFile();
      if (!file) {
        new Notice2("No active note");
        return;
      }
      new NameModal(plugin.app, file.basename, async (name) => {
        if (!name) return;
        try {
          new Notice2(await saveTemplate(plugin, name));
        } catch (e) {
          new Notice2("Template failed: " + e.message);
        }
      }).open();
    }
    module2.exports = {
      saveTemplate,
      saveTemplateCommand: saveTemplateCommand2,
      extractProps,
      selectProps,
      serializeTemplate,
      writeTemplate,
      NameModal,
      TEMPLATE_DIR,
      PROVENANCE_KEYS
    };
  }
});

// src/api.js
var require_api = __commonJS({
  "src/api.js"(exports2, module2) {
    var {
      scanKanbanTasks,
      moveCard: moveCard2,
      sweepColumn,
      setRankLine,
      setDesktopLine,
      setEstLine,
      taskColumn,
      parseKanbanConfig: parseKanbanConfig2,
      stampToDate,
      cleanText,
      stampNow,
      stampWrite,
      TASK_RE: TASK_RE2,
      TASK_END_RE: TASK_END_RE2,
      TAGLINE_RE,
      COLOR_RE,
      HIST_RE: HIST_RE2,
      EI_HIST_RE
    } = require_kanban();
    var { collectDayTasks } = require_report();
    var { backdateOk, stints, planned, adhoc, birthMs, desktopRef, chrono, stampMs, MULL_MS } = require_activity();
    var { activitySummary } = require_activity2();
    var { saveTemplate } = require_templates();
    var { openFileAtLine } = require_render();
    var DEFAULT_COLS = "columns: Backlog~, Todo, Doing!, Parked~, Done=x, Cancelled=-";
    var HABIT_COLS = "columns: Idle~, Doing!";
    var SCOPE_NOTE = "90-99 Obsidian Meta/Kanban Scopes.md";
    function makeConfig2(opts = {}, plugin) {
      const defaults = plugin?.settings?.kanban || {};
      const columns = String(defaults.columns || DEFAULT_COLS.replace("columns: ", "")).split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean).join(", ");
      const lines = ["columns: " + columns];
      const paths2 = opts.paths || defaults.paths;
      if (paths2) lines.push("paths: " + paths2);
      return parseKanbanConfig2(lines.join("\n"));
    }
    async function cardHistory(app2, file, line) {
      const lines = (await app2.vault.read(file)).split(/\r?\n/);
      const base = (lines[line] || "").match(/^\s*/)[0].length;
      const out = [];
      for (let i = line + 1; i < lines.length; i++) {
        if (lines[i].trim() && lines[i].match(/^\s*/)[0].length <= base) break;
        const h = lines[i].match(HIST_RE2);
        if (h) out.push({ stamp: h[1].replace(/\D/g, ""), to: h[3] });
      }
      return out;
    }
    function makeHabitConfig(opts = {}) {
      const lines = [HABIT_COLS];
      if (opts.paths) lines.push("paths: " + opts.paths);
      return parseKanbanConfig2(lines.join("\n"));
    }
    async function habitCards(plugin, opts = {}) {
      const cards = await scanKanbanTasks(plugin.app, makeHabitConfig(opts));
      const out = [];
      for (const [colKey, list] of cards) {
        for (const card of list) {
          const fm = plugin.app.metadataCache.getFileCache(card.file)?.frontmatter || {};
          if (fm.metric == null) continue;
          out.push({ card, colKey, fm });
        }
      }
      return out;
    }
    function spanMs(s) {
      if (!s) return null;
      const m = String(s).trim().match(/^(\d+)\s*([hdwmy])$/i);
      if (!m) return null;
      const n = +m[1], unit = { h: 36e5, d: 864e5, w: 6048e5, m: 2592e6, y: 31536e6 };
      return n * unit[m[2].toLowerCase()];
    }
    function hasTask(app2, f) {
      const li = app2.metadataCache.getFileCache(f)?.listItems;
      return !!li && li.some((it) => it.task != null);
    }
    function fileNameMs(f) {
      const stamp = fileNameStamp(f);
      return stamp ? stampToDate(stamp).getTime() : null;
    }
    function fileNameStamp(f) {
      const m = f.basename.match(/^(\d{8})(?:-(\d{4}))?/);
      return m ? m[1] + (m[2] || "0000") : null;
    }
    async function activeWithin(app2, f, cut) {
      const nm = fileNameMs(f);
      if (nm != null && nm >= cut) return true;
      let latest = nm || 0;
      const re = /%%\s?kb (\d{8}-?\d{4}) /g;
      let m;
      for (const line of (await app2.vault.cachedRead(f)).split(/\r?\n/)) {
        if (m = re.exec(line)) {
          const t = stampToDate(m[1]).getTime();
          if (t > latest) latest = t;
        }
        re.lastIndex = 0;
      }
      return latest >= cut;
    }
    async function fmFiles(app2, paths2, since, tasks) {
      const prefixes = paths2 ? String(paths2).split(",").map((s) => s.trim()).filter(Boolean) : [];
      const span = spanMs(since);
      const cut = span == null ? null : Date.now() - span;
      const list = app2.vault.getMarkdownFiles().filter((f) => !prefixes.length || prefixes.some((p) => f.path.startsWith(p))).filter((f) => !tasks || hasTask(app2, f));
      if (cut == null) return list;
      const out = [];
      for (const f of list) if (await activeWithin(app2, f, cut)) out.push(f);
      return out;
    }
    function unwrap(v) {
      if (v == null) return "";
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      if (typeof v === "object") {
        if (typeof v.toISOString === "function") return v.toISOString().slice(0, 10);
        try {
          return JSON.stringify(v);
        } catch {
          return String(v);
        }
      }
      const s = String(v).trim();
      const m = s.match(/^\[\[([^\]]+)\]\]$/);
      return (m ? m[1].split("|")[0] : s).trim();
    }
    function fmVals(fm, key) {
      if (!fm || !(key in fm)) return null;
      const raw = fm[key];
      return (Array.isArray(raw) ? raw : [raw]).map(unwrap);
    }
    function matchVal(vals, want, contains) {
      const w = unwrap(want).toLowerCase();
      return vals.some((v) => {
        const x = v.toLowerCase();
        return contains ? x.includes(w) : x === w;
      });
    }
    function fmSuffix(app2, path, keys) {
      if (!keys) return "";
      const fm = app2.metadataCache.getCache(path)?.frontmatter;
      const list = String(keys).split(",").map((s) => s.trim()).filter(Boolean);
      if (!list.length) return "";
      return "	" + list.map((k) => `${k}=${(fmVals(fm, k) || []).join("|") || "\xB7"}`).join("; ");
    }
    function scopeRules(app2, path = SCOPE_NOTE) {
      const file = app2.vault.getAbstractFileByPath(path);
      return file ? app2.metadataCache.getFileCache(file)?.frontmatter || {} : {};
    }
    function scopeOrgInactive(rules, org) {
      return (fmVals(rules, "kanban-inactive-orgs") || []).some((x) => x.toLowerCase() === org.toLowerCase());
    }
    function scopeProjectActive(rules, org, project) {
      const raw = rules["kanban-scope-statuses"];
      const entries = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
      const override = entries.find((item) => item && typeof item === "object" && unwrap(item.org).toLowerCase() === org.toLowerCase() && unwrap(item.project).toLowerCase() === project.toLowerCase());
      if (override && typeof override.active === "boolean") return override.active;
      const has = (key, value) => (fmVals(rules, key) || []).some((x) => x.toLowerCase() === value.toLowerCase());
      return !has("kanban-inactive-projects", project) && !has("kanban-inactive-scopes", `${org} / ${project}`);
    }
    function scopeInactive(rules, org, project) {
      return scopeOrgInactive(rules, org) || !scopeProjectActive(rules, org, project);
    }
    async function scopeRows(app2, opts = {}) {
      const scopeNote = opts.scopeNote || SCOPE_NOTE;
      const rules = scopeRules(app2, scopeNote);
      const files = await fmFiles(app2, opts.paths, opts.since, opts.tasks === true);
      const counts = /* @__PURE__ */ new Map();
      for (const file of files) {
        const fm = app2.metadataCache.getFileCache(file)?.frontmatter;
        for (const org of fmVals(fm, "org") || []) for (const project of fmVals(fm, "projects") || []) {
          const key = `${org.toLowerCase()}	${project.toLowerCase()}`;
          const row = counts.get(key) || { org, project, count: 0 };
          row.count++;
          counts.set(key, row);
        }
      }
      const query = String(opts.query || "").toLowerCase();
      const allRows = [...counts].map(([, { org, project, count }]) => {
        return { org, project, count, status: scopeInactive(rules, org, project) ? "inactive" : "active" };
      }).sort((a, b) => a.org.localeCompare(b.org) || a.project.localeCompare(b.project));
      return allRows.filter((row) => (opts.all || row.status === "active") && (!query || `${row.org} ${row.project}`.toLowerCase().includes(query))).sort((a, b) => b.count - a.count || a.org.localeCompare(b.org) || a.project.localeCompare(b.project));
    }
    async function setScopeStatus(app2, { org, project, active }, path = SCOPE_NOTE) {
      const file = app2.vault.getAbstractFileByPath(path);
      if (!file) throw new Error(`scope registry not found: ${path}`);
      const rows = await scopeRows(app2, { all: true, scopeNote: path });
      const members = rows.filter((row) => row.org.toLowerCase() === String(org).toLowerCase());
      await app2.fileManager.processFrontMatter(file, (fm) => {
        const inactiveOrgs = fm["kanban-inactive-orgs"];
        const inactive = inactiveOrgs == null ? [] : Array.isArray(inactiveOrgs) ? inactiveOrgs : [inactiveOrgs];
        const activeOrgs = inactive.filter((value) => unwrap(value).toLowerCase() !== org.toLowerCase());
        if (!project) {
          if (!active) activeOrgs.push(`[[${org}]]`);
          fm["kanban-inactive-orgs"] = activeOrgs;
        }
        const raw = fm["kanban-scope-statuses"];
        const entries = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
        const affected = project ? members.filter((row) => row.project.toLowerCase() === project.toLowerCase()) : members;
        const affectedNames = new Set(affected.map((row) => row.project.toLowerCase()));
        const kept = entries.filter((item) => !item || typeof item !== "object" || unwrap(item.org).toLowerCase() !== org.toLowerCase() || !affectedNames.has(unwrap(item.project).toLowerCase()));
        for (const row of affected) kept.push({
          org: row.org,
          project: row.project,
          active: !!active
        });
        if (project && active) fm["kanban-inactive-orgs"] = activeOrgs;
        if (project && !active && !members.some((row) => row.project.toLowerCase() !== project.toLowerCase() && row.status === "active")) {
          fm["kanban-inactive-orgs"] = [...activeOrgs, `[[${org}]]`];
          for (const row of members) {
            const entry = kept.find((item) => item && typeof item === "object" && unwrap(item.org).toLowerCase() === org.toLowerCase() && unwrap(item.project).toLowerCase() === row.project.toLowerCase());
            if (entry) entry.active = false;
          }
        }
        fm["kanban-scope-statuses"] = kept;
      });
      return `ok ${org}${project ? ` / ${project}` : ""}: ${active ? "active" : "inactive"}`;
    }
    function taskNote({ text, org, project, col, stamp }) {
      const body = String(text).replace(/\s+/g, " ").trim();
      return `---
org:
  - ${JSON.stringify(`[[${org}]]`)}
projects:
  - ${JSON.stringify(`[[${project}]]`)}
---

- [ ] ${body} #kb/${col.toLowerCase()}
  %% kb ${stamp} Backlog > ${col} %%
`;
    }
    function relAge(iso) {
      if (!iso) return "?";
      const ms = Date.now() - new Date(iso).getTime();
      const h = ms / 36e5;
      if (h < 1) return Math.max(0, Math.round(ms / 6e4)) + "m";
      if (h < 24) return Math.round(h) + "h";
      return Math.round(h / 24) + "d";
    }
    function hhmm(stamp) {
      const d = stampToDate(stamp);
      return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    }
    function dur(ms) {
      const m = Math.round(ms / 6e4);
      if (m < 60) return m + "m";
      return Math.floor(m / 60) + "h" + (m % 60 ? " " + m % 60 + "m" : "");
    }
    function durCompact(ms) {
      const m = Math.round(ms / 6e4);
      if (m < 60) return m + "m";
      return Math.floor(m / 60) + "h" + (m % 60 ? m % 60 + "m" : "");
    }
    function pct(n, d) {
      if (!d) return "0%";
      const v = n * 100 / d;
      const decimals = v < 10 && !Number.isInteger(v) ? 1 : 0;
      return (Math.round(v * 10) / 10).toFixed(decimals) + "%";
    }
    function endOfDayMs(ms) {
      const d = new Date(ms);
      d.setHours(23, 59, 59, 999);
      return d.getTime();
    }
    function unionMs(ivals) {
      if (!ivals.length) return 0;
      const s = ivals.slice().sort((a, b) => a[0] - b[0]);
      let total = 0, cs = s[0][0], ce = s[0][1];
      for (let i = 1; i < s.length; i++) {
        const [a, b] = s[i];
        if (a <= ce) {
          if (b > ce) ce = b;
        } else {
          total += ce - cs;
          cs = a;
          ce = b;
        }
      }
      return total + (ce - cs);
    }
    function ymd(d) {
      return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    }
    function resolveDates(a, b, c) {
      const toStr = (x) => String(x).replace(/[^0-9]/g, "").slice(0, 8);
      if (a && typeof a === "object") {
        const opts = a, n = Math.max(1, opts.days || 1), out = [];
        for (let i = n - 1; i >= 0; i--) {
          const d = /* @__PURE__ */ new Date();
          d.setDate(d.getDate() - i);
          out.push(ymd(d));
        }
        return { dates: out, opts };
      }
      const from = toStr(a);
      if (b != null && typeof b !== "object") {
        const to = toStr(b), out = [];
        const mk = (s) => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
        for (let d = mk(from); ymd(d) <= to; d.setDate(d.getDate() + 1)) out.push(ymd(d));
        return { dates: out, opts: c || {} };
      }
      return { dates: [from], opts: b || {} };
    }
    function hhmmMs(ms) {
      const d = new Date(ms);
      return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    }
    function hhmmBare(ms) {
      const d = new Date(ms);
      return String(d.getHours()).padStart(2, "0") + String(d.getMinutes()).padStart(2, "0");
    }
    function colSegments(history2, want, dateStr) {
      const ordered = chrono(history2);
      const y = +dateStr.slice(0, 4), mo = +dateStr.slice(4, 6) - 1, d = +dateStr.slice(6, 8);
      const dayEnd = new Date(y, mo, d, 23, 59, 59).getTime();
      const segs = [];
      let start = null;
      for (const h of ordered) {
        if (h.to.toLowerCase() === want) start = stampToDate(h.stamp).getTime();
        else if (start != null) {
          segs.push([start, stampToDate(h.stamp).getTime(), false]);
          start = null;
        }
      }
      if (start != null) segs.push([start, dayEnd, true]);
      const parts = segs.map(([s, e, open]) => `(${hhmmMs(s)}->${hhmmMs(e)}${open ? "~" : ""} :: ${dur(e - s)})`);
      const total = segs.reduce((a, [s, e]) => a + (e - s), 0);
      return parts.join(", ") + " = " + dur(total);
    }
    function cardJson(card, col) {
      const last = card.history.slice().sort((a, b) => b.stamp.localeCompare(a.stamp))[0] || null;
      const movedAt = last ? stampToDate(last.stamp).getTime() : 0;
      const recent = Math.max(fileNameMs(card.file) || 0, movedAt) || null;
      return {
        file: card.file.path,
        line: card.line,
        body: card.body,
        col: col.name,
        tags: card.tags,
        rank: card.rank ?? null,
        desktop: card.desktop ?? null,
        since: recent ? new Date(recent).toISOString() : null,
        recent
      };
    }
    function filterSince(rows, since, now = Date.now()) {
      const span = spanMs(since);
      if (span == null) return rows;
      const cut = now - span;
      return rows.filter((row) => row.recent != null && row.recent >= cut);
    }
    function buildApi2(plugin) {
      return {
        // Live tasks (non-terminal). Paused cols (e.g. Backlog~) are excluded by default,
        // but INCLUDED when explicitly requested via opts.col or opts.includePaused.
        // Returns tab-lines: col<TAB>file:line<TAB>body<TAB>age[<TAB>timestamp]
        // opts: { paths, col, tag, staleDays, limit, includePaused, timestamps }
        async active(opts = {}) {
          const config = makeConfig2(opts, plugin);
          const byCol = await scanKanbanTasks(plugin.app, config);
          const keepPaused = !!opts.col || !!opts.includePaused;
          let rows = config.columns.filter((c) => !c.state && (keepPaused || !c.paused)).flatMap((col) => (byCol.get(col.key) || []).map((card) => cardJson(card, col)));
          if (opts.col) rows = rows.filter((r) => r.col.toLowerCase() === String(opts.col).toLowerCase());
          if (opts.tag) {
            const t = String(opts.tag).toLowerCase();
            rows = rows.filter((r) => r.tags.some((x) => x.toLowerCase().includes(t)) || r.body.toLowerCase().includes(t));
          }
          if (opts.staleDays) {
            const cut = Date.now() - opts.staleDays * 864e5;
            rows = rows.filter((r) => r.since && new Date(r.since).getTime() <= cut);
          }
          rows = filterSince(rows, opts.since);
          if (opts.limit) rows = rows.slice(0, opts.limit);
          return "\n" + rows.map((r) => `${r.col}	${r.file}:${r.line}	${r.body}	${relAge(r.since)}${opts.timestamps ? `	${r.since || ""}` : ""}${opts.rank ? `	${r.rank ?? ""}` : ""}${opts.desktop ? `	${r.desktop ?? ""}` : ""}${fmSuffix(plugin.app, r.file, opts.fm)}`).join("\n");
        },
        // Every configured column and its tasks. The `full` column is unfiltered;
        // other columns only include tasks seen within `hours` (default 24).
        async board(opts = {}) {
          const config = makeConfig2(opts, plugin);
          const byCol = await scanKanbanTasks(plugin.app, config);
          const full = String(opts.full || "Doing").toLowerCase();
          const since = `${Math.max(1, Number(opts.hours) || 24)}h`;
          const lines = [];
          for (const col of config.columns) {
            lines.push(`@column	${col.name}`);
            let rows = (byCol.get(col.key) || []).map((card) => cardJson(card, col));
            if (col.name.toLowerCase() !== full) rows = filterSince(rows, since);
            lines.push(...rows.map((r) => `${r.col}	${r.file}:${r.line}	${r.body}	${relAge(r.since)}${opts.timestamps ? `	${r.since || ""}` : ""}`));
          }
          return "\n" + lines.join("\n");
        },
        async openTask(filePath, line) {
          const file = plugin.app.vault.getAbstractFileByPath(filePath);
          if (!file) throw new Error("file not found: " + filePath);
          openFileAtLine(plugin.app, file, line, false);
          return `ok opened ${filePath}:${line}`;
        },
        // Freeform notes for one task: every line between the task and the next task
        // line (any indent) or `---` separator, minus the metadata block
        // (tag/color/%%kb%%/%%ei%%).
        // arg = "file:line" (the file:line other reads emit) or (filePath, line).
        // Returns the trimmed prose, "" when the task has no notes.
        async note(arg, line) {
          let path = arg;
          if (line == null && typeof arg === "string" && arg.includes(":")) {
            const i = arg.lastIndexOf(":");
            path = arg.slice(0, i);
            line = +arg.slice(i + 1);
          }
          const file = plugin.app.vault.getAbstractFileByPath(path);
          if (!file) throw new Error("file not found: " + path);
          const lines = (await plugin.app.vault.cachedRead(file)).split(/\r?\n/);
          if (!TASK_RE2.test(lines[line] || "")) throw new Error(`no task at ${path}:${line}`);
          const meta = (t) => TAGLINE_RE.test(t) || COLOR_RE.test(t) || HIST_RE2.test(t) || EI_HIST_RE.test(t);
          const out = [];
          for (let i = line + 1; i < lines.length && !TASK_END_RE2.test(lines[i]); i++) {
            if (!meta(lines[i])) out.push(lines[i]);
          }
          return "\n" + out.join("\n").replace(/^\n+|\n+$/g, "");
        },
        // Tasks moved to a terminal column on a date — "what I did"
        // Tab-lines: col<TAB>file:line<TAB>body<TAB>HH:MM
        async getDone(date, opts = {}) {
          const dateStr = String(date).replace(/[^0-9]/g, "").slice(0, 8);
          const want = opts.col && String(opts.col).toLowerCase();
          const config = makeConfig2(opts);
          const byCol = await scanKanbanTasks(plugin.app, config);
          const rows = config.columns.filter((c) => c.state && (!want || c.name.toLowerCase() === want)).flatMap(
            (col) => (byCol.get(col.key) || []).map((card) => ({ card, move: card.history.find((h) => h.stamp.startsWith(dateStr) && h.to === col.name) })).filter(({ move }) => move).map(({ card, move }) => `${col.name}	${card.file.path}:${card.line}	${card.body}	${hhmm(move.stamp)}${fmSuffix(plugin.app, card.file.path, opts.fm)}`)
          );
          return "\n" + rows.join("\n");
        },
        // Full move timeline for a day — "how the day flowed"
        // Tab-lines: file:line<TAB>body<TAB>HH:MM from>to  HH:MM from>to ...
        async getReport(a, b, c) {
          const { dates, opts } = resolveDates(a, b, c);
          const want = opts.col && String(opts.col).toLowerCase();
          const config = makeConfig2(opts);
          const multi = dates.length > 1;
          const out = [];
          for (const dateStr of dates) {
            let tasks = await collectDayTasks(plugin.app, dateStr, config.paths);
            if (want) tasks = tasks.filter((t) => t.history.some((h) => h.to.toLowerCase() === want));
            const rows = tasks.map((t) => {
              const suf = fmSuffix(plugin.app, t.file.path, opts.fm);
              if (want) return `${t.file.path}:${t.line}	${t.body}	${colSegments(t.history, want, dateStr)}${suf}`;
              const moves = t.history.map((h) => `${hhmm(h.stamp)} ${h.from || "\xB7"}>${h.to}`).join("  ");
              return `${t.file.path}:${t.line}	${t.body}	${moves}${suf}`;
            });
            if (multi) out.push(`== ${dateStr} ==`, ...rows.length ? rows : ["(none)"]);
            else out.push(...rows);
          }
          return "\n" + out.join("\n");
        },
        // Roll up terminal-column moves (i.e. "done") over a date range, grouped by a
        // frontmatter key. The single command behind "what did I ship, by project".
        // Arg forms mirror getReport: (date) | (from,to) | ({days:N, ...opts}).
        // opts: { by (fm key, default "projects"), col (terminal-col filter), paths,
        //         sample (max sample bodies per group, default 3) }
        // Lines: groupVal<TAB>doneCount<TAB>sample, bodies (capped)
        async summary(a, b, c) {
          const { dates, opts } = resolveDates(a, b, c);
          const by = opts.by || "projects";
          const cap = opts.sample || 3;
          const want = opts.col && String(opts.col).toLowerCase();
          const config = makeConfig2(opts);
          const byCol = await scanKanbanTasks(plugin.app, config);
          const dateSet = new Set(dates);
          const groups = /* @__PURE__ */ new Map();
          for (const col of config.columns) {
            if (!col.state || want && col.name.toLowerCase() !== want) continue;
            for (const card of byCol.get(col.key) || []) {
              if (!card.history.some((h) => h.to === col.name && dateSet.has(h.stamp.slice(0, 8)))) continue;
              const vals = fmVals(plugin.app.metadataCache.getCache(card.file.path)?.frontmatter, by);
              for (const g of vals && vals.length ? vals : ["(none)"]) {
                const e = groups.get(g) || { n: 0, bodies: [] };
                e.n++;
                if (e.bodies.length < cap) e.bodies.push(cleanText(card.body));
                groups.set(g, e);
              }
            }
          }
          const total = [...groups.values()].reduce((a2, e) => a2 + e.n, 0);
          const rows = [...groups.entries()].sort((a2, b2) => b2[1].n - a2[1].n).map(([g, e]) => `${g}	${e.n}	${e.bodies.join(", ")}`);
          const span = dates.length > 1 ? `${dates[0]}..${dates[dates.length - 1]}` : dates[0];
          return `
# done by ${by} \u2014 ${span} \u2014 ${total} cards
` + rows.join("\n");
        },
        // Actual TIME cards spent in a column (default Doing) over a date range, grouped by a
        // frontmatter key — the "hours per project" measure (vs summary's card COUNT).
        // Walks each card's full history, pairs enter>exit for the column, clips overlap to the
        // window; an unclosed span counts up to now. Arg forms mirror getReport.
        // opts: { by (default "projects"), col (default "Doing"), paths, sample (default 3) }
        // Lines: groupVal<TAB>Xh Ym<TAB>N cards<TAB>sample, bodies
        async time(a, b, c) {
          const { dates, opts } = resolveDates(a, b, c);
          const by = opts.by || "projects";
          const want = String(opts.col || "Doing").toLowerCase();
          const cap = opts.sample || 3;
          const byCol = await scanKanbanTasks(plugin.app, makeConfig2(opts));
          const mk = (s) => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
          const lo = mk(dates[0]).getTime();
          const hiD = mk(dates[dates.length - 1]);
          hiD.setHours(23, 59, 59, 999);
          const hi = hiD.getTime();
          const groups = /* @__PURE__ */ new Map();
          const allIvals = [];
          for (const [key, list] of byCol) {
            for (const card of list) {
              const ordered = chrono(card.history);
              const ivals = [];
              for (let i = 0; i < ordered.length; i++) {
                if (ordered[i].to.toLowerCase() !== want) continue;
                if (!ordered[i + 1] && key !== want) continue;
                const s = stampToDate(ordered[i].stamp).getTime();
                const e = ordered[i + 1] ? stampToDate(ordered[i + 1].stamp).getTime() : endOfDayMs(s);
                const cs = Math.max(s, lo), ce = Math.min(e, hi);
                if (ce > cs) ivals.push([cs, ce]);
              }
              if (!ivals.length) continue;
              allIvals.push(...ivals);
              const vals = fmVals(plugin.app.metadataCache.getCache(card.file.path)?.frontmatter, by);
              for (const g of vals && vals.length ? vals : ["(none)"]) {
                const e = groups.get(g) || { ivals: [], cards: /* @__PURE__ */ new Set(), bodies: [] };
                e.ivals.push(...ivals);
                e.cards.add(card.file.path + ":" + card.line);
                if (e.bodies.length < cap) e.bodies.push(cleanText(card.body));
                groups.set(g, e);
              }
            }
          }
          const span = dates.length > 1 ? `${dates[0]}..${dates[dates.length - 1]}` : dates[0];
          const rows = [...groups.entries()].map(([g, e]) => [g, unionMs(e.ivals), e]).sort((a2, b2) => b2[1] - a2[1]).map(([g, ms, e]) => `${g}	${dur(ms)}	${e.cards.size} cards	${e.bodies.join(", ")}`);
          return `
# ${want} time (union) by ${by} \u2014 ${span} \u2014 ${dur(unionMs(allIvals))} total
` + rows.join("\n");
        },
        // Chronicle of time spent in a column (default Doing), sorted by stint start.
        // Lines: HHMM:HHMM[~]<TAB>dur<TAB>body[<TAB>file:line with opts.refs]
        async chronicle(a, b, c) {
          const { dates, opts } = resolveDates(a, b, c);
          const want = String(opts.col || "Doing").toLowerCase();
          const byCol = await scanKanbanTasks(plugin.app, makeConfig2(opts));
          const multi = dates.length > 1;
          const out = [];
          let grandTracked = 0;
          let grandElapsed = 0;
          for (const dateStr of dates) {
            const lo = new Date(+dateStr.slice(0, 4), +dateStr.slice(4, 6) - 1, +dateStr.slice(6, 8)).getTime();
            const hi = endOfDayMs(lo);
            const today = ymd(/* @__PURE__ */ new Date()) === dateStr;
            const elapsed = Math.max(0, (today ? Date.now() : hi) - lo);
            const segs = [];
            const openEnd = (s) => today ? Date.now() : endOfDayMs(s);
            for (const [key, list] of byCol) for (const card of list) {
              for (const x of stints(card.history, want, lo, hi, openEnd, key === want)) {
                segs.push({ ...x, open: x.open && today, body: cleanText(card.body), ref: `${card.file.path}:${card.line}` });
              }
            }
            const tracked = segs.reduce((sum, x) => sum + (x.e - x.s), 0);
            grandTracked += tracked;
            grandElapsed += elapsed;
            const rows = segs.sort((a2, b2) => a2.s - b2.s).map((x) => `${hhmmBare(x.s)}:${hhmmBare(x.e)}${x.open ? "~" : ""}	${durCompact(x.e - x.s)}	${x.body}${opts.refs ? `	${x.ref}` : ""}`);
            const footer = `TOTAL	${dur(tracked)}	${pct(tracked, elapsed)} elapsed`;
            if (multi) out.push(`== ${dateStr} ==`, ...rows.length ? rows : ["(none)"], footer);
            else out.push(...rows, footer);
          }
          if (multi) {
            out.push(`== total ==`, `TOTAL	${dur(grandTracked)}	${pct(grandTracked, grandElapsed)} elapsed`);
          }
          return "\n" + out.join("\n");
        },
        // 6 Reports input: every card with a Doing stint in the range or a terminal move in the range.
        // opts.mull = mulling threshold in minutes (default 60). Times are epoch seconds.
        // Lines: ref<TAB>title<TAB>orgs<TAB>projects<TAB>desktop<TAB>adhoc 1|0|-<TAB>done|-<TAB>lifetime Doing s<TAB>s-e,s-e
        async reportCards(a, b, c) {
          const { dates, opts } = resolveDates(a, b, c);
          const mk = (s) => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)).getTime();
          const lo = mk(dates[0]), hi = endOfDayMs(mk(dates[dates.length - 1]));
          const mull = (opts.mull ?? MULL_MS / 6e4) * 6e4;
          const now = Date.now();
          const openEnd = (s) => Math.min(now, endOfDayMs(s));
          const config = makeConfig2(opts, plugin);
          const done = config.columns.filter((c2) => c2.state);
          const terminal = new Set(done.map((c2) => c2.name.toLowerCase())), terminalKeys = new Set(done.map((c2) => c2.key));
          const byCol = await scanKanbanTasks(plugin.app, config);
          const sec = (ms) => Math.round(ms / 1e3);
          const rows = [];
          for (const [key, list] of byCol) for (const card of list) {
            const inRange = stints(card.history, "doing", lo, hi, openEnd, key === "doing");
            const last = chrono(card.history).pop();
            const doneMs = last && terminal.has(last.to.toLowerCase()) && terminalKeys.has(key) ? stampMs(last.stamp) : null;
            const doneIn = doneMs != null && doneMs >= lo && doneMs <= hi;
            if (!inRange.length && !doneIn) continue;
            const life = stints(card.history, "doing", 0, now, openEnd, key === "doing").reduce((t, x) => t + x.e - x.s, 0);
            const fm = plugin.app.metadataCache.getCache(card.file.path)?.frontmatter;
            const ah = adhoc(card.history, birthMs(card.file.name), mull);
            rows.push([
              `${card.file.path}:${card.line}`,
              cleanText(card.body),
              (fmVals(fm, "org") || []).join("|"),
              (fmVals(fm, "projects") || []).join("|"),
              card.desktop ?? "",
              ah == null ? "-" : ah ? "1" : "0",
              doneIn ? String(sec(doneMs)) : "-",
              String(sec(life)),
              inRange.map((x) => `${sec(x.s)}-${sec(x.e)}`).join(",")
            ].join("	"));
          }
          return "\n" + rows.join("\n");
        },
        // 5.1 Planned vs unplanned time in a column (default Doing) over a date range.
        // Planned = the card sat in Todo before its first Doing entry. Arg forms mirror getReport.
        // Lines: header with both totals, then planned|unplanned<TAB>dur<TAB>file:line<TAB>body
        async planned(a, b, c) {
          const { dates, opts } = resolveDates(a, b, c);
          const want = String(opts.col || "Doing").toLowerCase();
          const mk = (s) => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)).getTime();
          const lo = mk(dates[0]), hi = endOfDayMs(mk(dates[dates.length - 1]));
          const openEnd = (s) => Math.min(Date.now(), endOfDayMs(s));
          const byCol = await scanKanbanTasks(plugin.app, makeConfig2(opts, plugin));
          const rows = [];
          const sum = { planned: 0, unplanned: 0 };
          for (const [key, list] of byCol) for (const card of list) {
            const ms = stints(card.history, want, lo, hi, openEnd, key === want).reduce((t, x) => t + x.e - x.s, 0);
            if (!ms) continue;
            const kind = planned(card.history, birthMs(card.file.name), (opts.mull ?? 60) * 6e4) ? "planned" : "unplanned";
            sum[kind] += ms;
            rows.push([kind, ms, `${card.file.path}:${card.line}`, cleanText(card.body)]);
          }
          rows.sort((x, y) => y[1] - x[1]);
          const span = dates.length > 1 ? `${dates[0]}..${dates[dates.length - 1]}` : dates[0];
          const total = sum.planned + sum.unplanned;
          return `
# ${want} time ${span} \u2014 planned ${dur(sum.planned)} (${pct(sum.planned, total)}) \xB7 unplanned ${dur(sum.unplanned)} (${pct(sum.unplanned, total)})
` + rows.map(([k, ms, ref, body]) => `${k}	${dur(ms)}	${ref}	${body}`).join("\n");
        },
        // 3 One day's captured activity against Doing stints. date YYYYMMDD (default today).
        // Lines: totals, then app<TAB>dur<TAB>top title, longest first.
        async activity(date) {
          return activitySummary(plugin, String(date || ymd(/* @__PURE__ */ new Date())), makeConfig2({}, plugin));
        },
        // Organization/project combinations observed in note properties.
        // Default excludes combinations disabled by the scope registry note.
        async scopes(opts = {}) {
          const rows = await scopeRows(plugin.app, opts);
          return "\n" + rows.map((row) => `${row.org}	${row.project}	${row.count}	${row.status}`).join("\n");
        },
        async scopeCatalog() {
          const rows = await scopeRows(plugin.app, { all: true });
          const groups = /* @__PURE__ */ new Map();
          for (const row of rows) {
            if (!row.org || !row.project) continue;
            if (!groups.has(row.org)) groups.set(row.org, { org: row.org, active: false, projects: [] });
            const group = groups.get(row.org);
            const project = {
              name: row.project,
              active: row.status === "active",
              count: row.count
            };
            group.projects.push(project);
            group.active ||= project.active;
          }
          return [...groups.values()].sort((a, b) => a.org.localeCompare(b.org));
        },
        scopeFrontmatterActive(frontmatter) {
          const orgs = fmVals(frontmatter, "org") || [];
          const projects = fmVals(frontmatter, "projects") || [];
          if (!orgs.length || !projects.length) return true;
          const rules = scopeRules(plugin.app);
          return orgs.some((org) => projects.some((project) => !scopeInactive(rules, org, project)));
        },
        async setScopeStatus(opts = {}) {
          return setScopeStatus(plugin.app, opts);
        },
        // Create one task note after validating its active organization/project combination.
        async createTask(opts = {}) {
          const text = String(opts.text || "").replace(/\s+/g, " ").trim();
          if (!text) throw new Error("text is required");
          const rows = await scopeRows(plugin.app, { all: true, scopeNote: opts.scopeNote });
          const row = rows.find((x) => x.org.toLowerCase() === String(opts.org || "").toLowerCase() && x.project.toLowerCase() === String(opts.project || "").toLowerCase());
          if (!row) throw new Error(`unknown scope: ${opts.org || "?"} / ${opts.project || "?"}`);
          if (row.status === "inactive") throw new Error(`inactive scope: ${row.org} / ${row.project}`);
          const config = makeConfig2({}, plugin);
          const col = config.columns.find((x) => x.name.toLowerCase() === String(opts.col || "Backlog").toLowerCase());
          if (!col) throw new Error("unknown col: " + opts.col);
          let at = /* @__PURE__ */ new Date(), filePath;
          for (let i = 0; i < 60; i++, at = new Date(at.getTime() + 6e4)) {
            filePath = `${stampWrite(stampNow(at))}.md`;
            if (!plugin.app.vault.getAbstractFileByPath(filePath)) break;
          }
          if (plugin.app.vault.getAbstractFileByPath(filePath)) throw new Error("no free daily-note timestamp");
          const stamp = stampWrite(stampNow());
          await plugin.app.vault.create(filePath, taskNote({ text, org: row.org, project: row.project, col: col.name, stamp }));
          return `${filePath}	7	${row.org}	${row.project}	${col.name}	${text}`;
        },
        // List available methods.
        help() {
          return "\n" + [
            "active(opts?)            live tasks on plate; opts: paths,col,tag,staleDays,limit,timestamps",
            "getDone(date,opts?)      tasks moved to terminal col on a date",
            'note("file:line")        freeform notes under a task (prose to next task or ---)',
            "getReport(...)           move timeline; day | from,to | {days:N}",
            "chronicle(...)           day chronicle of Doing stints; day | from,to | {days:N}",
            "summary(...)             done counts grouped by fm key; opts: by,col,sample,paths",
            '   note: active/getDone/getReport take opts.fm="projects,org" to append fm cols',
            "plate(project,opts?)     a project's live tasks (incl Backlog); opts: prop,col,paths,since,limit",
            "board(opts?)             configured columns + tasks; opts: hours (24), full (Doing), paths, timestamps",
            "openTask(file,line)      open a task at its exact source line",
            "scopes(opts?)            active org/project combinations; opts: all,query,scopeNote",
            "scopeCatalog()           orgs with projects and inherited activity settings",
            "setScopeStatus(opts)     set one organization or organization/project active state",
            "createTask(opts)         create a validated task note; opts: text,org,project,col",
            "moveTask(file,line,col)  move a task to a column",
            "moveTasks(refs,col)      move several file:line refs to a column",
            "rankTasks(pairs,col?)    set manual order [[file:line, rank]], moving into col first",
            "setEstimate(ref,min)    set (minutes) or clear (null) the time guess of a card",
            "estimates(opts?)        cards with a guess: ref, est min, took min (time in opts.col, default Doing)",
            "planned(date|from,to,opts) Doing time split planned (>= opts.mull min, default 60, in Backlog/Todo first) vs ad hoc",
            "reportCards(from,to,opts) Reports input: cards with Doing stints or done in range; opts.mull minutes",
            "activity(date?)          captured Mac activity vs Doing stints for one day (.activity/YYYYMMDD.jsonl)",
            "moveTasks(refs,col,{at}) at=ISO backdates the move; cards that moved later are skipped",
            "setDesktop(ref,d)        set (1-9 or a desktop name) or clear (null) the macOS desktop of a card; active({desktop:true}) lists it",
            "sweep(from,to,refs?)     bulk-move a column (refs = file:line list)",
            "sweeps()                 sweep routes from settings: From<TAB>To",
            "habits(opts?)            habit stats: state, today, 7d avg, streak; opts: paths",
            "toggle(name,opts?)       flip a habit idle<->Doing (start/stop logging); opts: paths",
            "props(opts?)             frontmatter schema of task files; opts: paths,sample,since,tasks",
            "notes(opts)             query notes by frontmatter; opts: where,paths,limit,contains,since,tasks",
            "help()                   this list"
          ].join("\n");
        },
        // Discover frontmatter schema of this vault — no hardcoded keys.
        // Tab-lines: key<TAB>noteCount<TAB>sample,values,distinct (capped)
        // opts: { paths, sample (max distinct values per key, default 8) }
        async props(opts = {}) {
          if (typeof opts === "string") opts = { since: opts };
          const cap = opts.sample || 8;
          const tasks = opts.tasks !== false;
          const files = await fmFiles(plugin.app, opts.paths, opts.since, tasks);
          const counts = /* @__PURE__ */ new Map();
          const seen = /* @__PURE__ */ new Map();
          for (const f of files) {
            const fm = plugin.app.metadataCache.getFileCache(f)?.frontmatter;
            if (!fm) continue;
            for (const key of Object.keys(fm)) {
              if (key === "position") continue;
              counts.set(key, (counts.get(key) || 0) + 1);
              const set = seen.get(key) || /* @__PURE__ */ new Set();
              for (const v of fmVals(fm, key) || []) if (v) set.add(v);
              seen.set(key, set);
            }
          }
          const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}	${n}	${[...seen.get(k)].slice(0, cap).join(", ")}`);
          return "\n" + rows.join("\n");
        },
        // Query notes by frontmatter properties. Keys caller-supplied, never baked in.
        // where: { KEY: VAL, ... } — note matches when EVERY key matches (any array elem).
        // Tab-lines: file<TAB>key=val; key=val  (the queried props' actual values)
        // opts: { where (required), paths, limit, contains }
        async notes(opts = {}) {
          const where = opts.where || {};
          const keys = Object.keys(where);
          const files = await fmFiles(plugin.app, opts.paths, opts.since, opts.tasks);
          const rows = [];
          for (const f of files) {
            const fm = plugin.app.metadataCache.getFileCache(f)?.frontmatter;
            if (!fm) continue;
            const ok = keys.every((k) => {
              const vals = fmVals(fm, k);
              return vals && matchVal(vals, where[k], opts.contains);
            });
            if (!ok) continue;
            const shown = keys.map((k) => `${k}=${(fmVals(fm, k) || []).join("|")}`).join("; ");
            rows.push(`${f.path}	${shown}`);
            if (opts.limit && rows.length >= opts.limit) break;
          }
          return "\n" + rows.join("\n");
        },
        // A project's live plate: active tasks (incl. paused Backlog) in notes whose
        // frontmatter `prop` matches `project`. The notes∩active cross-query, packaged.
        // opts: { prop (default "projects"), col, paths, since, limit, includePaused }
        async plate(project, opts = {}) {
          if (project && typeof project === "object") {
            opts = project;
            project = null;
          }
          const prop = opts.prop || "projects";
          let rows = (await this.active({
            col: opts.col,
            includePaused: true,
            limit: opts.limit,
            since: opts.since
          })).split("\n").filter(Boolean);
          if (project) {
            const files = await fmFiles(plugin.app, opts.paths, opts.since, false);
            const set = new Set(files.filter((f) => {
              const vals = fmVals(plugin.app.metadataCache.getFileCache(f)?.frontmatter, prop);
              return vals && matchVal(vals, project, opts.contains);
            }).map((f) => f.path));
            rows = rows.filter((l) => set.has((l.split("	")[1] || "").split(":")[0]));
          }
          return "\n" + rows.join("\n");
        },
        // Move a task to a column
        async moveTask(filePath, line, toCol) {
          const file = plugin.app.vault.getAbstractFileByPath(filePath);
          if (!file) throw new Error("file not found: " + filePath);
          const config = makeConfig2({}, plugin);
          const col = config.columns.find((c) => c.name.toLowerCase() === String(toCol).toLowerCase());
          if (!col) throw new Error("unknown col: " + toCol);
          await moveCard2(plugin.app, file, line, col, config, {});
          return `ok ${filePath}:${line} -> ${col.name}`;
        },
        // Move several "file:line" refs to one column. Same-file refs go bottom-up so
        // each inserted history line cannot shift a ref still to move. Returns "ok <moved>".
        // opts.at (ISO time) backdates the stamp; a card that moved after `at` is skipped.
        async moveTasks(refs, toCol, opts = {}) {
          const config = makeConfig2({}, plugin);
          const col = config.columns.find((c) => c.name.toLowerCase() === String(toCol).toLowerCase());
          if (!col) throw new Error("unknown col: " + toCol);
          const parsed = refs.map((r) => {
            const i = r.lastIndexOf(":");
            return { path: r.slice(0, i), line: +r.slice(i + 1) };
          }).sort((a, b) => a.path === b.path ? b.line - a.line : a.path.localeCompare(b.path));
          const at = opts.at ? new Date(opts.at) : null;
          if (at && Number.isNaN(at.getTime())) throw new Error("bad at: " + opts.at);
          let moved = 0;
          for (const { path, line } of parsed) {
            const file = plugin.app.vault.getAbstractFileByPath(path);
            if (!file) continue;
            if (at && !backdateOk(at.getTime(), await cardHistory(plugin.app, file, line))) continue;
            if (await moveCard2(plugin.app, file, line, col, config, { at })) moved++;
          }
          return `ok ${moved}`;
        },
        // Manual order: [[ref, rank], ...]. With toCol, cards not already there move first.
        // Same-file refs go bottom-up (each edit only inserts below its task). Returns "ok <n>".
        async rankTasks(pairs, toCol) {
          const config = makeConfig2({}, plugin);
          const col = toCol == null ? null : config.columns.find((c) => c.name.toLowerCase() === String(toCol).toLowerCase());
          if (toCol != null && !col) throw new Error("unknown col: " + toCol);
          const parsed = pairs.map(([r, rank]) => {
            const i = r.lastIndexOf(":");
            return { path: r.slice(0, i), line: +r.slice(i + 1), rank: Number(rank) };
          }).filter((p) => Number.isFinite(p.rank)).sort((a, b) => a.path === b.path ? b.line - a.line : a.path.localeCompare(b.path));
          let n = 0;
          for (const p of parsed) {
            const file = plugin.app.vault.getAbstractFileByPath(p.path);
            if (!file) continue;
            if (col) {
              const lines2 = (await plugin.app.vault.read(file)).split(/\r?\n/);
              const m = lines2[p.line]?.match(TASK_RE2);
              if (m && taskColumn(lines2, p.line, m, config)?.key !== col.key) await moveCard2(plugin.app, file, p.line, col, config, {});
            }
            const lines = (await plugin.app.vault.read(file)).split(/\r?\n/);
            if (!TASK_RE2.test(lines[p.line] || "")) continue;
            setRankLine(lines, p.line, p.rank);
            await plugin.app.vault.modify(file, lines.join("\n"));
            n++;
          }
          return `ok ${n}`;
        },
        // A card's macOS desktop: `%% kbdesktop <ref> %%` under the task. ref = 1-9 or a desktop
        // name from the Kanban Board label store; null clears.
        async setDesktop(ref, value) {
          const i = ref.lastIndexOf(":"), path = ref.slice(0, i), line = +ref.slice(i + 1);
          const desk = desktopRef(value);
          if (value != null && desk == null) throw new Error("desktop must be 1-9, a name without % or newlines, or null");
          const file = plugin.app.vault.getAbstractFileByPath(path);
          if (!file) throw new Error("no file: " + path);
          const lines = (await plugin.app.vault.read(file)).split(/\r?\n/);
          if (!TASK_RE2.test(lines[line] || "")) throw new Error("not a task: " + ref);
          setDesktopLine(lines, line, desk);
          await plugin.app.vault.modify(file, lines.join("\n"));
          return `ok ${ref} desktop ${desk ?? "none"}`;
        },
        // A card's time guess in minutes: `%% kbest N %%` under the task. null clears.
        async setEstimate(ref, minutes) {
          const i = ref.lastIndexOf(":"), path = ref.slice(0, i), line = +ref.slice(i + 1);
          const num = minutes == null ? null : Math.round(Number(minutes));
          if (num != null && !(num >= 1)) throw new Error("estimate must be minutes >= 1 or null");
          const file = plugin.app.vault.getAbstractFileByPath(path);
          if (!file) throw new Error("no file: " + path);
          const lines = (await plugin.app.vault.read(file)).split(/\r?\n/);
          if (!TASK_RE2.test(lines[line] || "")) throw new Error("not a task: " + ref);
          setEstLine(lines, line, num);
          await plugin.app.vault.modify(file, lines.join("\n"));
          return `ok ${ref} est ${num ?? "none"}`;
        },
        // Cards with a guess: "file:line<TAB>estMinutes<TAB>tookMinutes", took = summed time in `col` (default Doing).
        async estimates(opts = {}) {
          const want = String(opts.col || "Doing").toLowerCase();
          const byCol = await scanKanbanTasks(plugin.app, makeConfig2(opts, plugin));
          const out = [];
          for (const [key, list] of byCol) for (const card of list) {
            if (card.est == null) continue;
            const ev = chrono(card.history);
            let ms = 0;
            ev.forEach((e, i) => {
              if (e.to.toLowerCase() !== want) return;
              if (!ev[i + 1] && key !== want) return;
              ms += (ev[i + 1] ? stampToDate(ev[i + 1].stamp).getTime() : Date.now()) - stampToDate(e.stamp).getTime();
            });
            out.push(`${card.file.path}:${card.line}	${card.est}	${Math.round(ms / 6e4)}`);
          }
          return "\n" + out.join("\n");
        },
        // Bulk-move a column, as the board's sweep button does. refs ("file:line")
        // limits it to those cards. Returns "ok <moved> <blocked>".
        async sweep(fromCol, toCol, refs) {
          const config = makeConfig2({}, plugin);
          const find = (n) => config.columns.find((c) => c.name.toLowerCase() === String(n).toLowerCase());
          const from = find(fromCol), to = find(toCol);
          if (!from || !to) throw new Error("unknown col: " + (from ? toCol : fromCol));
          const byCol = await scanKanbanTasks(plugin.app, config);
          let cards = byCol.get(from.key) || [];
          if (refs) {
            const keep = new Set(refs);
            cards = cards.filter((c) => keep.has(`${c.file.path}:${c.line}`));
          }
          const { moved, blocked } = await sweepColumn(plugin.app, config, from, to, cards);
          return `ok ${moved} ${blocked}`;
        },
        // Sweep routes from settings, one "From<TAB>To" line each (names as typed).
        sweeps() {
          return "\n" + String(plugin.settings?.kanban?.sweep || "").split(/[,\n]/).map((r) => r.split(">").map((s) => s.trim())).filter(([f, t]) => f && t).map(([f, t]) => `${f}	${t}`).join("\n");
        },
        // Habit stats — one line per habit card. opts: { paths }.
        // Lines: name<TAB>state(idle|DOING)<TAB>today<TAB>7d<TAB>streak
        async habits(opts = {}) {
          const { habitStats, fmtHours } = require_habits();
          const now = /* @__PURE__ */ new Date();
          const rows = (await habitCards(plugin, opts)).map((x) => ({ ...x, label: cleanText(x.card.body) })).sort((a, b) => a.label.localeCompare(b.label)).map(({ card, colKey, fm, label }) => {
            const metric = (card.metric || fm.metric) === "count" ? "count" : "sum";
            const st = habitStats(card.history, metric, now);
            const f = (v) => metric === "count" ? `${Math.round((v || 0) * 10) / 10}x` : fmtHours(v);
            const state = colKey === "doing" ? "DOING" : "idle";
            if (!st) return `${label}	${state}	no logs		`;
            return `${label}	${state}	today ${f(st.today)}	7d ${f(st.avg7)}	${st.streak}d`;
          });
          return "\n" + rows.join("\n");
        },
        // Toggle a habit's stopwatch: idle -> Doing (start) or Doing -> idle (stop).
        // This is the button/LLM primitive — log work without opening the board.
        // `name` = the habit file's basename (case-insensitive). opts: { paths }.
        async toggle(name, opts = {}) {
          const want = String(name).toLowerCase();
          const items = (await habitCards(plugin, opts)).map((x) => ({ ...x, label: cleanText(x.card.body) }));
          const matches = items.filter((x) => x.label.toLowerCase() === want);
          if (!matches.length) throw new Error("habit not found: " + name);
          if (matches.length > 1) throw new Error(`ambiguous habit "${name}" \u2014 ${matches.length} cards match`);
          const it = matches[0];
          const config = makeHabitConfig(opts);
          const cur = config.columns.find((c) => c.key === it.colKey);
          const target = it.colKey === "doing" ? config.columns.find((c) => !c.state && c.paused) : config.columns.find((c) => c.live);
          await moveCard2(plugin.app, it.card.file, it.card.line, target, config, { fromCol: cur });
          return `ok ${it.label}: ${cur.name} -> ${target.name}`;
        },
        // Snapshot the ACTIVE note's properties into a reusable, provenance-stamped
        // template (body dropped). Notes made from it inherit `template`/`template-version`
        // for a future retroactive "propagate". Usage: kb.saveTemplate("Project ABC").
        async saveTemplate(name) {
          return saveTemplate(plugin, name);
        }
      };
    }
    module2.exports = { buildApi: buildApi2, makeConfig: makeConfig2, fileNameStamp, filterSince, scopeInactive, taskNote };
  }
});

// src/sleep.js
var require_sleep = __commonJS({
  "src/sleep.js"(exports2, module2) {
    var { Notice: Notice2, Platform } = require("obsidian");
    var { scanKanbanTasks, moveCard: moveCard2, parseKanbanConfig: parseKanbanConfig2 } = require_kanban();
    var { sleepGap, backdateOk } = require_activity();
    var TICK_KEY = "bdb-last-tick";
    var TICK_MS = 6e4;
    function readTick() {
      try {
        return Number(window.localStorage.getItem(TICK_KEY)) || null;
      } catch {
        return null;
      }
    }
    function writeTick(ms) {
      try {
        window.localStorage.setItem(TICK_KEY, String(ms));
      } catch {
      }
    }
    async function parkAll(plugin, at, makeConfig2) {
      const boards = [
        { config: makeConfig2(), habit: false },
        { config: parseKanbanConfig2("columns: Idle~, Doing!"), habit: true }
      ];
      let moved = 0;
      for (const { config, habit } of boards) {
        const live = config.columns.find((c) => c.live);
        const target = habit ? config.columns.find((c) => c.paused) : config.columns.find((c) => c.key === "parked") || config.columns.find((c) => c.paused && c.key !== "backlog");
        if (!live || !target) continue;
        const byCol = await scanKanbanTasks(plugin.app, config);
        const cards = (byCol.get(live.key) || []).filter((c) => plugin.app.metadataCache.getFileCache(c.file)?.frontmatter?.metric != null === habit).filter((c) => backdateOk(at.getTime(), c.history)).sort((a, b) => a.file.path === b.file.path ? b.line - a.line : a.file.path.localeCompare(b.file.path));
        for (const card of cards) {
          if (await moveCard2(plugin.app, card.file, card.line, target, config, { fromCol: live, at })) moved++;
        }
      }
      return moved;
    }
    function startSleepWatch2(plugin, makeConfig2) {
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
          const n = await parkAll(plugin, new Date(gapStart), makeConfig2);
          if (n) new Notice2(`kanban: parked ${n} Doing card${n > 1 ? "s" : ""} at ${new Date(gapStart).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} (Mac was asleep)`);
        } catch (err) {
          console.warn("backlinks-daily-blocks: sleep park failed", err);
        } finally {
          busy = false;
        }
      };
      plugin.app.workspace.onLayoutReady(tick);
      plugin.registerInterval(window.setInterval(tick, TICK_MS));
      plugin.register(() => writeTick(Date.now()));
    }
    module2.exports = { startSleepWatch: startSleepWatch2, parkAll };
  }
});

// src/settings.js
var require_settings = __commonJS({
  "src/settings.js"(exports2, module2) {
    var { PluginSettingTab, Setting } = require("obsidian");
    var DEFAULT_SETTINGS = {
      kanban: {
        columns: "Backlog~\nTodo\nDoing!\nParked~\nDone=x\nCancelled=-",
        colors: "",
        paths: "",
        maxage: 7,
        sweep: "Doing > Parked",
        lanesort: "total-desc",
        layout: "vertical",
        autoFold: false,
        colsort: { backlog: "latest" }
      },
      ei: {
        paths: "",
        from: "",
        doors: "Do > Todo\nDelegate > Waiting +who\nDelete > Cancelled"
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
      },
      templates: {
        dir: "90-99 Obsidian Meta/Templates"
      },
      views: {
        recentHours: 24
      }
    };
    var TABS = ["Kanban", "Ei", "Backlinks", "Daily", "Templates", "Views"];
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
        this.bind(
          new Setting(el).setName("Default columns").setDesc('One per line: Name[~N idle, ages amber past N days (default 1), red past 3N][! heartbeat][=x terminal char] [@color]. e.g. "Waiting~3", "Doing! @#2d7ff9", "Done=x @green". No @color = built-in palette.'),
          "kanban",
          "columns",
          { area: true }
        );
        this.bind(new Setting(el).setName("Default paths").setDesc("Comma list of path prefixes to scan; empty = whole vault."), "kanban", "paths");
        this.bind(new Setting(el).setName("Max age (days)").setDesc("Hide terminal cards stamped older than this; 0 = show all."), "kanban", "maxage", { number: true });
        this.bind(new Setting(el).setName("Auto-fold empty columns").setDesc("Collapse empty columns by default."), "kanban", "autoFold");
        new Setting(el).setName("Layout").setDesc("Stack columns vertically, or show them side by side.").addDropdown((d) => d.addOptions({ vertical: "Vertical", horizontal: "Horizontal" }).setValue(this.plugin.settings.kanban.layout === "horizontal" ? "horizontal" : "vertical").onChange(async (v) => {
          this.plugin.settings.kanban.layout = v;
          await this.plugin.saveSettings();
        }));
        this.bind(new Setting(el).setName("Sweep").setDesc('One "From > To" route per line; each adds a bulk-move button on its From column. Empty disables.'), "kanban", "sweep", { area: true });
        new Setting(el).setName("Lane sort").setDesc("Default swimlane order.").addDropdown((d) => d.addOptions({
          "total-desc": "Total cards (most first)",
          "total-asc": "Total cards (fewest first)",
          "open-desc": "Open tasks (most first)",
          "open-asc": "Open tasks (fewest first)",
          "name-asc": "Name (A\u2192Z)",
          "name-desc": "Name (Z\u2192A)"
        }).setValue(this.plugin.settings.kanban.lanesort).onChange(async (v) => {
          this.plugin.settings.kanban.lanesort = v;
          await this.plugin.saveSettings();
        }));
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
        const lines = multi("columns", k.columns);
        if (k.paths) lines.push(`paths: ${k.paths}`);
        lines.push(`layout: ${k.layout === "horizontal" ? "horizontal" : "vertical"}`);
        lines.push(`maxage: ${k.maxage}`);
        lines.push(`auto-fold: ${k.autoFold}`);
        if (k.lanesort && k.lanesort !== "total-desc") lines.push(`lanesort: ${k.lanesort}`);
        if (k.sweep) lines.push(...multi("sweep", k.sweep));
        if (k.colors) lines.push(...multi("colors", k.colors));
        return lines.join("\n");
      }
      renderEi(el) {
        this.bind(new Setting(el).setName("Default paths").setDesc("Comma list of path prefixes to scan; empty = kanban default paths."), "ei", "paths");
        this.bind(new Setting(el).setName("Tray column").setDesc("Open kanban column the tray shows; empty = first open column."), "ei", "from");
        this.bind(new Setting(el).setName("Doors").setDesc('One "Name > TargetColumn [+who]" per line. +who asks for a person and appends a [[wikilink]]. Target must exist on the kanban.'), "ei", "doors", { area: true });
        const preview = new Setting(el).setName("Current config as block").setDesc("Read-only. Paste into an ei code block in any note to clone this chute.").setClass("bdb-setting-area");
        preview.addButton((b) => b.setButtonText("Copy").onClick(async () => {
          await navigator.clipboard.writeText(this.eiBlockText());
          b.setButtonText("Copied");
          window.setTimeout(() => b.setButtonText("Copy"), 1200);
        }));
        preview.addTextArea((t) => {
          t.inputEl.readOnly = true;
          t.inputEl.rows = 6;
          t.inputEl.classList.add("bdb-config-preview");
          const fill = () => t.setValue(this.eiBlockText());
          fill();
          t.inputEl.addEventListener("focus", () => {
            fill();
            t.inputEl.select();
          });
        });
      }
      // Settings rendered as ```ei``` block syntax.
      eiBlockText() {
        const e = this.plugin.settings.ei;
        const lines = ["doors:", ...e.doors.split(/[,\n]/).map((s) => s.trim()).filter(Boolean).map((s) => `  ${s}`)];
        if (e.from) lines.unshift(`from: ${e.from}`);
        if (e.paths) lines.push(`paths: ${e.paths}`);
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
      renderTemplates(el) {
        this.bind(
          new Setting(el).setName("Templates folder").setDesc('Vault-relative folder where "Save note properties as template" writes. e.g. "90-99 Obsidian Meta/Templates/Categories". Created if missing.'),
          "templates",
          "dir"
        );
      }
      renderViews(el) {
        this.bind(
          new Setting(el).setName("Recent task window (hours)").setDesc("Show tasks whose latest move happened within this many hours."),
          "views",
          "recentHours",
          { number: true }
        );
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
        const { app: app2 } = this;
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
          const note = await prepareNote(app2, file, { strip: stripFrontmatter, truncate: truncateLength });
          if (note.kind === "empty") continue;
          this.waveSeparator(this.containerEl, "red");
          const section = this.containerEl.createDiv("bdb-bases-entry");
          const titleEl = section.createEl("h4");
          const linkEl = titleEl.createEl("a", { text: displayName(file), cls: "bdb-bases-title-link" });
          linkEl.addEventListener("click", (evt) => {
            evt.preventDefault();
            const modEvent = evt.ctrlKey || evt.metaKey;
            app2.workspace.openLinkText(file.path, "", modEvent);
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
        const { app: app2 } = this;
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
          const cache = app2.metadataCache.getFileCache(entry.file);
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
        const { app: app2 } = this;
        const tasks = [];
        for (const entry of this.fileEntries()) {
          const file = entry.file;
          const cache = app2.metadataCache.getFileCache(file);
          const listItems = cache?.listItems || [];
          if (!listItems.length) continue;
          let fileLines = null;
          for (const item of listItems) {
            if (!item || typeof item.task !== "string") continue;
            const pos = item.position?.start;
            if (!pos || pos.line == null) continue;
            if (!fileLines) {
              try {
                const content = await app2.vault.cachedRead(file);
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
        const { app: app2 } = this;
        const wins = [];
        for (const entry of this.fileEntries()) {
          const file = entry.file;
          let lines = [];
          try {
            const content = await app2.vault.cachedRead(file);
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

// src/views/doing.js
var require_doing = __commonJS({
  "src/views/doing.js"(exports2, module2) {
    var { ItemView, Menu, Notice: Notice2, setIcon } = require("obsidian");
    var {
      cleanText,
      resolveKanbanConfig,
      scanKanbanTasks,
      moveCard: moveCard2,
      stampToDate,
      columnColor
    } = require_kanban();
    var { renderInteractive, openFileAtLine } = require_render();
    var DOING_VIEW_TYPE2 = "bdb-doing";
    function elapsed(date) {
      const total = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1e3));
      if (!date || !Number.isFinite(total)) return "--:--:--";
      const days = Math.floor(total / 86400);
      const hours = String(Math.floor(total / 3600) % 24).padStart(2, "0");
      const minutes = String(Math.floor(total / 60) % 60).padStart(2, "0");
      const seconds = String(total % 60).padStart(2, "0");
      return `${days ? `${days}d ` : ""}${hours}:${minutes}:${seconds}`;
    }
    function cardTime(card) {
      const last = card.history.slice().sort((a, b) => b.stamp.localeCompare(a.stamp))[0];
      if (last) return stampToDate(last.stamp);
      const daily = card.file.basename.match(/^(\d{8})-(\d{4})/);
      return daily ? stampToDate(daily[1] + daily[2]) : new Date(card.file.stat.ctime);
    }
    function taskEmojis(cards) {
      const found = /* @__PURE__ */ new Set();
      const text = cards.map((item) => item.card.body).join(" ");
      const segments = new Intl.Segmenter(void 0, { granularity: "grapheme" }).segment(text);
      for (const { segment } of segments) {
        if (/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(segment)) found.add(segment);
      }
      return [...found].join(" ");
    }
    var DoingView2 = class extends ItemView {
      constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.collapsed = /* @__PURE__ */ new Set();
      }
      getViewType() {
        return DOING_VIEW_TYPE2;
      }
      getDisplayText() {
        return "Tasks";
      }
      getIcon() {
        return "list-checks";
      }
      async onOpen() {
        this.registerEvent(this.app.vault.on("modify", () => this.draw()));
        this.registerEvent(this.app.vault.on("create", () => this.draw()));
        this.registerEvent(this.app.vault.on("delete", () => this.draw()));
        this.registerEvent(this.app.vault.on("rename", () => this.draw()));
        this.registerInterval(window.setInterval(() => this.tick(), 1e3));
        this.registerInterval(window.setInterval(() => this.draw(), 6e4));
        await this.draw();
      }
      tick() {
        for (const clock of this.clocks || []) clock.el.setText(elapsed(clock.date));
      }
      config() {
        const config = resolveKanbanConfig(this.plugin, "", null);
        config.maxage = 0;
        return config;
      }
      async recentGroups(config) {
        const byCol = await scanKanbanTasks(this.app, config);
        const hours = Math.max(1, Number(this.plugin.settings.views.recentHours) || 24);
        const cutoff = Date.now() - hours * 36e5;
        const doing = config.columns.find((col) => col.key === "doing");
        const columns = doing ? [doing, ...config.columns.filter((col) => col !== doing)] : config.columns;
        return {
          hours,
          groups: columns.map((col, index) => ({
            col,
            index,
            cards: (byCol.get(col.key) || []).map((card) => ({ card, date: cardTime(card) })).filter((item) => item.date.getTime() >= cutoff).sort((a, b) => b.date - a.date)
          }))
        };
      }
      async moveTask(card, fromCol, toCol, config) {
        if (!card || fromCol === toCol) return false;
        const moved = await moveCard2(this.app, card.file, card.line, toCol, config, { fromCol });
        new Notice2(moved ? `Task moved to ${toCol.name}` : "Task could not be moved");
        await this.draw();
        return moved;
      }
      showMoveMenu(event, card, fromCol, config) {
        event.preventDefault();
        const menu = new Menu().setUseNativeMenu(false);
        for (const col of config.columns.filter((col2) => col2 !== fromCol)) {
          menu.addItem((item) => item.setTitle(`Move to ${col.name}`).setIcon(col.state ? "check-circle-2" : "arrow-right").onClick(() => this.moveTask(card, fromCol, col, config)));
        }
        menu.showAtMouseEvent(event);
      }
      startDrag(event, task, card, fromCol) {
        this.dragged = { card, fromCol };
        task.addClass("is-dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", `${card.file.path}::${card.line}::${fromCol.key}`);
        const ghost = task.cloneNode(true);
        ghost.addClass("bdb-task-drag-ghost");
        ghost.style.width = `${Math.round(task.getBoundingClientRect().width)}px`;
        task.ownerDocument.body.appendChild(ghost);
        event.dataTransfer.setDragImage(ghost, 22, 22);
        window.setTimeout(() => ghost.remove(), 0);
      }
      wireDropTarget(section, toCol, config) {
        const accepts = () => this.dragged && this.dragged.fromCol !== toCol;
        section.addEventListener("dragover", (event) => {
          if (!accepts()) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          section.addClass("is-drop-target");
        });
        section.addEventListener("dragleave", (event) => {
          if (!section.contains(event.relatedTarget)) section.removeClass("is-drop-target");
        });
        section.addEventListener("drop", async (event) => {
          event.preventDefault();
          section.removeClass("is-drop-target");
          const dragged = this.dragged;
          this.dragged = null;
          if (dragged && dragged.fromCol !== toCol) {
            await this.moveTask(dragged.card, dragged.fromCol, toCol, config);
          }
        });
      }
      collapseButton(toolbar, groups) {
        const keys = groups.filter((group) => group.col.key !== "doing").map((group) => group.col.key);
        const allCollapsed = keys.every((key) => this.collapsed.has(key));
        const button = toolbar.createEl("button", {
          cls: "clickable-icon bdb-task-collapse-all",
          attr: { "aria-label": allCollapsed ? "Expand all sections" : "Collapse all sections" }
        });
        setIcon(button, allCollapsed ? "unfold-vertical" : "fold-vertical");
        button.addEventListener("click", () => {
          for (const key of keys) allCollapsed ? this.collapsed.delete(key) : this.collapsed.add(key);
          this.draw();
        });
      }
      sectionHeader(section, group) {
        const { col, cards } = group;
        const doing = col.key === "doing";
        const head = section.createDiv({
          cls: `bdb-task-section-head${doing ? " is-doing" : ""}`,
          attr: doing ? {} : {
            role: "button",
            tabindex: "0",
            "aria-expanded": String(!this.collapsed.has(col.key))
          }
        });
        const caret = head.createSpan({
          cls: `bdb-task-section-caret${doing ? " is-spacer" : ""}`,
          attr: doing ? { "aria-hidden": "true" } : {}
        });
        if (!doing) {
          setIcon(caret, this.collapsed.has(col.key) ? "chevron-right" : "chevron-down");
        }
        head.createSpan({ cls: "bdb-task-section-title", text: col.name });
        head.createSpan({ cls: "bdb-doing-count", text: String(cards.length) });
        const meta = head.createSpan({ cls: "bdb-task-section-meta" });
        const emojis = taskEmojis(cards);
        if (emojis) meta.createSpan({ cls: "bdb-task-section-emojis", text: emojis });
        if (doing) {
          const live = meta.createSpan({ cls: "bdb-doing-live" });
          live.createSpan({ cls: "bdb-doing-live-dot" });
          live.createSpan({ text: "LIVE" });
        } else {
          const toggle = () => {
            this.collapsed.has(col.key) ? this.collapsed.delete(col.key) : this.collapsed.add(col.key);
            this.draw();
          };
          head.addEventListener("click", toggle);
          head.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            toggle();
          });
        }
      }
      async taskCard(parent, item, col, config, drawVersion) {
        const { card, date } = item;
        const task = parent.createDiv({
          cls: "bdb-doing-item",
          attr: { role: "button", tabindex: "0", draggable: "true" }
        });
        task.setAttr("title", "Drag or right-click to move");
        await renderInteractive(this.plugin, cleanText(card.body), task.createDiv({ cls: "bdb-doing-task" }), card.file.path);
        if (drawVersion !== this.drawVersion) return false;
        if (col.key === "doing") {
          const clock = task.createSpan({ cls: "bdb-doing-clock", text: elapsed(date) });
          clock.setAttr("aria-label", "Time in Doing");
          clock.setAttr("title", `In Doing since ${date.toLocaleString()}`);
          this.clocks.push({ el: clock, date });
        }
        const open = (event) => openFileAtLine(this.app, card.file, card.line, event.metaKey || event.ctrlKey);
        task.addEventListener("click", (event) => {
          if (!event.target.closest("a")) open(event);
        });
        task.addEventListener("contextmenu", (event) => this.showMoveMenu(event, card, col, config));
        task.addEventListener("dragstart", (event) => this.startDrag(event, task, card, col));
        task.addEventListener("dragend", () => {
          task.removeClass("is-dragging");
          this.dragged = null;
          for (const target of this.contentEl.querySelectorAll(".is-drop-target")) target.removeClass("is-drop-target");
        });
        task.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          open(event);
        });
        return true;
      }
      async draw() {
        const drawVersion = (this.drawVersion || 0) + 1;
        this.drawVersion = drawVersion;
        const config = this.config();
        const { hours, groups } = await this.recentGroups(config);
        if (drawVersion !== this.drawVersion) return;
        const root = this.contentEl;
        root.empty();
        root.addClass("bdb-doing-view");
        this.clocks = [];
        const toolbar = root.createDiv({ cls: "bdb-task-toolbar" });
        toolbar.createSpan({ text: `Last ${hours}h` });
        this.collapseButton(toolbar, groups);
        for (const group of groups) {
          const section = root.createDiv({ cls: "bdb-task-section" });
          section.style.setProperty("--bdb-section-color", columnColor(config, group.col, group.index));
          this.wireDropTarget(section, group.col, config);
          this.sectionHeader(section, group);
          if (group.col.key !== "doing" && this.collapsed.has(group.col.key)) continue;
          const body = section.createDiv({ cls: "bdb-task-section-body" });
          if (!group.cards.length) body.createDiv({ cls: "bdb-doing-empty", text: "No recent tasks" });
          for (const item of group.cards) {
            if (!await this.taskCard(body, item, group.col, config, drawVersion)) return;
          }
        }
      }
    };
    module2.exports = { DoingView: DoingView2, DOING_VIEW_TYPE: DOING_VIEW_TYPE2 };
  }
});

// src/views/kanban.js
var require_kanban2 = __commonJS({
  "src/views/kanban.js"(exports2, module2) {
    var { BdbBasesView } = require_base();
    var { resolveKanbanConfig, drawBoard } = require_kanban();
    var KANBAN_VIEW_TYPE2 = "kanban-bases-view";
    var KanbanView2 = class extends BdbBasesView {
      constructor(plugin, controller, parentEl) {
        super(plugin, controller, parentEl, KANBAN_VIEW_TYPE2, "bdb-kanban bdb-kanban-bases");
        this.state = { dragging: false };
      }
      load() {
        this.timer = window.setInterval(() => {
          if (!this.state.dragging) (this.state.timeUpdaters || []).forEach((update) => update());
        }, 6e4);
      }
      unload() {
        window.clearInterval(this.timer);
      }
      async onDataUpdated() {
        const paths2 = new Set([...this.fileEntries()].map((entry) => entry.file.path));
        const config = resolveKanbanConfig(this.plugin, "", null);
        config.cacheFilter = (_cache, file) => paths2.has(file.path);
        await drawBoard(this.plugin, this.containerEl, config, this.state);
      }
    };
    module2.exports = { KanbanView: KanbanView2, KANBAN_VIEW_TYPE: KANBAN_VIEW_TYPE2 };
  }
});

// src/main.js
var { Plugin, Notice, SuggestModal } = require("obsidian");
var { renderBacklinksBlock, renderDailyBlock } = require_blocks();
var { renderKanbanBlock, parseKanbanConfig, moveCard, TASK_RE, TASK_END_RE, HIST_RE } = require_kanban();
var { renderEiBlock } = require_ei();
var { renderReportBlock } = require_report();
var { renderHabitsBlock, renderHabitPad } = require_habits();
var { renderScopesBlock } = require_scopes();
var { buildApi, makeConfig } = require_api();
var { startSleepWatch } = require_sleep();
var { renderActivityBlock } = require_activity2();
var { saveTemplateCommand } = require_templates();
var { BdbSettingTab, mergeSettings } = require_settings();
var { ChronicleView, CHRONICLE_VIEW_TYPE } = require_chronicle();
var { AtlasView, ATLAS_VIEW_TYPE } = require_atlas();
var { LedgerView, LEDGER_VIEW_TYPE } = require_ledger();
var { BeaconView, BEACON_VIEW_TYPE } = require_beacon();
var { DoingView, DOING_VIEW_TYPE } = require_doing();
var { KanbanView, KANBAN_VIEW_TYPE } = require_kanban2();
function taskMeta(lines, line) {
  const histories = /* @__PURE__ */ new Set();
  let tag = (lines[line].match(/#kb\/([\w-]+)/) || [])[1];
  for (let i = line + 1; i < lines.length && !TASK_END_RE.test(lines[i]); i++) {
    const history2 = lines[i].match(HIST_RE)?.[0];
    if (history2) histories.add(history2);
    tag ||= (lines[i].match(/#kb\/([\w-]+)/) || [])[1];
  }
  return { histories, tag };
}
var TaskColumnSuggest = class extends SuggestModal {
  constructor(plugin, file, line, config, fromCol) {
    super(plugin.app);
    this.file = file;
    this.line = line;
    this.config = config;
    this.fromCol = fromCol;
    this.setPlaceholder("Move task to\u2026");
  }
  getSuggestions(query) {
    const q = query.trim().toLowerCase();
    return this.config.columns.filter((col) => col.name.toLowerCase().includes(q));
  }
  renderSuggestion(col, el) {
    el.setText(col === this.fromCol ? `${col.name} (current)` : col.name);
  }
  async onChooseSuggestion(col) {
    if (col === this.fromCol) return;
    const moved = await moveCard(this.app, this.file, this.line, col, this.config, { fromCol: this.fromCol });
    new Notice(moved ? `Task moved to ${col.name}` : "Task could not be moved");
  }
};
var BacklinksDailyBlocksPlugin = class extends Plugin {
  async onload() {
    this.settings = mergeSettings(await this.loadData());
    this.api = buildApi(this);
    globalThis.kb = this.api;
    startSleepWatch(this, () => makeConfig({}, this));
    this.addSettingTab(new BdbSettingTab(this));
    this.registerView(DOING_VIEW_TYPE, (leaf) => new DoingView(leaf, this));
    this.addCommand({
      id: "open-doing-view",
      name: "Open recent tasks",
      callback: async () => {
        const leaf = this.app.workspace.getLeavesOfType(DOING_VIEW_TYPE)[0] || this.app.workspace.getLeaf("tab");
        await leaf.setViewState({ type: DOING_VIEW_TYPE, active: true });
        this.app.workspace.revealLeaf(leaf);
      }
    });
    this.taskSnapshots = /* @__PURE__ */ new Map();
    this.taskWrites = /* @__PURE__ */ new Set();
    this.editorSnapshots = /* @__PURE__ */ new WeakMap();
    const remember = async (file) => {
      if (file?.extension === "md") this.taskSnapshots.set(file.path, await this.app.vault.read(file));
    };
    const rememberEditor = (leaf) => {
      if (leaf?.view?.editor) this.editorSnapshots.set(leaf.view.editor, leaf.view.editor.getValue());
    };
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      remember(leaf.view.file);
      rememberEditor(leaf);
    }
    this.registerEvent(this.app.workspace.on("file-open", (file) => remember(file)));
    this.registerEvent(this.app.workspace.on("active-leaf-change", rememberEditor));
    this.registerEvent(this.app.workspace.on("editor-change", (editor, info) => {
      this.closeEditorCheckedTasks(editor, info).catch((err) => console.warn("backlinks-daily-blocks: close checked task failed", err));
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => this.closeManuallyCheckedTasks(file)));
    this.addCommand({
      id: "save-props-as-template",
      name: "Save note properties as template",
      callback: () => saveTemplateCommand(this)
    });
    this.addCommand({
      id: "move-task-under-cursor",
      name: "Move task under cursor",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "M" }],
      editorCallback: async (editor, view) => {
        const file = view.file;
        const line = editor.getCursor().line;
        const task = editor.getLine(line).match(TASK_RE);
        if (!file || !task) return new Notice("Cursor is not on a task");
        await view.save();
        const columns = this.settings.kanban.columns.split(/\r?\n/).map((x) => `  ${x}`).join("\n");
        const config = parseKanbanConfig(`columns:
${columns}`);
        const meta = taskMeta(editor.getValue().split(/\r?\n/), line);
        const fromCol = config.columns.find((col) => col.state === task[2]) || config.columns.find((col) => col.key === meta.tag) || config.columns.find((col) => !col.state);
        new TaskColumnSuggest(this, file, line, config, fromCol).open();
      }
    });
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
    this.registerMarkdownCodeBlockProcessor("ei", (src, el, ctx) => {
      return renderEiBlock(this, src, el, ctx);
    });
    this.registerMarkdownCodeBlockProcessor("report", (src, el, ctx) => {
      return renderReportBlock(this, src, el, ctx);
    });
    this.registerMarkdownCodeBlockProcessor("habits", (src, el, ctx) => {
      return renderHabitsBlock(this, src, el, ctx);
    });
    this.registerMarkdownCodeBlockProcessor("habit-pad", (src, el, ctx) => {
      return renderHabitPad(this, src, el, ctx);
    });
    this.registerMarkdownCodeBlockProcessor("activity", (src, el, ctx) => {
      return renderActivityBlock(this, src, el, ctx);
    });
    this.registerMarkdownCodeBlockProcessor("scopes", (src, el, ctx) => {
      return renderScopesBlock(this, src, el, ctx);
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
    this.registerBasesView(KANBAN_VIEW_TYPE, {
      name: "Kanban",
      icon: "lucide-columns-3",
      factory: (controller, containerEl) => new KanbanView(this, controller, containerEl),
      options: () => []
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
    for (const leaf of this.app.workspace.getLeavesOfType(DOING_VIEW_TYPE)) leaf.view.draw();
  }
  async closeManuallyCheckedTasks(file) {
    if (file?.extension !== "md") return;
    const next = await this.app.vault.read(file);
    const previous = this.taskSnapshots.get(file.path);
    this.taskSnapshots.set(file.path, next);
    if (previous == null || this.taskWrites.has(file.path)) return;
    const before = previous.split(/\r?\n/);
    const after = next.split(/\r?\n/);
    const config = parseKanbanConfig(`columns:
${this.settings.kanban.columns.split(/\r?\n/).map((x) => `  ${x}`).join("\n")}`);
    const moves = [];
    for (let line = 0; line < Math.min(before.length, after.length); line++) {
      const oldTask = before[line].match(TASK_RE);
      const newTask = after[line].match(TASK_RE);
      const target = newTask && config.columns.find((col) => col.state === newTask[2]);
      if (!oldTask || oldTask[2] !== " " || !target) continue;
      const oldMeta = taskMeta(before, line);
      const newMeta = taskMeta(after, line);
      if ([...newMeta.histories].some((history2) => !oldMeta.histories.has(history2))) continue;
      const fromCol = config.columns.find((col) => col.key === oldMeta.tag) || config.columns.find((col) => !col.state);
      moves.push({ line, target, fromCol });
    }
    if (!moves.length) return;
    this.taskWrites.add(file.path);
    try {
      for (const move of moves.reverse()) await moveCard(this.app, file, move.line, move.target, config, { fromCol: move.fromCol });
      this.taskSnapshots.set(file.path, await this.app.vault.read(file));
    } finally {
      this.taskWrites.delete(file.path);
    }
  }
  async closeEditorCheckedTasks(editor, info) {
    const file = info?.file;
    const next = editor.getValue();
    const previous = this.editorSnapshots.get(editor);
    this.editorSnapshots.set(editor, next);
    if (!file || previous == null || this.taskWrites.has(file.path)) return;
    const before = previous.split(/\r?\n/);
    const after = next.split(/\r?\n/);
    const config = parseKanbanConfig(`columns:
${this.settings.kanban.columns.split(/\r?\n/).map((x) => `  ${x}`).join("\n")}`);
    const moves = [];
    for (let line = 0; line < Math.min(before.length, after.length); line++) {
      const oldTask = before[line].match(TASK_RE);
      const newTask = after[line].match(TASK_RE);
      const target = newTask && config.columns.find((col) => col.state === newTask[2]);
      if (!oldTask || oldTask[2] !== " " || !target) continue;
      const oldMeta = taskMeta(before, line);
      const newMeta = taskMeta(after, line);
      if ([...newMeta.histories].some((history2) => !oldMeta.histories.has(history2))) continue;
      const fromCol = config.columns.find((col) => col.key === oldMeta.tag) || config.columns.find((col) => !col.state);
      moves.push({ line, target, fromCol });
    }
    if (!moves.length || typeof info.save !== "function") return;
    this.taskWrites.add(file.path);
    try {
      await info.save();
      for (const move of moves.reverse()) await moveCard(this.app, file, move.line, move.target, config, { fromCol: move.fromCol });
      this.taskSnapshots.set(file.path, await this.app.vault.read(file));
    } finally {
      this.taskWrites.delete(file.path);
    }
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
