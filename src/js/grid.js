// Grid view: icons or Quick Look thumbnails in a wrapping grid, Finder's icon
// view. Same contract as details.js (render / paint / reveal / rowAt), and
// the same virtual window: only cells on screen exist, so huge folders stay
// smooth. Cells are ".row.cell" with data-i, so selection, rename, menus,
// drag & drop and git badges work unchanged.

import { app, el, invoke, kindIcon } from "./core.js";
import { tagDots } from "./tags.js";
import { applyGit } from "./git.js";
import { prefs, saveSettings } from "./settings.js";

export const GRID_MIN = 48, GRID_MAX = 256, GRID_DEFAULT = 80;
export const gridSize = () => Math.min(GRID_MAX, Math.max(GRID_MIN, Number(prefs.gridSize) || GRID_DEFAULT));

/** Icon-size slider / keys: resize every grid pane, keeping its top item in place. */
export function setGridSize(v, save = true) {
  prefs.gridSize = Math.min(GRID_MAX, Math.max(GRID_MIN, Math.round(v)));
  if (save) saveSettings();
  document.querySelectorAll("input.gsize").forEach((r) => { if (+r.value !== prefs.gridSize) r.value = prefs.gridSize; });
  app.tabs.forEach((t) => t.panes.forEach((p) => p.cwd && p.viewMode === "grid" && p.resizeGrid()));
}

const PAD = 8;          // around the grid
const LABEL_H = 32;     // two lines of Callout
const OVERSCAN_ROWS = 2;

// ---- Thumbnails: one shared cache and a small queue (6 at a time) ----
const BUCKETS = [32, 48, 64, 96, 128, 192, 256];
const bucket = (s) => BUCKETS.find((b) => b >= s) || 256;
const cache = new Map();   // key -> {data, kind} | null (none)
const waiting = new Map(); // key -> {path, px, hosts:Set<Element>}
const order = [];          // keys, newest last
let running = 0;
const CACHE_MAX = 3000;

function thumbKey(e, px) { return `${px}|${e.path}|${e.modified || 0}|${e.size || 0}`; }

function setPic(host, t) {
  if (!t) return;
  const img = new Image();
  img.decoding = "async"; img.draggable = false; img.alt = "";
  img.src = t.data;
  img.className = t.kind === "thumb" ? "thumb" : "icon";
  host.replaceChildren(img);
}

function pump() {
  while (running < 6 && order.length) {
    const key = order.pop(); // newest first: what was just scrolled to
    const job = waiting.get(key);
    if (!job) continue;
    // Nobody on screen wants it any more: forget it (it'll be asked for again).
    for (const h of job.hosts) if (!h.isConnected) job.hosts.delete(h);
    if (!job.hosts.size) { waiting.delete(key); continue; }
    running++;
    invoke("file_thumb", { path: job.path, size: job.px, scale: window.devicePixelRatio || 2 })
      .then((t) => t, () => null)
      .then((t) => {
        running--;
        waiting.delete(key);
        cache.set(key, t);
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
        job.hosts.forEach((h) => h.isConnected && setPic(h, t));
        pump();
      });
  }
}

/** Put e's picture into host: cached now, or the kind glyph until it arrives. */
function loadPic(host, e, size) {
  if (!invoke) return;
  const px = bucket(size), key = thumbKey(e, px);
  if (cache.has(key)) { setPic(host, cache.get(key)); return; }
  const job = waiting.get(key);
  if (job) { job.hosts.add(host); return; }
  waiting.set(key, { path: e.path, px, hosts: new Set([host]) });
  order.push(key); // started by paint(), once the cell is in the page
}

/** Picture for one entry outside the grid (Columns preview). */
export function thumbInto(host, e, size) { loadPic(host, e, size); pump(); }

