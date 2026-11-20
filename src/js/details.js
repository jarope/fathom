// Details view: the file list as rows with choosable, resizable columns and
// expandable folders. Only the rows on screen exist in the page (a virtual
// window over P.entries), so 50k-entry folders scroll as smoothly as 50.
//
// Layout inside .listing:  [.shelf]  .head  .vbody(height = rows × ROW_H)
// Rows are absolutely positioned in .vbody and keep data-i = their index in
// P.entries, so selection, menus, drag & drop and git badges work unchanged.

import { app, el, icon, kindIcon, kindOf, fmtSize, fmtDate, isFolder } from "./core.js";
import { tagDots } from "./tags.js";
import { fileIcon } from "./icons.js";
import { applyGit } from "./git.js";
import { showMenu } from "./menu.js";
import { prefs, saveSettings } from "./settings.js";

export const ROW_H = 34;  // matches --row-h

// ---- Folder shelf tile size (one setting for every pane) ----
export const SHELF_MIN = 32, SHELF_MAX = 96;
export const shelfSize = () => Math.min(SHELF_MAX, Math.max(SHELF_MIN, Number(prefs.shelfSize) || 46));
let shelfSave = 0;
/** Set the shelf icon size (pinch / ⌘-scroll over the shelf). Saved shortly after the last change. */
export function setShelfSize(v) {
  prefs.shelfSize = Math.min(SHELF_MAX, Math.max(SHELF_MIN, Math.round(v)));
  applyShelfSize();
  clearTimeout(shelfSave); shelfSave = setTimeout(saveSettings, 500);
}
export const applyShelfSize = () => document.documentElement.style.setProperty("--shelf-ic", shelfSize() + "px");
const OVERSCAN = 8;
const INDENT = 16;        // per tree level

// ---- Columns ----
const KIND_WORD = { folder: "Folder", app: "Application", image: "Image", video: "Movie", audio: "Audio", archive: "Archive", code: "Code", doc: "Document" };
export const extOf = (e) => { if (e.is_dir) return ""; const i = e.name.lastIndexOf("."); return i > 0 ? e.name.slice(i + 1).toLowerCase() : ""; };
export function kindLabel(e) {
  const k = kindOf(e.name, e.is_dir), x = extOf(e);
  return k === "folder" || k === "app" || !x ? KIND_WORD[k] : `${x.toUpperCase()} ${KIND_WORD[k]}`;
}
export function permString(e) {
  const m = e.mode || 0; if (!m) return "";
  const t = (b, c) => (m & b ? c : "-");
  return (e.is_dir ? "d" : "-") + t(0o400, "r") + t(0o200, "w") + t(0o100, "x") + t(0o40, "r") + t(0o20, "w") + t(0o10, "x") + t(0o4, "r") + t(0o2, "w") + t(0o1, "x");
}

/** Every optional column: label, default width, cell text, sort key value. */
export const COLUMNS = {
  size:     { label: "Size", w: 84, right: true, text: (e) => fmtSize(e.size, e.is_dir), cls: "c-size" },
  modified: { label: "Modified", w: 140, right: true, text: (e) => fmtDate(e.modified), cls: "c-date" },
  created:  { label: "Created", w: 140, right: true, text: (e) => fmtDate(e.created), cls: "c-date" },
  added:    { label: "Date Added", w: 140, right: true, text: (e) => fmtDate(e.added), cls: "c-date" },
  kind:     { label: "Kind", w: 130, text: kindLabel, cls: "c-kind" },
  ext:      { label: "Extension", w: 76, text: (e) => extOf(e), cls: "c-kind" },
  perms:    { label: "Permissions", w: 104, text: permString, cls: "c-perm" },
};
export const COLUMN_ORDER = ["size", "modified", "created", "added", "kind", "ext", "perms"];
const MIN_W = 48, NAME_MIN = 120, GAP = 12, ROW_PAD = 20;

const shownColumns = () => {
  const c = prefs.columns && Array.isArray(prefs.columns.show) ? prefs.columns.show.filter((k) => COLUMNS[k]) : ["size", "modified"];
  return COLUMN_ORDER.filter((k) => c.includes(k)); // keep a stable order
};
const widthOf = (k) => Math.max(MIN_W, (prefs.columns && prefs.columns.widths && prefs.columns.widths[k]) || COLUMNS[k].w);

