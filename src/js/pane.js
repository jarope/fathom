// A file pane: breadcrumb path bar, live filter / recursive search, listing,
// selection, rename, drag & drop and status line. Tabs own two of these.

import { app, invoke, el, icon, store, fmtSize, isFolder } from "./core.js";
import { createDetails, sortValue } from "./details.js";
import { createGrid, gridSize, setGridSize, GRID_MIN, GRID_MAX } from "./grid.js";
import { createColumns } from "./columns.js";
import { saveSettings } from "./settings.js";
import { pushUndo, refreshAll, selectEverywhere, trashPaths } from "./ops.js";
import { openContextMenu, showMenu } from "./menu.js";
import { setActive, openTab } from "./tabs.js";
import { a11yPane } from "./a11y.js";
import { registerDropZone, startDrag } from "./dnd.js";
import { loadGit, gitChip } from "./git.js";
import { isBinDir, binLabel, loadOrigins, syncBinBar, deleteNow } from "./bin.js";
import { ensureUsage, cancelUsage, usageBytes, usageStatus, invalidateUsage } from "./usage.js";
import { usesSpotlight, startSpotlight, cancelSpotlight, searchMenu, placeholder, modeLabel, addRecent, attachRecent } from "./search.js";

const TEMPLATE = `
  <div class="ptoolbar">
    <div class="navbtns">
      <button class="nb b-back" type="button" title="Back (⌘[)" aria-label="Back"></button>
      <button class="nb b-fwd" type="button" title="Forward (⌘])" aria-label="Forward"></button>
      <button class="nb b-up" type="button" title="Up (⌘↑)" aria-label="Enclosing folder"></button>
      <button class="nb b-new" type="button" title="New folder (⇧⌘N)" aria-label="New folder"></button>
      <button class="nb b-home" type="button" title="Home" aria-label="Home"></button>
    </div>
    <div class="pathwrap" title="Click a folder to go there · › lists sub-folders · click blank space or ⌘L to type a path">
      <div class="crumbs"></div>
      <input class="path" type="text" spellcheck="false" autocomplete="off" />
    </div>
    <div class="searchwrap"><button class="smode" type="button" title="Search options — names or contents, here or the whole Mac" aria-label="Search options"><span class="smode-l"></span></button><input class="search" type="text" spellcheck="false" autocomplete="off" /></div>
  </div>
  <div class="listing"></div>
  <div class="pstatus"></div>`;

// Per-folder view memory: sort column, direction and view mode (details / grid).
const viewMemory = () => store.get("fathom-views", {});
function rememberView(dir, v) {
  const m = viewMemory();
  delete m[dir]; m[dir] = { ...v };
  const keys = Object.keys(m); if (keys.length > 500) keys.slice(0, keys.length - 500).forEach((k) => delete m[k]);
  store.set("fathom-views", m);
}

