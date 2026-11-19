// A file pane: breadcrumb path bar, live filter / recursive search, listing,
// selection, rename, drag & drop and status line. Tabs own two of these.

import { app, invoke, el, icon, fmtSize, fmtDate } from "./core.js";
import { isImage, isVideo } from "./previews.js";
import { pushUndo, refreshAll, selectEverywhere, trashPaths } from "./ops.js";
import { openContextMenu, showMenu } from "./menu.js";
import { setActive, openTab } from "./tabs.js";
import { registerDropZone, startDrag } from "./dnd.js";
import { tagDots } from "./tags.js";
import { loadGit, applyGit, gitChip } from "./git.js";
import { usesSpotlight, startSpotlight, cancelSpotlight, searchMenu, placeholder, modeLabel } from "./search.js";

const TEMPLATE = `
  <div class="ptoolbar">
    <div class="navbtns">
      <button class="nb b-back" type="button" title="Back (⌘[)">◀</button>
      <button class="nb b-fwd" type="button" title="Forward (⌘])">▶</button>
      <button class="nb b-up" type="button" title="Up (⌘↑)">▲</button>
      <button class="nb b-new" type="button" title="New folder (⇧⌘N)">＋</button>
      <button class="nb b-home" type="button" title="Home">⌂</button>
    </div>
    <div class="pathwrap" title="Click a folder to go there · › lists sub-folders · click blank space or ⌘L to type a path">
      <div class="crumbs"></div>
      <input class="path" type="text" spellcheck="false" autocomplete="off" />
    </div>
    <div class="searchwrap"><button class="smode" type="button" title="Search options — names or contents, here or the whole Mac">🔍<span class="smode-l"></span></button><input class="search" type="text" spellcheck="false" autocomplete="off" /></div>
  </div>
  <div class="listing"></div>
  <div class="pstatus"></div>`;

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

  const P = {
    key, root, els, tab: null,
    // base = everything in the folder (or search hits); entries = base after the live filter, sorted.
    cwd: null, parent: null, base: [], entries: [], selected: new Set(), space: null,
    anchor: -1, cursor: -1, mode: "browse", showHidden: false,
    history: [], hi: -1, msgTimer: null,
    sortKey: "name", sortDir: 1, // 1 asc, -1 desc; folders always first
    renaming: false, pendingRefresh: false, editing: false,
  };
  const changed = () => app.hooks.changed(P);
  const rowAt = (i) => els.listing.querySelector(`.row[data-i="${i}"]`);
  const reveal = (i) => { const r = rowAt(i); if (r) r.scrollIntoView({ block: "nearest", inline: "nearest" }); };

  // ---------------------------------------------------------------- status
  P.renderStatus = (extra) => {
    els.status.innerHTML = "";
    const n = P.entries.length, total = P.base.length;
    els.status.append(el("span", "count", n.toLocaleString()), el("span", null, ` item${n === 1 ? "" : "s"}`));
    if (n !== total) els.status.append(el("span", null, ` of ${total.toLocaleString()} (filtered)`));
    if (P.selected.size) els.status.append(el("span", null, " · "), el("span", "sel", `${P.selected.size} selected`));
    els.status.append(el("span", "grow"));
    const gc = gitChip(P); if (gc) els.status.append(gc);
    if (extra && extra !== P.flashMsg) P.flashMsg = null; // a newer message replaces it
    extra = extra || P.flashMsg; // a recent message survives redraws
    if (extra) els.status.append(extra);
    else if (P.space) els.status.append(el("span", "mono", `${fmtSize(P.space.free, false)} free of ${fmtSize(P.space.total, false)}`));
  };
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
    catch (e) { P.flash("⚠ " + e, "warn"); return false; }
    const moved = listing.dir !== P.cwd;
    const keep = keepSel && !moved;
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
    invoke("free_space", { path: listing.dir }).then((s) => { P.space = s; P.renderStatus(); }).catch(() => {});
    return true;
  };
  P.reload = () => (P.cwd ? P.navigate(P.cwd, { push: false, keepFilter: true, keepSel: true }) : Promise.resolve(false));
  /** Auto-refresh entry point: never disturbs an inline rename or search results. */
  P.refresh = () => {
    if (!P.cwd || P.mode !== "browse") return;
    if (P.renaming) { P.pendingRefresh = true; return; }
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
  P.applyFilter = () => {
    // Query helpers (kind:pdf…) only apply when ⏎ runs a search.
    const f = P.spotResults ? "" : els.search.value.replace(/\b(kind|type|modified|date|size|tag):("[^"]*"|\S+)/gi, "").trim();
    let keep = P.base;
    if (f) {
      if (/[*?]/.test(f)) { const re = globRe(f); keep = P.base.filter((e) => re.test(e.name)); }
      else { const lf = f.toLowerCase(); keep = P.base.filter((e) => e.name.toLowerCase().includes(lf)); }
    }
    P.entries = keep.slice();
    P.applySort();
    els.searchwrap.classList.toggle("filtering", !!f && P.mode === "browse");
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
    if (usesSpotlight()) { startSpotlight(P, query); return; }
    P.spotResults = false;
    els.searchwrap.classList.add("active");
    P.renderStatus(el("span", "spinner"));
    let res;
    try { res = await invoke("search", { req: { root: P.cwd, query, case_insensitive: true, include_dirs: true, include_hidden: P.showHidden } }); }
    catch (e) { P.flash("⚠ " + e, "warn"); return; }
    P.base = res.hits; P.entries = res.hits.slice(); P.applySort(); P.mode = "search";
    P.selected.clear(); P.anchor = -1; P.cursor = -1;
    els.searchwrap.classList.remove("filtering");
    P.renderList();
    P.renderStatus(el("span", "msg", `${res.hits.length.toLocaleString()} found · ${res.elapsed_ms} ms${res.truncated ? " · capped" : ""}`));
    changed();
  };
  /** Show an arbitrary list of entries (tag / Spotlight results) like search results. */
  P.showResults = (entries, msg, busy = false) => {
    P.base = entries; P.entries = entries.slice(); P.applySort(); P.mode = "search";
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
    const row = rowAt(i); if (!row) return;
    row.scrollIntoView({ block: "nearest" });
    const e = P.entries[i];
    const input = el("input", "rename");
    input.value = e.name; input.spellcheck = false; input.autocomplete = "off";
    row.querySelector(".nm").replaceWith(input);
    row.setAttribute("draggable", "false");
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
    P.renderStatus(); changed();
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
  P.moveCursor = (dir, extend) => {
    if (!P.entries.length) return;
    let i = P.cursor;
    i = dir > 0 ? Math.min(P.entries.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1);
    if (extend && P.anchor >= 0) P.selectRange(P.anchor, i); else P.selectSingle(i);
    reveal(i);
  };
  // Type-ahead: typing letters jumps to the first matching name.
  let taBuf = "", taTimer = null;
  P.typeAhead = (ch) => {
    taBuf += ch.toLowerCase();
    clearTimeout(taTimer); taTimer = setTimeout(() => (taBuf = ""), 900);
    const i = P.entries.findIndex((e) => e.name.toLowerCase().startsWith(taBuf));
    if (i >= 0) { P.selectSingle(i); reveal(i); }
  };
  P.activate = (i) => { const e = P.entries[i]; if (e.is_dir) P.navigate(e.path); else invoke("open_path", { path: e.path }); };
  P.enterOrOpen = () => {
    const sel = P.selectedEntries();
    if (sel.length === 1) P.activate(P.entries.indexOf(sel[0]));
    else sel.filter((x) => !x.is_dir).forEach((x) => invoke("open_path", { path: x.path }));
  };

  P.trashSelected = () => trashPaths(P, P.selectedPaths());


  // ------------------------------------------------------------------- sort
  P.applySort = () => {
    const k = P.sortKey, d = P.sortDir;
    P.entries.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      let r;
      if (k === "size") r = a.size - b.size;
      else if (k === "modified") r = (a.modified || 0) - (b.modified || 0);
      else if (k === "folder") r = a.parent.toLowerCase().localeCompare(b.parent.toLowerCase());
      else r = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      if (r === 0) r = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      return r * d;
    });
  };
  P.sortBy = (k) => {
    if (P.sortKey === k) P.sortDir = -P.sortDir;
    else { P.sortKey = k; P.sortDir = k === "name" || k === "folder" ? 1 : -1; } // size/date default newest/largest first
    const selPaths = P.selectedPaths();
    P.applySort(); P.cursor = -1; P.anchor = -1;
    P.renderList(); P.selectPaths(selPaths); changed(); app.hooks.save();
  };

  // ----------------------------------------------------------------- render
  P.renderList = () => {
    els.listing.classList.toggle("searching", P.mode === "search");
    els.listing.innerHTML = "";
    if (!P.entries.length) {
      const e = el("div", "empty-state");
      const none = P.mode === "search" || P.base.length;
      e.append(el("span", "big", none ? "∅" : "📂"));
      e.append(el("span", "msg", none ? "Nothing matched here." : "This folder is empty."));
      els.listing.append(e);
      return;
    }
    const head = el("div", "head");
    const mkHead = (label, k, cls) => {
      const c = el("span", "hcell" + (cls ? " " + cls : "") + (P.sortKey === k ? " active" : ""));
      c.append(el("span", null, label));
      if (P.sortKey === k) c.append(el("span", "arrow", P.sortDir === 1 ? "▲" : "▼"));
      c.addEventListener("click", () => P.sortBy(k));
      return c;
    };
    if (P.mode === "search") head.append(mkHead("Name", "name"), mkHead("Folder", "folder"), mkHead("Size", "size", "c-size"), mkHead("Modified", "modified", "c-date"));
    else head.append(mkHead("Name", "name"), mkHead("Size", "size", "c-size"), mkHead("Modified", "modified", "c-date"));

    const clip = app.clip;
    // Folder shelf: sub-folders collapse into one horizontally scrolling row of
    // tiles above the file list. Tiles are ".row"s too (same data-i), so
    // selection, open, rename, drag/drop and menus all work unchanged.
    const shelf = app.folderShelf && P.mode === "browse";
    const nDirs = shelf ? P.entries.filter((e) => e.is_dir).length : 0; // folders sort first
    if (nDirs) {
      const s = el("div", "shelf");
      for (let i = 0; i < nDirs; i++) {
        const h = P.entries[i];
        const t = el("div", "row tile"); t.dataset.i = i; t.setAttribute("draggable", "true"); t.title = h.name;
        if (P.selected.has(h.path)) t.classList.add("sel");
        if (clip && clip.cut && clip.paths.includes(h.path)) t.classList.add("cut");
        const nm = el("span", "nm");
        // Prefer wrapping long names after _ - . rather than mid-word.
        h.name.split(/(?<=[_\-.])/).forEach((part, j) => { if (j) nm.append(document.createElement("wbr")); nm.append(part); });
        t.append(icon("folderFill"), nm);
        if (h.is_symlink) t.append(el("span", "link", "↳"));
        const td = tagDots(h.tags); if (td) t.append(td);
        s.append(t);
      }
      els.listing.append(s);
    }
    if (nDirs < P.entries.length) els.listing.append(head); // column header only when there are list rows

    const frag = document.createDocumentFragment();
    P.entries.forEach((h, i) => {
      if (i < nDirs) return;
      const row = el("div", "row"); row.dataset.i = i; row.setAttribute("draggable", "true");
      if (P.selected.has(h.path)) row.classList.add("sel");
      if (clip && clip.cut && clip.paths.includes(h.path)) row.classList.add("cut");
      const name = el("div", "c-name" + (h.is_dir ? " dir" : ""));
      name.append(el("span", "ic", h.is_dir ? "📁" : isVideo(h.name) ? "🎬" : isImage(h.name) ? "🖼" : "📄"));
      name.append(el("span", "nm", h.name));
      if (h.is_symlink) name.append(el("span", "link", "↳"));
      const td = tagDots(h.tags); if (td) name.append(td);
      name.title = h.name;
      row.append(name);
      if (P.mode === "search") { const f = el("div", "c-folder", h.parent); f.title = h.parent; row.append(f); }
      row.append(el("div", "c-size", fmtSize(h.size, h.is_dir)));
      row.append(el("div", "c-date", fmtDate(h.modified)));
      frag.append(row);
    });
    els.listing.append(frag);
    applyGit(P);
  };

  // --------------------------------------------------------- pointer input
  root.addEventListener("mousedown", () => setActive(P), true);
  els.listing.addEventListener("click", (ev) => {
    const row = ev.target.closest(".row");
    if (!row) { if (!ev.target.closest(".head") && P.selected.size) P.clearSel(); return; } // empty space clears
    const i = +row.dataset.i;
    if (ev.metaKey || ev.ctrlKey) P.toggleOne(i);
    else if (ev.shiftKey && P.anchor >= 0) P.selectRange(P.anchor, i);
    else P.selectSingle(i);
  });
  els.listing.addEventListener("dblclick", (ev) => {
    const row = ev.target.closest(".row"); if (!row) return;
    const e = P.entries[+row.dataset.i];
    if (e.is_dir && ev.metaKey) openTab(e.path); // ⌘-double-click → new tab (Finder)
    else P.activate(+row.dataset.i);
  });
  // Middle-click a folder → new tab (Dolphin).
  els.listing.addEventListener("auxclick", (ev) => {
    if (ev.button !== 1) return;
    const row = ev.target.closest(".row"); if (!row) return;
    const e = P.entries[+row.dataset.i];
    if (e.is_dir) { ev.preventDefault(); openTab(e.path); }
  });

  // ------------------------------------------------------------ drag & drop
  // Dragging rows starts a native macOS drag (see dnd.js), so files can go
  // to Finder and other apps too; drops land here via registerDropZone.
  els.listing.addEventListener("dragstart", (ev) => {
    const row = ev.target.closest(".row"); if (!row) return;
    ev.preventDefault();
    const i = +row.dataset.i;
    if (!P.selected.has(P.entries[i].path)) P.selectSingle(i);
    setActive(P);
    startDrag(P, P.selectedEntries());
  });
  registerDropZone({
    root: els.listing,
    over: (n, data) => {
      if (!P.cwd && !n.closest(".row")) return null;
      const row = n.closest(".row");
      const e = row && P.entries[+row.dataset.i];
      if (e && e.is_dir && !data.paths.includes(e.path)) return { el: row, dest: e.path };
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

  return P;
}