/** Sort value for a column key (folder = search results' parent column). */
export function sortValue(e, k) {
  switch (k) {
    case "size": return e.size;
    case "modified": return e.modified || 0;
    case "created": return e.created || 0;
    case "added": return e.added || 0;
    case "kind": return kindLabel(e).toLowerCase();
    case "ext": return extOf(e);
    case "perms": return e.mode || 0;
    case "folder": return (e.parent || "").toLowerCase();
    default: return e.name.toLowerCase();
  }
}

function setColumns(show, widths) {
  prefs.columns = { show, widths: widths || (prefs.columns && prefs.columns.widths) || {} };
  saveSettings();
  app.tabs.forEach((t) => t.panes.forEach((p) => p.cwd && p.renderList()));
}

/** Header right-click: tick columns on and off (Finder's "Show View Options"). */
function columnMenu(x, y) {
  const show = shownColumns();
  showMenu([
    { heading: "Columns" },
    { label: "Name", on: true, disabled: true, fn: () => {} },
    ...COLUMN_ORDER.map((k) => ({
      label: COLUMNS[k].label, on: show.includes(k),
      fn: () => setColumns(show.includes(k) ? show.filter((s) => s !== k) : [...show, k]),
    })),
    "sep",
    { label: "Reset widths", fn: () => setColumns(show, {}) },
  ], x, y);
}

