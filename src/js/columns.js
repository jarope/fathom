// Columns view (Miller columns, Finder's column view).
//
//   [ancestor] [ancestor] [ACTIVE = P.cwd] [preview]
//
// The active column is the pane's current folder, so selection, rename,
// menus, drag & drop, git badges and the status bar work unchanged: its rows
// are ".row" with data-i into P.entries. Columns to the left are the folders
// above it (the path highlighted); the last column previews the selection —
// a folder's contents, or a file's picture and details. Their rows are
// ".mrow" (data-path) and are handled here. Every column draws only the rows
// on screen.
//
// Clicking in another column moves the active column there (Finder). → opens
// the selected folder, ← goes back out (see pane.js arrowSide).

import { app, invoke, el, icon, kindIcon, fmtSize, fmtDate, isFolder } from "./core.js";
import { tagDots } from "./tags.js";
import { fileIcon } from "./icons.js";
import { applyGit } from "./git.js";
import { kindLabel } from "./details.js";
import { thumbInto } from "./grid.js";

const ROW_H = 30;
const OVERSCAN = 6;

/** A scrolling column that draws only visible rows. make(i) → row element. */
function vcolumn(count, make, cls = "") {
  const col = el("div", "mcol" + (cls ? " " + cls : ""));
  const body = el("div", "mbody");
  body.style.height = count * ROW_H + "px";
  col.append(body);
  const rows = new Map();
  let queued = 0;
  const paint = () => {
    queued = 0;
    const view = col.clientHeight || 600;
    const first = Math.max(0, Math.floor(col.scrollTop / ROW_H) - OVERSCAN);
    const last = Math.min(count - 1, Math.ceil((col.scrollTop + view) / ROW_H) + OVERSCAN);
    for (const [i, r] of rows) if ((i < first || i > last) && !r.querySelector("input.rename")) { r.remove(); rows.delete(i); }
    const frag = document.createDocumentFragment();
    for (let i = first; i <= last; i++) if (!rows.has(i)) {
      const r = make(i); r.style.transform = `translateY(${i * ROW_H}px)`;
      rows.set(i, r); frag.append(r);
    }
    body.append(frag);
  };
  col.addEventListener("scroll", () => { if (!queued) queued = requestAnimationFrame(paint); }, { passive: true });
  /** Scroll so row i is visible (centred if it was far away). */
  const show = (i, centre = false) => {
    const y = i * ROW_H, h = col.clientHeight || 600;
    if (centre && (y < col.scrollTop || y + ROW_H > col.scrollTop + h)) col.scrollTop = Math.max(0, y - h / 2);
    else if (y < col.scrollTop) col.scrollTop = y;
    else if (y + ROW_H > col.scrollTop + h) col.scrollTop = y + ROW_H - h;
  };
  return { col, paint, rows, show };
}

/** Name cell shared by every column. */
function nameParts(r, e) {
  r.append(fileIcon(e), el("span", "nm", e.name));
  if (e.is_symlink) r.append(el("span", "link", "↳"));
  const td = tagDots(e.tags); if (td) r.append(td);
  if (isFolder(e)) r.append(el("span", "mchev", "›"));
  r.title = e.name;
}