// ---- The view ----
export function createGrid(P) {
  const L = P.els.listing;
  let body = null, cells = new Map(), paintQueued = 0;
  let size = GRID_DEFAULT, cols = 1, cellW = 100, cellH = 100, layoutKey = "";

  function measure() {
    size = gridSize();
    const avail = Math.max(120, L.clientWidth - 12 - PAD * 2); // .listing has 6px side padding
    const minW = Math.max(size + 28, 92);
    cols = Math.max(1, Math.floor(avail / minW));
    cellW = Math.floor(avail / cols);
    cellH = PAD + size + 6 + LABEL_H + PAD;
    const key = `${cols}|${cellW}|${size}`;
    const moved = key !== layoutKey;
    layoutKey = key;
    if (body) body.style.height = Math.ceil(P.entries.length / cols) * cellH + PAD * 2 + "px";
    return moved;
  }
  const place = (c, i) => {
    c.style.transform = `translate(${PAD + (i % cols) * cellW}px, ${PAD + Math.floor(i / cols) * cellH}px)`;
    c.style.width = cellW + "px"; c.style.height = cellH + "px";
  };

  function cell(i) {
    const e = P.entries[i], clip = app.clip;
    const c = el("div", "row cell"); c.dataset.i = i;
    c.title = P.mode === "search" && e.parent ? `${e.name}\n${e.parent}` : e.name;
    if (P.selected.has(e.path)) c.classList.add("sel");
    if (clip && clip.cut && clip.paths.includes(e.path)) c.classList.add("cut");
    c.style.setProperty("--pic", size + "px");
    const pic = el("div", "gpic");
    pic.style.width = pic.style.height = size + "px";
    pic.append(kindIcon(e.name, e.is_dir));
    const nm = el("span", "nm");
    e.name.split(/(?<=[_\-.])/).forEach((part, j) => { if (j) nm.append(document.createElement("wbr")); nm.append(part); });
    c.append(pic, nm);
    if (e.is_symlink) c.append(el("span", "link", "↳"));
    const td = tagDots(e.tags); if (td) c.append(td);
    place(c, i);
    loadPic(pic, e, size);
    return c;
  }

  function paint() {
    paintQueued = 0;
    if (!body) return;
    if (measure()) cells.forEach((c, i) => place(c, i));
    const top = body.offsetTop, view = L.clientHeight || 600, n = P.entries.length;
    const r0 = Math.max(0, Math.floor((L.scrollTop - top - PAD) / cellH) - OVERSCAN_ROWS);
    const r1 = Math.ceil((L.scrollTop + view - top) / cellH) + OVERSCAN_ROWS;
    const first = r0 * cols, last = Math.min(n - 1, (r1 + 1) * cols - 1);
    for (const [i, c] of cells) {
      if ((i < first || i > last) && !c.querySelector("input.rename")) { c.remove(); cells.delete(i); }
    }
    const frag = document.createDocumentFragment();
    for (let i = first; i <= last; i++) if (!cells.has(i)) { const c = cell(i); cells.set(i, c); frag.append(c); }
    body.append(frag);
    pump();
    applyGit(P);
  }
  const queuePaint = () => { if (!paintQueued && P.viewMode === "grid") paintQueued = requestAnimationFrame(paint); };
  L.addEventListener("scroll", queuePaint, { passive: true });
  if (window.ResizeObserver) new ResizeObserver(queuePaint).observe(L);

  function render() {
    L.classList.toggle("searching", P.mode === "search");
    L.innerHTML = "";
    cells = new Map(); body = null; layoutKey = "";
    if (paintQueued) { cancelAnimationFrame(paintQueued); paintQueued = 0; }
    if (!P.entries.length) {
      const e = el("div", "empty-state");
      const none = P.mode === "search" || P.base.length;
      e.append(el("span", "big", none ? "∅" : "📂"));
      e.append(el("span", "msg", none ? "Nothing matched here." : "This folder is empty."));
      L.append(e);
      return;
    }
    body = el("div", "gbody");
    L.append(body);
    measure();
    paint();
  }

  /** Icon size changed: redraw at the new size with the same item at the top. */
  function resize() {
    if (!body) return;
    const topIdx = Math.max(0, Math.floor((L.scrollTop - body.offsetTop - PAD) / cellH)) * cols;
    cells.forEach((c) => c.remove()); cells = new Map();
    measure();
    L.scrollTop = body.offsetTop + Math.floor(topIdx / cols) * cellH;
    paint();
  }

  function reveal(i) {
    if (!body || i < 0 || i >= P.entries.length) return;
    measure();
    const y = body.offsetTop + PAD + Math.floor(i / cols) * cellH;
    if (y < L.scrollTop) L.scrollTop = y - PAD;
    else if (y + cellH > L.scrollTop + L.clientHeight) L.scrollTop = y + cellH - L.clientHeight + PAD;
    paint();
  }

  /** Entries whose cell meets the rectangle (listing content coordinates). */
  function indicesIn(x0, y0, x1, y1) {
    if (!body) return [];
    const top = body.offsetTop + PAD, left = 6 + PAD, out = [];
    const c0 = Math.max(0, Math.floor((x0 - left) / cellW)), c1 = Math.min(cols - 1, Math.floor((x1 - left) / cellW));
    const r0 = Math.max(0, Math.floor((y0 - top) / cellH)), r1 = Math.floor((y1 - top) / cellH);
    if (x1 < left || c0 > c1) return out;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const i = r * cols + c; if (i < P.entries.length) out.push(i); }
    return out;
  }

  return {
    render, paint, reveal, indicesIn, resize,
    rowAt: (i) => cells.get(i) || null,
    isTile: () => false,
    perRow: () => cols,
  };
}