const globRe = (f) => new RegExp("^" + f.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");

export function createPane(key) {
  const root = el("div", "pane " + key);
  root.innerHTML = TEMPLATE;
  const q = (s) => root.querySelector(s);
  const els = {
    pathwrap: q(".pathwrap"), crumbs: q(".crumbs"), path: q(".path"),
    search: q(".search"), searchwrap: q(".searchwrap"), smode: q(".smode"),
    listing: q(".listing"), status: q(".pstatus"),
    back: q(".b-back"), fwd: q(".b-fwd"), up: q(".b-up"), home: q(".b-home"), newb: q(".b-new"),
  };
  els.back.append(icon("back")); els.fwd.append(icon("forward")); els.up.append(icon("up"));
  els.newb.append(icon("newFolder")); els.home.append(icon("home"));
  els.smode.prepend(icon("search"));

  const P = {
    key, root, els, tab: null,
    // base = everything in the folder (or search hits); entries = base after the live filter, sorted.
    cwd: null, parent: null, base: [], entries: [], selected: new Set(), space: null,
    anchor: -1, cursor: -1, mode: "browse", showHidden: false,
    history: [], hi: -1, msgTimer: null,
    sortKey: "name", sortDir: 1, // 1 asc, -1 desc; folders always first
    viewMode: "details",          // "details" | "grid" | "columns" | "usage"
    uSort: { key: "size", dir: -1 }, // Usage view's own sort (largest first), kept apart from the folder's
    colRoot: null,                // Columns view: the first (leftmost) folder
    renaming: false, pendingRefresh: false, editing: false,
    expanded: new Set(), // folders opened in place (tree)
    kids: new Map(),     // expanded folder path -> its entries
  };
  const changed = () => app.hooks.changed(P);
  const ariaSync = a11yPane(P);
  const views = { details: createDetails(P), grid: createGrid(P), columns: createColumns(P), usage: createDetails(P, { usage: true }) };
  // Search / tag results are a flat list: Columns shows them as Details.
  const V = () => (P.viewMode === "columns" && P.mode !== "browse" ? views.details : views[P.viewMode] || views.details);
  const rowAt = (i) => V().rowAt(i);
  const reveal = (i) => V().reveal(i);
  P.reveal = reveal;

  // ---------------------------------------------------------------- status
  P.renderStatus = (extra) => {
    els.status.innerHTML = "";
    const n = P.entries.length, total = P.base.length;
    els.status.append(el("span", "count", n.toLocaleString()), el("span", null, ` item${n === 1 ? "" : "s"}`));
    if (P.filtered) els.status.append(el("span", null, ` (filtered from ${total.toLocaleString()})`));
    if (P.selected.size) els.status.append(el("span", null, " · "), el("span", "sel", `${P.selected.size} selected`));
    els.status.append(el("span", "grow"));
    const gc = gitChip(P); if (gc) els.status.append(gc);
    if (extra && extra !== P.flashMsg) P.flashMsg = null; // a newer message replaces it
    extra = extra || P.flashMsg; // a recent message survives redraws
    if (P.viewMode === "grid") els.status.append(sizeSlider());
    if (P.viewMode === "usage") { if (extra) els.status.append(extra); els.status.append(...usageStatus(P)); return; }
    if (extra) els.status.append(extra);
    else if (P.space) els.status.append(el("span", "mono", `${fmtSize(P.space.free, false)} free of ${fmtSize(P.space.total, false)}`));
  };
  // Icon size for the grid (one setting for every pane, like Finder's slider).
  function sizeSlider() {
    const r = el("input", "gsize"); r.type = "range"; r.min = GRID_MIN; r.max = GRID_MAX; r.step = 8;
    r.value = gridSize(); r.title = "Icon size — drag, or scroll over it"; r.setAttribute("aria-label", "Icon size");
    r.addEventListener("input", () => setGridSize(+r.value, false));
    r.addEventListener("change", () => saveSettings());
    return r;
  }
  P.flash = (text, cls = "msg") => {
    P.flashMsg = el("span", cls, text);
    P.renderStatus();
    if (P.msgTimer) clearTimeout(P.msgTimer);
    P.msgTimer = setTimeout(() => { P.flashMsg = null; P.renderStatus(); }, 4500);
  };

  // ------------------------------------------------------------ navigation
  // keepFilter: keep the live filter text. keepSel: keep selection, cursor and
  // scroll (used by reloads/auto-refresh of the same folder). Returns success.
  P.navigate = async (path, { push = true, keepFilter = false, keepSel = false } = {}) => {
    if (!invoke) { els.status.textContent = "Native backend unavailable."; return false; }
    cancelSpotlight(P);
    if (pendingDraw) { cancelAnimationFrame(pendingDraw); pendingDraw = 0; }
    P.spotResults = false;
    let listing;
    try { listing = await invoke("list_dir", { path, showHidden: P.showHidden }); }
    catch (e) {
      // macOS privacy protection (Mail, Safari, Time Machine…): explain the fix.
      if (/Operation not permitted|os error 1\)/.test(String(e))) { import("./system.js").then((m) => m.fullDiskAccessHelp(path)); P.flash("⚠ macOS is protecting this folder", "warn"); }
      else P.flash("⚠ " + e, "warn");
      return false;
    }
    const moved = listing.dir !== P.cwd;
    const keep = keepSel && !moved;
    if (moved) {
      P.expanded.clear(); P.kids.clear();
      const v = viewMemory()[listing.dir];
      // Browsing in Columns stays in Columns (Finder); otherwise the folder's own view.
      // Usage is the same: drilling in keeps measuring, and it's never remembered per folder.
      if (v) { P.sortKey = v.sortKey; P.sortDir = v.sortDir; if (v.viewMode && v.viewMode !== "usage" && P.viewMode !== "columns" && P.viewMode !== "usage") P.viewMode = v.viewMode; }
      // Never sorted + shelf on: the tiles have no column header to sort by,
      // so start from Name rather than whatever the last folder used.
      else if (app.folderShelf) { P.sortKey = "name"; P.sortDir = 1; }
    } else if (P.expanded.size) await loadKids([...P.expanded]); // refresh the open sub-folders too
    const filter = keepFilter && P.mode === "browse" ? els.search.value : "";
    const prevSel = keep ? new Set(P.selected) : new Set();
    const prevCursor = keep && P.entries[P.cursor] ? P.entries[P.cursor].path : null;
    const scroll = keep ? els.listing.scrollTop : 0;

    P.cwd = listing.dir; P.parent = listing.parent; P.base = listing.entries;
    P.mode = "browse"; P.selected = prevSel;
    els.search.value = filter; els.searchwrap.classList.remove("active");
    P.applyFilter(); // also drops selected paths that vanished
    if (prevCursor) { const i = P.entries.findIndex((e) => e.path === prevCursor); if (i >= 0) { P.cursor = i; P.anchor = i; } }
    if (push) { P.history = P.history.slice(0, P.hi + 1); P.history.push(listing.dir); P.hi = P.history.length - 1; }

    P.renderList(); els.listing.scrollTop = scroll;
    P.renderCrumbs(); P.renderStatus(); P.updateNav();
    changed();
    if (moved) { P.space = null; P.git = null; app.hooks.navigated(P); }
    loadGit(P);
    syncBinBar(P); loadOrigins(P);
    invoke("free_space", { path: listing.dir }).then((s) => { P.space = s; P.renderStatus(); }).catch(() => {});
    return true;
  };
  // Children of expanded folders (folders that can't be read close again).
  async function loadKids(paths) {
    await Promise.all(paths.map(async (p) => {
      try { P.kids.set(p, (await invoke("list_dir", { path: p, showHidden: P.showHidden })).entries); }
      catch { P.expanded.delete(p); P.kids.delete(p); }
    }));
  }
  /** Open or close folder row i in place. open: true/false, or toggle. */
  P.setExpanded = async (i, open) => {
    const e = P.entries[i];
    if (!isFolder(e) || P.mode !== "browse" || V().isTile(i)) return;
    if (open === undefined) open = !P.expanded.has(e.path);
    if (open === P.expanded.has(e.path)) return;
    if (open) { P.expanded.add(e.path); await loadKids([e.path]); if (!P.expanded.has(e.path)) { P.flash(`⚠ Can't open “${e.name}”`, "warn"); return; } }
    else {
      P.expanded.delete(e.path);
      // Selection inside a closed folder moves to the folder itself.
      const inside = [...P.selected].filter((p) => p.startsWith(e.path + "/"));
      if (inside.length) { inside.forEach((p) => P.selected.delete(p)); P.selected.add(e.path); }
    }
    const cur = P.entries[P.cursor] ? P.entries[P.cursor].path : e.path;
    const sel = new Set(P.selected);
    P.rebuild();
    P.selected = sel;
    const ci = P.entries.findIndex((x) => x.path === cur);
    P.cursor = P.anchor = ci >= 0 ? ci : P.entries.findIndex((x) => x.path === e.path);
    P.renderList(); P.reflect(); reveal(P.cursor);
    if (app.hooks.expanded) app.hooks.expanded(P); // watch the open sub-folders too
  };
  /** ← / →: open / close folders in the list; move through tiles in the shelf. */
  P.arrowSide = (dir, extend) => {
    if (P.viewMode === "grid") { P.moveCursor(dir, extend); return; }
    if (P.viewMode === "columns" && P.mode === "browse") { columnStep(dir); return; }
    if (P.viewMode === "usage") { columnStep(dir); return; } // → measure the folder, ← back out
    const i = P.cursor, e = P.entries[i];
    if (e && !V().isTile(i) && P.mode === "browse") {
      if (dir > 0 && isFolder(e)) { if (!P.expanded.has(e.path)) P.setExpanded(i, true); else if (P.entries[i + 1] && P.entries[i + 1].depth > (e.depth || 0)) { P.selectSingle(i + 1); reveal(i + 1); } return; }
      if (dir < 0) {
        if (isFolder(e) && P.expanded.has(e.path)) { P.setExpanded(i, false); return; }
        if (e.depth > 0) { const pi = P.entries.findIndex((x) => x.path === e.parent); if (pi >= 0) { P.selectSingle(pi); reveal(pi); } return; }
      }
      return;
    }
    if (app.folderShelf && P.mode === "browse") P.moveCursor(dir, extend);
  };
  /** Columns: → opens the selected folder (selecting its first item), ← goes back out. */
  async function columnStep(dir) {
    if (dir > 0) {
      const sel = P.selectedEntries();
      if (sel.length !== 1 || !isFolder(sel[0])) return;
      if (await P.navigate(sel[0].path) && P.entries.length) { P.selectSingle(0); reveal(0); }
      return;
    }
    if (!P.parent) return;
    const from = P.cwd;
    if (await P.navigate(P.parent)) P.selectPaths([from]);
  }
  P.reload = () => (P.cwd ? P.navigate(P.cwd, { push: false, keepFilter: true, keepSel: true }) : Promise.resolve(false));
  /** Auto-refresh entry point: never disturbs an inline rename or search results. */
  P.refresh = () => {
    if (!P.cwd || P.mode !== "browse") return;
    if (P.renaming) { P.pendingRefresh = true; return; }
    invalidateUsage(P.cwd); // the folder changed: its measure (and its parents') is stale
    return P.reload();
  };
  P.setHidden = (on) => { P.showHidden = on; if (P.mode === "browse" && P.cwd) P.reload(); };
  P.updateNav = () => { els.back.disabled = P.hi <= 0; els.fwd.disabled = P.hi >= P.history.length - 1; els.up.disabled = !P.parent; };
  P.goUp = () => P.parent && P.navigate(P.parent);
  P.goBack = () => { if (P.hi > 0) { P.hi--; P.navigate(P.history[P.hi], { push: false }); } };
  P.goFwd = () => { if (P.hi < P.history.length - 1) { P.hi++; P.navigate(P.history[P.hi], { push: false }); } };
  P.goHome = () => P.navigate(app.home);

  els.back.addEventListener("click", P.goBack);
  els.fwd.addEventListener("click", P.goFwd);
  els.up.addEventListener("click", P.goUp);
  els.home.addEventListener("click", P.goHome);
  els.newb.addEventListener("click", () => P.newItem(true));

  // ------------------------------------------------------------ breadcrumbs
  // "/ › Users › me ›" — a segment navigates, a "›" lists that folder's
  // sub-folders, blank space switches to a typed path. Segments accept drops.
  P.renderCrumbs = () => {
    const c = els.crumbs;
    c.innerHTML = "";
    if (!P.cwd) return;
    const parts = P.cwd.split("/").filter(Boolean);
    const paths = ["/", ...parts.map((_, i) => "/" + parts.slice(0, i + 1).join("/"))];
    const labels = ["/", ...parts];
    paths.forEach((p, i) => { const b = binLabel(p); if (b) labels[i] = b; });
    const sep = (dir) => { const s = el("span", "csep", "›"); s.dataset.dir = dir; return s; };
    paths.forEach((p, i) => {
      if (i > 0) c.append(sep(paths[i - 1]));
      const b = el("span", "crumb" + (i === paths.length - 1 ? " cur" : ""), labels[i]);
      b.dataset.path = p; b.title = p;
      c.append(b);
    });
    c.append(sep(P.cwd));
    c.scrollLeft = c.scrollWidth; // keep the current folder in view
  };
  async function subfolderMenu(sepEl) {
    const dir = sepEl.dataset.dir;
    let l;
    try { l = await invoke("list_dir", { path: dir, showHidden: P.showHidden }); }
    catch (e) { P.flash("⚠ " + e, "warn"); return; }
    const dirs = l.entries.filter((e) => e.is_dir);
    const r = sepEl.getBoundingClientRect();
    showMenu(dirs.length
      ? dirs.slice(0, 500).map((d) => ({ label: d.name, icon: "folder", on: P.cwd === d.path || P.cwd.startsWith(d.path + "/"), fn: () => P.navigate(d.path) }))
      : [{ label: "No sub-folders", disabled: true }], r.left - 6, r.bottom + 6);
  }
  P.editPath = () => {
    P.editing = true;
    els.pathwrap.classList.add("editing");
    els.path.value = P.cwd || "";
    els.path.focus(); els.path.select();
  };
  const endEdit = () => { P.editing = false; els.pathwrap.classList.remove("editing"); };
  els.crumbs.addEventListener("click", (ev) => {
    ev.stopPropagation(); // keeps the document click from closing a menu we open
    setActive(P);
    const cr = ev.target.closest(".crumb");
    if (cr) { if (cr.dataset.path !== P.cwd) P.navigate(cr.dataset.path); return; }
    const sp = ev.target.closest(".csep");
    if (sp) { subfolderMenu(sp); return; }
    P.editPath();
  });
  els.pathwrap.addEventListener("click", () => { if (!P.editing) P.editPath(); });
  els.path.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      let v = els.path.value.trim();
      if (v === "~" || v.startsWith("~/")) v = app.home + v.slice(1);
      endEdit(); els.path.blur();
      if (v) P.navigate(v);
    } else if (e.key === "Escape") { endEdit(); els.path.blur(); }
  });
  els.path.addEventListener("blur", endEdit);
  // Drop onto a breadcrumb segment → move/copy into that ancestor folder.
  registerDropZone({
    root: els.crumbs,
    over: (n) => { const cr = n.closest(".crumb"); return cr && cr.dataset.path !== P.cwd ? { el: cr, dest: cr.dataset.path } : null; },
  });

  // ----------------------------------------------- live filter / recursive search
  // The live filter as a test (null = show everything).
  const filterTest = () => {
    // Query helpers (kind:pdf…) only apply when ⏎ runs a search.
    const f = P.spotResults ? "" : els.search.value.replace(/\b(kind|type|modified|date|size|tag):("[^"]*"|\S+)/gi, "").trim();
    if (!f) return null;
    if (/[*?]/.test(f)) { const re = globRe(f); return (e) => re.test(e.name); }
    const lf = f.toLowerCase(); return (e) => e.name.toLowerCase().includes(lf);
  };
  /** Recompute P.entries from P.base: filter, sort, and (browsing) splice in
   * the contents of expanded folders, each level sorted, with e.depth set. */
  P.rebuild = () => {
    const test = filterTest();
    if (P.mode !== "browse") { P.entries = test ? P.base.filter(test) : P.base.slice(); P.applySort(); return !!test; }
    const shelf = app.folderShelf;
    const walk = (list, depth, out) => {
      const sorted = list.slice().sort(cmp);
      for (const e of sorted) {
        e.depth = depth;
        const open = P.viewMode === "details" && isFolder(e) && P.expanded.has(e.path) && P.kids.has(e.path) && !(shelf && depth === 0);
        if (open) {
          const sub = []; walk(P.kids.get(e.path), depth + 1, sub);
          if (!test || test(e) || sub.length) out.push(e, ...sub);
        } else if (!test || test(e)) out.push(e);
      }
      return out;
    };
    P.entries = walk(P.base, 0, []);
    return !!test;
  };
  P.applyFilter = () => {
    const f = (P.filtered = P.rebuild());
    els.searchwrap.classList.toggle("filtering", f && P.mode === "browse");
    const vis = new Set(P.entries.map((e) => e.path));
    P.selected = new Set([...P.selected].filter((p) => vis.has(p)));
    P.anchor = -1; P.cursor = -1;
  };
  els.search.addEventListener("input", () => {
    if (!els.search.value.trim() && P.mode === "search") { P.reload(); return; }
    P.applyFilter(); P.renderList(); P.renderStatus(); changed();
  });
  P.runSearch = async () => {
    const query = els.search.value.trim();
    if (!query) { P.reload(); return; }
    if (!P.cwd) return;
    addRecent(query);
    if (usesSpotlight()) { startSpotlight(P, query); return; }
    P.spotResults = false;
    els.searchwrap.classList.add("active");
    P.renderStatus(el("span", "spinner"));
    let res;
    try { res = await invoke("search", { req: { root: P.cwd, query, case_insensitive: true, include_dirs: true, include_hidden: P.showHidden } }); }
    catch (e) { P.flash("⚠ " + e, "warn"); return; }
    P.base = res.hits; P.entries = res.hits.slice(); P.applySort(); P.mode = "search"; P.filtered = false;
    P.selected.clear(); P.anchor = -1; P.cursor = -1;
    els.searchwrap.classList.remove("filtering");
    P.renderList();
    P.renderStatus(el("span", "msg", `${res.hits.length.toLocaleString()} found · ${res.elapsed_ms} ms${res.truncated ? " · capped" : ""}`));
    changed();
  };
  /** Show an arbitrary list of entries (tag / Spotlight results) like search results. */
  P.showResults = (entries, msg, busy = false) => {
    P.base = entries; P.entries = entries.slice(); P.applySort(); P.mode = "search"; P.filtered = false;
    P.spotResults = busy;
    P.selected.clear(); P.anchor = -1; P.cursor = -1;
    els.searchwrap.classList.remove("filtering");
    els.searchwrap.classList.toggle("active", busy);
    P.renderList();
    const st = el("span", "msg", msg + (busy ? "" : " · Esc to go back"));
    if (busy) { const w = el("span"); w.append(el("span", "spinner"), st); P.renderStatus(w); } else P.renderStatus(st);
    changed();
  };
  // Streamed results (Spotlight): add a batch; redraw at most once per frame.
  let pendingDraw = 0;
  const drawResults = () => {
    pendingDraw = 0;
    if (P.mode !== "search" || !P.spotResults) return; // cancelled / left the results meanwhile
    const top = els.listing.scrollTop;
    P.entries = P.base.slice(); P.applySort();
    const cur = P.cursor >= 0 ? P.entries[P.cursor] : null;
    P.renderList(); els.listing.scrollTop = top;
    if (cur) P.cursor = P.entries.indexOf(cur);
    P.renderStatus(Object.assign(el("span"), { innerHTML: '<span class="spinner"></span> <span class="msg">Searching…</span>' }));
  };
  P.appendResults = (entries) => {
    if (P.mode !== "search" || !entries.length) return;
    P.base = P.base.concat(entries);
    if (!pendingDraw) pendingDraw = requestAnimationFrame(drawResults);
  };
  P.finishResults = (msg) => {
    if (pendingDraw) { cancelAnimationFrame(pendingDraw); drawResults(); }
    els.searchwrap.classList.remove("active");
    P.renderStatus(el("span", "msg", msg + " · Esc to go back"));
    changed();
  };
  P.syncSearchMode = () => {
    els.search.placeholder = placeholder();
    const l = modeLabel();
    els.smode.querySelector(".smode-l").textContent = l;
    els.smode.classList.toggle("on", !!l);
  };
  P.syncSearchMode();
  els.smode.addEventListener("click", (ev) => {
    ev.stopPropagation(); setActive(P);
    const r = els.smode.getBoundingClientRect();
    searchMenu(P, r.left, r.bottom + 6);
  });
  attachRecent(P);
  els.search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") P.runSearch();
    if (e.key === "Escape") { els.search.value = ""; P.reload(); els.search.blur(); }
  });

  // -------------------------------------------------------- create / rename
  P.newItem = async (isDir) => {
    if (!P.cwd) return;
    let path;
    try { path = await invoke("create_item", { parent: P.cwd, name: isDir ? "New Folder" : "New File.txt", isDir }); }
    catch (e) { P.flash("⚠ " + e, "warn"); return; }
    pushUndo({ kind: "create", created: [path], label: `new ${isDir ? "folder" : "file"}` });
    els.search.value = ""; // make sure the filter can't hide the new item
    if (P.mode === "search") await P.navigate(P.cwd, { push: false });
    await refreshAll();
    P.startRename(path);
  };
  P.startRename = (path) => {
    const i = P.entries.findIndex((e) => e.path === path); if (i < 0) return;
    P.selectSingle(i);
    reveal(i); // draws the row if it was scrolled out of view
    const row = rowAt(i); if (!row) return;
    const e = P.entries[i];
    const input = el("input", "rename");
    input.value = e.name; input.spellcheck = false; input.autocomplete = "off";
    row.querySelector(".nm").replaceWith(input);
    P.renaming = true;
    input.focus();
    const dot = e.is_dir ? -1 : e.name.lastIndexOf("."); // select the stem, not ".ext"
    input.setSelectionRange(0, dot > 0 ? dot : e.name.length);
    let done = false;
    const finish = async (commit) => {
      if (done) return; done = true;
      P.renaming = false;
      const pending = P.pendingRefresh; P.pendingRefresh = false;
      const nn = input.value.trim();
      if (!commit || !nn || nn === e.name) {
        if (pending) P.reload(); else { P.renderList(); P.reflect(); }
        return;
      }
      try {
        const np = await invoke("rename_path", { path: e.path, newName: nn });
        pushUndo({ kind: "rename", from: e.path, to: np, label: `rename to “${nn}”` });
        await refreshAll(); selectEverywhere([np]);
        P.flash(`Renamed to ${nn} · ⌘Z undoes`);
      } catch (err) { P.renderList(); P.reflect(); P.flash("⚠ " + err, "warn"); }
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
    ["click", "dblclick", "mousedown"].forEach((t) => input.addEventListener(t, (ev) => ev.stopPropagation()));
  };

  // -------------------------------------------------------------- selection
  P.selectedEntries = () => P.entries.filter((e) => P.selected.has(e.path));
  P.selectedPaths = () => P.selectedEntries().map((e) => e.path);
  P.reflect = () => {
    els.listing.querySelectorAll(".row").forEach((r) => r.classList.toggle("sel", P.selected.has(P.entries[+r.dataset.i].path)));
    ariaSync();
    if (V().selChanged) V().selChanged();
    P.renderStatus(); changed();
    if (P.binOrigins) syncBinBar(P);
  };
  P.selectSingle = (i) => { P.selected = new Set([P.entries[i].path]); P.anchor = i; P.cursor = i; P.reflect(); };
  P.toggleOne = (i) => { const p = P.entries[i].path; P.selected.has(p) ? P.selected.delete(p) : P.selected.add(p); P.anchor = i; P.cursor = i; P.reflect(); };
  P.selectRange = (a, b) => { const [lo, hi] = a < b ? [a, b] : [b, a]; P.selected = new Set(); for (let i = lo; i <= hi; i++) P.selected.add(P.entries[i].path); P.cursor = b; P.reflect(); };
  P.selectAll = () => { P.selected = new Set(P.entries.map((x) => x.path)); P.reflect(); };
  P.clearSel = () => { P.selected.clear(); P.reflect(); };
  P.selectPaths = (paths) => {
    const want = new Set(paths);
    const idx = P.entries.map((e, i) => (want.has(e.path) ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return;
    P.selected = new Set(idx.map((i) => P.entries[i].path)); P.anchor = idx[0]; P.cursor = idx[0];
    P.reflect(); reveal(idx[0]);
  };
  P.markCut = () => {
    const c = app.clip;
    els.listing.querySelectorAll(".row").forEach((r) => r.classList.toggle("cut", !!(c && c.cut && c.paths.includes(P.entries[+r.dataset.i].path))));
  };
  P.moveCursor = (dir, extend, step = 1) => {
    if (!P.entries.length) return;
    let i = P.cursor;
    if (i < 0) i = dir > 0 ? 0 : P.entries.length - 1;
    else i = dir > 0 ? Math.min(P.entries.length - 1, i + step) : Math.max(0, i - step);
    if (extend && P.anchor >= 0) P.selectRange(P.anchor, i); else P.selectSingle(i);
    reveal(i);
  };
  /** ↑ ↓: a row in Details, a line of cells in Grid. */
  P.moveLine = (dir, extend) => P.moveCursor(dir, extend, V().perRow());
  // Type-ahead: typing letters jumps to the first matching name.
  let taBuf = "", taTimer = null;
  P.typeAhead = (ch) => {
    taBuf += ch.toLowerCase();
    clearTimeout(taTimer); taTimer = setTimeout(() => (taBuf = ""), 900);
    const i = P.entries.findIndex((e) => e.name.toLowerCase().startsWith(taBuf));
    if (i >= 0) { P.selectSingle(i); reveal(i); }
  };
  P.activate = (i) => { const e = P.entries[i]; if (isFolder(e)) P.navigate(e.path); else invoke("open_path", { path: e.path }); };
  P.enterOrOpen = () => {
    const sel = P.selectedEntries();
    if (sel.length === 1) P.activate(P.entries.indexOf(sel[0]));
    else sel.filter((x) => !isFolder(x)).forEach((x) => invoke("open_path", { path: x.path }));
  };

  P.trashSelected = () => (isBinDir(P.cwd) && P.mode === "browse" ? deleteNow(P, P.selectedPaths()) : trashPaths(P, P.selectedPaths()));


  // ------------------------------------------------------------------- sort
  // Folders first; then the sort column; ties by name.
  // Usage: no folders-first; Size is the measured footprint.
  function cmp(a, b) {
    const usage = P.viewMode === "usage", key = usage ? P.uSort.key : P.sortKey;
    if (!usage) { const fa = isFolder(a), fb = isFolder(b); if (fa !== fb) return fa ? -1 : 1; }
    const va = usage && key === "size" ? usageBytes(P, a) : sortValue(a, key), vb = usage && key === "size" ? usageBytes(P, b) : sortValue(b, key);
    let r = typeof va === "number" ? va - vb : va.localeCompare(vb);
    if (r === 0) r = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    return r * (usage ? P.uSort.dir : P.sortDir);
  }
  /** A sorted copy of any listing, by this pane's rules (Columns' side columns). */
  P.sortEntries = (list) => list.slice().sort(cmp);
  /** Sort in place (search results; browsing goes through P.rebuild). */
  P.applySort = () => {
    if (P.mode === "browse" && P.expanded.size) { P.rebuild(); return; }
    P.entries.sort(cmp);
  };
  P.sortBy = (k) => {
    if (P.viewMode === "usage") {
      P.uSort = P.uSort.key === k ? { key: k, dir: -P.uSort.dir } : { key: k, dir: k === "size" ? -1 : 1 };
      const selPaths = P.selectedPaths();
      P.rebuild(); P.cursor = -1; P.anchor = -1;
      P.renderList(); P.selectPaths(selPaths); changed();
      return;
    }
    if (P.sortKey === k) P.sortDir = -P.sortDir;
    else { P.sortKey = k; P.sortDir = ["name", "folder", "kind", "ext"].includes(k) ? 1 : -1; } // numbers/dates: largest/newest first
    const selPaths = P.selectedPaths();
    P.rebuild(); P.cursor = -1; P.anchor = -1;
    P.renderList(); P.selectPaths(selPaths); changed(); app.hooks.save();
    P.remember();
  };
  P.remember = () => { if (P.mode === "browse" && P.cwd && P.viewMode !== "usage") rememberView(P.cwd, { sortKey: P.sortKey, sortDir: P.sortDir, viewMode: P.viewMode }); };

  /** Switch this pane between Details and Grid (remembered for this folder). */
  P.setViewMode = (m) => {
    if (!views[m] || m === P.viewMode) return;
    const cur = P.entries[P.cursor] ? P.entries[P.cursor].path : null;
    const sel = new Set(P.selected);
    if (P.viewMode === "usage") cancelUsage(P);
    P.viewMode = m;
    P.rebuild(); P.selected = sel;
    if (cur) P.cursor = P.anchor = P.entries.findIndex((e) => e.path === cur);
    els.listing.scrollTop = 0;
    P.renderList(); P.renderStatus();
    if (P.cursor >= 0) reveal(P.cursor);
    P.remember(); changed(); app.hooks.save();
    if (app.hooks.viewMode) app.hooks.viewMode(P);
  };

  // ----------------------------------------------------------------- render
  P.resizeGrid = () => views.grid.resize();
  P.renderList = () => {
    els.listing.classList.toggle("grid", P.viewMode === "grid");
    els.listing.classList.toggle("columns", V() === views.columns);
    els.listing.classList.toggle("usage", P.viewMode === "usage");
    V().render();
    if (P.viewMode === "usage") ensureUsage(P);
  };

  // --------------------------------------------------------- pointer input
  root.addEventListener("mousedown", () => setActive(P), true);
  els.listing.addEventListener("click", (ev) => {
    const disc = ev.target.closest(".disc.can");
    if (disc) { ev.stopPropagation(); P.setExpanded(+disc.closest(".row").dataset.i); return; }
    const row = ev.target.closest(".row");
    if (!row) { if (!bandJustEnded && !ev.target.closest(".head") && P.selected.size) P.clearSel(); return; } // empty space clears
    const i = +row.dataset.i;
    if (ev.metaKey || ev.ctrlKey) P.toggleOne(i);
    else if (ev.shiftKey && P.anchor >= 0) P.selectRange(P.anchor, i);
    else P.selectSingle(i);
  });
  // Rubber band: drag from empty space to select what the box touches
  // (⌘/⇧ add to the selection). Works in Details and Grid; hit-testing is
  // geometric, so rows that aren't drawn yet are included.
  let bandJustEnded = false;
  els.listing.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0 || V().noBand || ev.target.closest(".row, .head, .shelf, input") || !P.entries.length) return;
    const L = els.listing, lr = L.getBoundingClientRect();
    if (ev.clientX - lr.left >= L.clientWidth) return; // the scrollbar
    const pt = (e) => [e.clientX - lr.left + L.scrollLeft, e.clientY - lr.top + L.scrollTop];
    const [x0, y0] = pt(ev);
    const base = ev.metaKey || ev.shiftKey ? new Set(P.selected) : new Set();
    let band = null, last = ev;
    const update = () => {
      let [x1, y1] = pt(last);
      x1 = Math.max(0, Math.min(L.scrollWidth, x1)); y1 = Math.max(0, Math.min(L.scrollHeight, y1));
      if (!band) {
        if (Math.abs(x1 - x0) < 4 && Math.abs(y1 - y0) < 4) return;
        band = el("div", "band"); L.append(band);
      }
      const [a, b, c, d] = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
      Object.assign(band.style, { left: a + "px", top: b + "px", width: c - a + "px", height: d - b + "px" });
      const hit = V().indicesIn(a, b, c, d);
      const sel = new Set(base);
      hit.forEach((i) => { const p = P.entries[i].path; if (ev.metaKey && base.has(p)) sel.delete(p); else sel.add(p); });
      P.selected = sel;
      if (hit.length) { P.cursor = hit[hit.length - 1]; if (P.anchor < 0) P.anchor = hit[0]; }
      P.reflect();
    };
    // Auto-scroll while the pointer is above / below the listing.
    const scroller = setInterval(() => {
      const y = last.clientY;
      const dy = y < lr.top ? y - lr.top : y > lr.bottom ? y - lr.bottom : 0;
      if (band && dy) { L.scrollTop += Math.max(-40, Math.min(40, dy)); update(); }
    }, 30);
    const move = (e) => { last = e; update(); };
    const up = () => {
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up, true);
      clearInterval(scroller);
      if (band) { band.remove(); bandJustEnded = true; setTimeout(() => (bandJustEnded = false), 0); }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up, true);
    ev.preventDefault(); // no text selection
  });
  els.listing.addEventListener("dblclick", (ev) => {
    if (ev.target.closest(".disc")) return;
    const row = ev.target.closest(".row"); if (!row) return;
    const e = P.entries[+row.dataset.i];
    if (isFolder(e) && ev.metaKey) openTab(e.path); // ⌘-double-click → new tab (Finder)
    else P.activate(+row.dataset.i);
  });
  // Middle-click a folder → new tab (Dolphin).
  els.listing.addEventListener("auxclick", (ev) => {
    if (ev.button !== 1) return;
    const row = ev.target.closest(".row"); if (!row) return;
    const e = P.entries[+row.dataset.i];
    if (isFolder(e)) { ev.preventDefault(); openTab(e.path); }
  });

  // ------------------------------------------------------------ drag & drop
  // Press on a row and move: an in-page drag (see dnd.js) that turns into a
  // real macOS drag if it leaves the window. Drops land via registerDropZone.
  let suppressClick = false;
  els.listing.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0 || ev.ctrlKey || ev.target.closest(".disc, input, .rz")) return;
    const row = ev.target.closest(".row"); if (!row) return;
    const i = +row.dataset.i, x0 = ev.clientX, y0 = ev.clientY;
    const move = (e) => {
      if (Math.abs(e.clientX - x0) < 4 && Math.abs(e.clientY - y0) < 4) return;
      stop();
      const entry = P.entries[i]; if (!entry) return;
      if (!P.selected.has(entry.path)) P.selectSingle(i);
      setActive(P);
      suppressClick = true; // the mouseup after a drag is not a click
      startDrag(P, P.selectedEntries(), ev);
    };
    const stop = () => { window.removeEventListener("mousemove", move, true); window.removeEventListener("mouseup", stop, true); };
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", stop, true);
  });
  els.listing.addEventListener("click", (ev) => { if (suppressClick) { suppressClick = false; ev.stopImmediatePropagation(); } }, true);
  window.addEventListener("mousedown", () => (suppressClick = false), true);
  registerDropZone({
    root: els.listing,
    over: (n, data) => {
      if (!P.cwd && !n.closest(".row")) return null;
      const row = n.closest(".row");
      const e = row && P.entries[+row.dataset.i];
      if (isFolder(e) && !data.paths.includes(e.path)) return { el: row, dest: e.path };
      // Columns: a folder in a side column, or a column's empty space = that folder.
      const mr = !row && n.closest(".mrow");
      if (mr && mr.dataset.dir && !data.paths.includes(mr.dataset.path)) return { el: mr, dest: mr.dataset.path };
      const col = n.closest(".mcol[data-path]");
      if (col && P.mode === "browse") return { el: col, cls: "drop-target", dest: col.dataset.path };
      return P.cwd && P.mode === "browse" ? { el: els.listing, cls: "drop-target", dest: P.cwd } : null;
    },
  });

  els.listing.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    setActive(P);
    const row = ev.target.closest(".row");
    if (row) { const i = +row.dataset.i; if (!P.selected.has(P.entries[i].path)) P.selectSingle(i); }
    else if (P.selected.size) P.clearSel(); // empty space → the folder menu
    openContextMenu(P, ev.clientX, ev.clientY);
  });
  // The status bar always gives the folder menu, even when rows fill the listing.
  els.status.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    setActive(P);
    if (P.selected.size) P.clearSel();
    openContextMenu(P, ev.clientX, ev.clientY);
  });

  return P;
}