export function createColumns(P) {
  const L = P.els.listing;
  let active = null;        // vcolumn for P.entries
  let preview = null;       // the right-hand column element
  const cache = new Map();  // dir -> { at, entries }
  let gen = 0;              // render generation (drops stale async results)

  async function listing(dir) {
    const c = cache.get(dir);
    if (c && Date.now() - c.at < 3000) return c.entries;
    const l = await invoke("list_dir", { path: dir, showHidden: P.showHidden });
    const entries = P.sortEntries(l.entries);
    cache.set(dir, { at: Date.now(), entries });
    if (cache.size > 40) cache.delete(cache.keys().next().value);
    return entries;
  }

  // ---- side columns (ancestors and the folder preview) ----
  function sideColumn(dir, entries, onPath, cls) {
    const v = vcolumn(entries.length, (i) => {
      const e = entries[i];
      const r = el("div", "mrow" + (e.path === onPath ? " on-path" : ""));
      r.dataset.path = e.path; r.dataset.dir = isFolder(e) ? "1" : "";
      nameParts(r, e);
      return r;
    }, cls);
    v.col.dataset.path = dir;
    v.entries = entries;
    if (!entries.length) v.col.append(el("div", "mempty", "Empty folder"));
    return v;
  }

  /** Click / double-click / right-click in a side column. */
  async function sideAct(ev, kind) {
    const col = ev.target.closest(".mcol"); if (!col || col.classList.contains("active")) return;
    ev.stopImmediatePropagation(); // not the pane's row / empty-space handling
    if (kind === "mousedown") return; // no rubber band / drag here
    const dir = col.dataset.path, row = ev.target.closest(".mrow");
    if (kind === "dblclick") {
      if (!row) return;
      if (row.dataset.dir) P.navigate(row.dataset.path); else invoke("open_path", { path: row.dataset.path });
      return;
    }
    if (kind === "contextmenu") ev.preventDefault();
    if (dir !== P.cwd && !(await P.navigate(dir))) return;
    if (row) P.selectPaths([row.dataset.path]); else P.clearSel();
    if (kind === "contextmenu") {
      const { openContextMenu } = await import("./menu.js");
      openContextMenu(P, ev.clientX, ev.clientY);
    }
  }
  ["click", "dblclick", "contextmenu", "mousedown"].forEach((k) => L.addEventListener(k, (ev) => { if (P.viewMode === "columns" && P.mode === "browse") sideAct(ev, k); }));

  // ---- the active column ----
  function activeColumn() {
    const v = vcolumn(P.entries.length, (i) => {
      const e = P.entries[i], clip = app.clip;
      const r = el("div", "row mrow");
      if (!e) return r; // the list shrank before the next render
      r.dataset.i = i;
      if (P.selected.has(e.path)) r.classList.add("sel");
      if (clip && clip.cut && clip.paths.includes(e.path)) r.classList.add("cut");
      nameParts(r, e);
      return r;
    }, "active");
    v.col.dataset.path = P.cwd;
    if (!P.entries.length) v.col.append(el("div", "mempty", P.base.length ? "Nothing matches" : "Empty folder"));
    const p = v.paint;
    v.paint = () => { p(); applyGit(P); };
    v.col.addEventListener("scroll", () => requestAnimationFrame(() => applyGit(P)), { passive: true });
    return v;
  }

  // ---- the preview column ----
  async function fillPreview(g) {
    if (!preview) return;
    const sel = P.selectedEntries();
    const box = preview;
    const swap = (n) => { if (g !== gen || box !== preview) return; box.replaceWith(n); preview = n; };
    if (sel.length !== 1) {
      const n = el("div", "mcol mpreview");
      if (sel.length > 1) n.append(el("div", "mempty", `${sel.length} items selected`));
      swap(n); return;
    }
    const e = sel[0];
    if (isFolder(e)) {
      let entries;
      try { entries = await listing(e.path); } catch (err) { const n = el("div", "mcol mpreview"); n.append(el("div", "mempty", "⚠ " + err)); swap(n); return; }
      if (g !== gen || P.selectedEntries()[0] !== e) return;
      const v = sideColumn(e.path, entries, null, "mpreview");
      swap(v.col); v.paint();
      return;
    }
    // A file: picture + details (Finder's preview column).
    const n = el("div", "mcol mpreview mfile");
    const pic = el("div", "mpic"); pic.append(kindIcon(e.name, false));
    thumbInto(pic, e, 200);
    const facts = el("dl", "mfacts");
    const fact = (k, v) => { if (v) facts.append(el("dt", null, k), el("dd", null, v)); };
    fact("Kind", kindLabel(e));
    fact("Size", fmtSize(e.size, false));
    fact("Modified", fmtDate(e.modified));
    fact("Created", fmtDate(e.created));
    fact("Added", fmtDate(e.added));
    n.append(pic, el("div", "mtitle", e.name), facts);
    swap(n);
  }

  // ---- render ----
  function render() {
    const g = ++gen;
    L.classList.toggle("searching", false);
    const keepLeft = L.querySelector(".mcols") ? L.scrollLeft : null;
    L.innerHTML = "";
    const strip = el("div", "mcols");
    L.append(strip);

    // Where the columns start: stays put while you move within it (Finder).
    const under = (p, root) => p === root || (root === "/" ? true : p.startsWith(root + "/"));
    if (!P.colRoot || !under(P.cwd, P.colRoot)) P.colRoot = P.cwd;
    const chain = [];
    for (let d = P.cwd; d !== P.colRoot && d !== "/"; ) { const up = d.replace(/\/[^/]+$/, "") || "/"; chain.unshift({ dir: up, onPath: d }); d = up; }

    // Ancestors: placeholders now, filled as their listings arrive.
    const slots = chain.map(() => { const s = el("div", "mcol mside"); strip.append(s); return s; });
    active = activeColumn(); strip.append(active.col);
    preview = el("div", "mcol mpreview"); strip.append(preview);
    active.paint();
    if (P.cursor >= 0) { active.show(P.cursor, true); active.paint(); }
    L.scrollLeft = L.scrollWidth; // the active column and preview in view

    chain.forEach(async (c, k) => {
      let entries;
      try { entries = await listing(c.dir); } catch { return; }
      if (g !== gen) return;
      const v = sideColumn(c.dir, entries, c.onPath, "mside");
      slots[k].replaceWith(v.col);
      const at = entries.findIndex((e) => e.path === c.onPath);
      if (at >= 0) v.show(at, true);
      v.paint();
      if (keepLeft == null) L.scrollLeft = L.scrollWidth;
    });
    fillPreview(g);
  }

  function reveal(i) {
    if (!active || i < 0 || i >= P.entries.length) return;
    active.show(i); active.paint();
  }

  return {
    render, reveal,
    paint: () => active && active.paint(),
    rowAt: (i) => (active && active.rows.get(i)) || null,
    isTile: () => false,
    perRow: () => 1,
    indicesIn: () => [],
    noBand: true,
    selChanged: () => fillPreview(gen),
  };
}