// ---- The view ----
export function createDetails(P) {
  const L = P.els.listing;
  let vbody = null, nDirs = 0, rows = new Map(), cols = [], paintQueued = 0, shelfObs = null;

  // Name fills the spare room until you size it; then it's fixed and an empty
  // track at the end takes up the slack. Too wide for the pane → scroll sideways.
  const nameW = () => { const w = prefs.columns && prefs.columns.widths && prefs.columns.widths.name; return w ? Math.max(NAME_MIN, w) : 0; };
  const template = () => {
    const nw = nameW(), search = P.mode === "search";
    return `${nw ? nw + "px" : "minmax(150px, 1fr)"}${search ? " minmax(140px, 1fr)" : ""} ${cols.map((k) => widthOf(k) + "px").join(" ")}${nw && !search ? " 1fr" : ""}`;
  };
  const setLayout = () => {
    L.style.setProperty("--cols", template());
    const tracks = [nameW() || 150, ...(P.mode === "search" ? [140] : []), ...cols.map(widthOf)];
    L.style.setProperty("--minw", ROW_PAD + tracks.reduce((a, b) => a + b, 0) + GAP * (tracks.length - 1) + "px");
  };

  function head() {
    const h = el("div", "head");
    const cell = (label, k, cls) => {
      const c = el("span", "hcell" + (cls ? " " + cls : "") + (P.sortKey === k ? " active" : ""));
      c.append(el("span", "hl", label));
      if (P.sortKey === k) c.append(el("span", "arrow", P.sortDir === 1 ? "▲" : "▼"));
      c.addEventListener("click", (ev) => { if (!ev.target.closest(".rz")) P.sortBy(k); });
      return c;
    };
    // Each column's right edge is its grip: drag right = wider (Finder).
    const grip = (c, k) => {
      const rz = el("span", "rz"); rz.title = "Drag to resize · double-click to reset";
      rz.addEventListener("mousedown", (ev) => startResize(ev, k, c));
      rz.addEventListener("click", (ev) => ev.stopPropagation());
      rz.addEventListener("dblclick", (ev) => { ev.stopPropagation(); const w = { ...(prefs.columns && prefs.columns.widths) }; delete w[k]; setColumns(shownColumns(), w); });
      c.append(rz);
      return c;
    };
    h.append(grip(cell("Name", "name"), "name"));
    if (P.mode === "search") h.append(cell("Folder", "folder"));
    cols.forEach((k) => h.append(grip(cell(COLUMNS[k].label, k, COLUMNS[k].right ? "right" : ""), k)));
    h.addEventListener("contextmenu", (ev) => { ev.preventDefault(); ev.stopPropagation(); columnMenu(ev.clientX, ev.clientY); });
    return h;
  }

  function startResize(ev, k, c) {
    ev.preventDefault(); ev.stopPropagation();
    const x0 = ev.clientX, w0 = k === "name" ? Math.round(c.getBoundingClientRect().width) : widthOf(k);
    const widths = { ...((prefs.columns && prefs.columns.widths) || {}) };
    document.body.classList.add("col-resizing");
    const move = (e) => {
      widths[k] = Math.max(k === "name" ? NAME_MIN : MIN_W, Math.round(w0 + (e.clientX - x0)));
      prefs.columns = { show: shownColumns(), widths };
      setLayout();
    };
    const up = () => {
      document.body.classList.remove("col-resizing");
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up, true);
      setColumns(shownColumns(), widths); // save + redraw every pane
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up, true);
  }

  function tile(i) {
    const h = P.entries[i], clip = app.clip;
    const t = el("div", "row tile"); t.dataset.i = i; t.title = h.name;
    if (P.selected.has(h.path)) t.classList.add("sel");
    if (clip && clip.cut && clip.paths.includes(h.path)) t.classList.add("cut");
    const nm = el("span", "nm");
    // Prefer wrapping long names after _ - . rather than mid-word.
    h.name.split(/(?<=[_\-.])/).forEach((part, j) => { if (j) nm.append(document.createElement("wbr")); nm.append(part); });
    t.append(icon("folderFill"), nm);
    if (h.is_symlink) t.append(el("span", "link", "↳"));
    const td = tagDots(h.tags); if (td) t.append(td);
    return t;
  }

  function row(i) {
    const h = P.entries[i], clip = app.clip;
    const r = el("div", "row"); r.dataset.i = i;
    r.style.transform = `translateY(${(i - nDirs) * ROW_H}px)`;
    if (P.selected.has(h.path)) r.classList.add("sel");
    if (clip && clip.cut && clip.paths.includes(h.path)) r.classList.add("cut");
    const name = el("div", "c-name" + (h.is_dir ? " dir" : ""));
    if (P.mode === "browse") {
      name.style.paddingLeft = (h.depth || 0) * INDENT + "px";
      const d = el("span", "disc");
      if (isFolder(h)) { d.classList.add("can"); if (P.expanded.has(h.path)) d.classList.add("open"); d.title = P.expanded.has(h.path) ? "Collapse (←)" : "Expand (→)"; d.append(icon("forward")); }
      name.append(d);
    }
    name.append(fileIcon(h), el("span", "nm", h.name));
    if (h.is_symlink) name.append(el("span", "link", "↳"));
    const td = tagDots(h.tags); if (td) name.append(td);
    name.title = h.name;
    r.append(name);
    if (P.mode === "search") { const f = el("div", "c-folder", h.parent); f.title = h.parent; r.append(f); }
    cols.forEach((k) => { const c = COLUMNS[k]; r.append(el("div", c.cls + (c.right ? " right" : ""), c.text(h))); });
    return r;
  }

  /** Draw the rows in (and just around) the scrolled window; reuse the rest. */
  function paint() {
    paintQueued = 0;
    if (!vbody) return;
    const n = P.entries.length - nDirs;
    const top = vbody.offsetTop, view = L.clientHeight || 600;
    const first = Math.max(0, Math.floor((L.scrollTop - top) / ROW_H) - OVERSCAN);
    const last = Math.min(n - 1, Math.ceil((L.scrollTop + view - top) / ROW_H) + OVERSCAN);
    const want = new Set();
    for (let j = first; j <= last; j++) want.add(j + nDirs);
    for (const [i, r] of rows) {
      if (!want.has(i) && !r.querySelector("input.rename")) { r.remove(); rows.delete(i); }
    }
    const frag = document.createDocumentFragment();
    want.forEach((i) => { if (!rows.has(i)) { const r = row(i); rows.set(i, r); frag.append(r); } });
    vbody.append(frag);
    applyGit(P);
  }
  const queuePaint = () => { if (!paintQueued && P.viewMode !== "grid") paintQueued = requestAnimationFrame(paint); };
  L.addEventListener("scroll", queuePaint, { passive: true });
  if (window.ResizeObserver) new ResizeObserver(queuePaint).observe(L);

  /** Rebuild the whole list (new folder, sort, filter, columns, expand). */
  function render() {
    L.classList.toggle("searching", P.mode === "search");
    L.innerHTML = "";
    rows = new Map(); vbody = null;
    if (paintQueued) { cancelAnimationFrame(paintQueued); paintQueued = 0; }
    if (!P.entries.length) {
      const e = el("div", "empty-state");
      const none = P.mode === "search" || P.base.length;
      e.append(el("span", "big", none ? "∅" : "📂"));
      e.append(el("span", "msg", none ? "Nothing matched here." : "This folder is empty."));
      L.append(e);
      return;
    }
    cols = shownColumns();
    setLayout();
    // Folder shelf: top-level folders as a strip of tiles above the rows.
    nDirs = 0;
    if (app.folderShelf && P.mode === "browse") {
      while (nDirs < P.entries.length && isFolder(P.entries[nDirs]) && !(P.entries[nDirs].depth > 0)) nDirs++;
    }
    if (nDirs) {
      // The shelf stays put at the top while the files scroll under it; the
      // column header sits just below it (--shelf-h).
      const s = el("div", "shelf");
      for (let i = 0; i < nDirs; i++) s.append(tile(i));
      L.append(s);
      const fit = () => L.style.setProperty("--shelf-h", s.offsetHeight + "px");
      fit();
      if (shelfObs) shelfObs.disconnect();
      shelfObs = new ResizeObserver(fit); shelfObs.observe(s);
    } else L.style.setProperty("--shelf-h", "0px");
    if (nDirs < P.entries.length) {
      L.append(head());
      vbody = el("div", "vbody");
      vbody.style.height = (P.entries.length - nDirs) * ROW_H + "px";
      L.append(vbody);
      paint();
    }
    applyGit(P); // tiles
  }

  /** Scroll so entry i is fully visible (below the sticky header). */
  function reveal(i) {
    if (i < 0 || i >= P.entries.length) return;
    if (i < nDirs) { const t = L.querySelector(`.tile[data-i="${i}"]`); if (t) t.scrollIntoView({ block: "nearest", inline: "nearest" }); return; }
    if (!vbody) return;
    const headH = (L.querySelector(".head") || { offsetHeight: 0 }).offsetHeight + (L.querySelector(".shelf") || { offsetHeight: 0 }).offsetHeight;
    const y = vbody.offsetTop + (i - nDirs) * ROW_H;
    if (y - headH < L.scrollTop) L.scrollTop = y - headH;
    else if (y + ROW_H > L.scrollTop + L.clientHeight) L.scrollTop = y + ROW_H - L.clientHeight;
    paint();
  }

  const rowAt = (i) => (i < nDirs ? L.querySelector(`.tile[data-i="${i}"]`) : rows.get(i) || null);
  const isTile = (i) => i < nDirs;

  /** Entries whose row or tile meets the rectangle (listing content coordinates). */
  function indicesIn(x0, y0, x1, y1) {
    const out = [];
    if (nDirs) {
      const lr = L.getBoundingClientRect();
      L.querySelectorAll(".tile").forEach((t) => {
        const r = t.getBoundingClientRect();
        const tx = r.left - lr.left + L.scrollLeft, ty = r.top - lr.top + L.scrollTop;
        if (tx < x1 && tx + r.width > x0 && ty < y1 && ty + r.height > y0) out.push(+t.dataset.i);
      });
    }
    if (vbody) {
      const top = vbody.offsetTop, n = P.entries.length - nDirs;
      const a = Math.max(0, Math.floor((y0 - top) / ROW_H)), b = Math.min(n - 1, Math.floor((y1 - top) / ROW_H));
      for (let j = a; j <= b; j++) out.push(j + nDirs);
    }
    return out;
  }

  return { render, paint, reveal, rowAt, isTile, indicesIn, perRow: () => 1 };
}
