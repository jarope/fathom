// Usage view: each item of the folder with its real footprint (a folder's
// whole tree), largest first, a quiet bar behind the figures — Aloft's disk
// usage readout inside Fathom. Sizes stream in from `usage_scan` and are
// cached per path, so going back up is instant; auto-refresh drops the
// cached sizes of the folder that changed and the folders above it.

import { app, invoke, listen, el, store, fmtSize } from "./core.js";

const cache = new Map();   // path -> { bytes, partial } (finished measures only)
const runs = new Map();    // scan id -> pane
let listening = false;

/** "folder": share of what's listed here · "disk": share of the whole volume. */
export const shareMode = () => (store.get("fathom-usage-share", "folder") === "disk" ? "disk" : "folder");
function setShareMode(m) {
  store.set("fathom-usage-share", m);
  app.tabs.forEach((t) => t.panes.forEach((p) => p.viewMode === "usage" && p.cwd && (p.renderList(), p.renderStatus())));
}

const state = (P) => (P.usage ||= { key: null, id: 0, gen: 0, sizes: new Map(), pending: new Set(), t0: 0, ms: 0, timer: 0 });

/** Measured bytes for an entry (null while unknown). */
export const usageOf = (P, e) => (P.usage && P.usage.sizes.get(e.path)) || null;
/** Sort value: unknown sizes sink to the bottom. */
export const usageBytes = (P, e) => { const u = usageOf(P, e); return u ? u.bytes : -1; };
/** What the Share column divides by. */
export function usageTotal(P) {
  if (shareMode() === "disk") return P.space ? P.space.total : 0;
  let t = 0; P.base.forEach((e) => { const u = usageOf(P, e); if (u) t += u.bytes; });
  return t;
}

async function ensureListening() {
  if (listening || !listen) return;
  listening = true;
  await listen("usage-item", ({ payload: r }) => {
    const P = runs.get(r.id); if (!P || !P.usage || P.usage.id !== r.id) return;
    const s = P.usage;
    s.sizes.set(r.path, { bytes: r.bytes, partial: r.partial, done: r.done });
    if (r.done) { s.pending.delete(r.path); cache.set(r.path, { bytes: r.bytes, partial: r.partial }); }
    schedule(P);
  });
  await listen("usage-done", ({ payload: r }) => {
    const P = runs.get(r.id); runs.delete(r.id);
    if (!P || !P.usage || P.usage.id !== r.id) return;
    P.usage.id = 0; P.usage.pending.clear(); P.usage.ms = performance.now() - P.usage.t0;
    schedule(P, 0);
  });
}

// Redraw at most a few times a second while sizes pour in (re-sorting too,
// so the biggest items rise to the top as they're found). Selection is by path.
function schedule(P, wait = 400) {
  const s = P.usage;
  if (s.timer && wait) return;
  clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.timer = 0;
    if (P.viewMode !== "usage" || !P.cwd) return;
    const sel = P.selectedPaths(), cur = P.entries[P.cursor] ? P.entries[P.cursor].path : null, top = P.scroller().scrollTop;
    P.rebuild();
    P.renderList(); P.selectPaths(sel);
    if (cur) P.cursor = P.entries.findIndex((e) => e.path === cur);
    P.scroller().scrollTop = top;
    P.renderStatus();
  }, wait);
}

export function cancelUsage(P) {
  const s = P.usage; if (!s) return;
  s.gen++;
  if (s.id) { invoke("usage_cancel", { id: s.id }).catch(() => {}); runs.delete(s.id); s.id = 0; }
  s.pending.clear();
}

/** Called on every render in Usage: measure whatever on screen isn't known yet. */
export async function ensureUsage(P) {
  if (!invoke || !P.cwd) return;
  const s = state(P), key = P.mode + "|" + P.cwd;
  if (s.key !== key) { cancelUsage(P); s.key = key; s.sizes = new Map(); s.ms = 0; }
  const missing = [];
  for (const e of P.base) {
    if (s.sizes.has(e.path) && s.sizes.get(e.path).done) continue;
    const c = cache.get(e.path);
    if (c) { s.sizes.set(e.path, { ...c, done: true }); continue; }
    if (!s.pending.has(e.path)) missing.push(e.path);
  }
  if (!missing.length) return;
  const todo = [...new Set([...s.pending, ...missing])];
  s.pending = new Set(todo); s.t0 = performance.now(); s.ms = 0;
  const gen = ++s.gen;
  if (s.id) { invoke("usage_cancel", { id: s.id }).catch(() => {}); runs.delete(s.id); s.id = 0; } // restart with the full to-do list
  await ensureListening();
  if (gen !== s.gen || s.key !== key) return; // moved on meanwhile
  // Smallest-looking first (files, then folders) so the list fills quickly.
  const byPath = new Map(P.base.map((e) => [e.path, e]));
  todo.sort((a, b) => (byPath.get(a)?.is_dir ? 1 : 0) - (byPath.get(b)?.is_dir ? 1 : 0));
  const id = await invoke("usage_scan", { paths: todo });
  if (gen !== s.gen || s.key !== key) { invoke("usage_cancel", { id }).catch(() => {}); return; } // superseded
  s.id = id; runs.set(id, P);
}

/** Forget measures at and above `dir` (something inside it changed). */
export function invalidateUsage(dir) {
  if (!cache.size || !dir) return;
  for (let p = dir; p && p !== "/"; p = p.slice(0, p.lastIndexOf("/")) || "/") cache.delete(p);
}

/** ⟳: measure this folder's items again from scratch. */
export function remeasure(P) {
  cancelUsage(P);
  P.base.forEach((e) => cache.delete(e.path));
  if (P.usage) { P.usage.sizes = new Map(); P.usage.ms = 0; }
  P.renderList(); P.renderStatus();
}

/** Status bar pieces in Usage: progress / total, partial warning, share toggle, ⟳. */
export function usageStatus(P) {
  const s = state(P), out = [];
  let known = 0, total = 0, partial = 0;
  P.base.forEach((e) => { const u = usageOf(P, e); if (u && u.done) { known++; total += u.bytes; if (u.partial) partial++; } });
  if (s.pending.size) out.push(el("span", "msg", `Measuring… ${known.toLocaleString()} of ${P.base.length.toLocaleString()}`));
  else out.push(el("span", "mono", `${fmtSize(total, false)} measured` + (s.ms > 50 ? ` in ${(s.ms / 1000).toFixed(1)} s` : "")));
  if (partial) {
    const w = el("span", "warn", `⚠ ${partial} partial`);
    w.title = "Some items couldn't be fully read (macOS privacy protection or permissions), so their sizes are a lower bound.";
    out.push(w);
  }
  const seg = el("span", "seg useg");
  [["folder", "% of folder"], ["disk", "% of disk"]].forEach(([m, label]) => {
    const b = el("button", "seg-b" + (shareMode() === m ? " on" : ""), label); b.type = "button";
    b.title = m === "folder" ? "Share of everything listed here" : "Share of the whole disk's capacity";
    b.addEventListener("click", () => setShareMode(m));
    seg.append(b);
  });
  out.push(seg);
  // Its own pill, styled like the % toggle's inactive segment so the two match in height.
  const rp = el("span", "seg upill"), rb = el("button", "seg-b ubtn"); rb.type = "button"; rp.append(rb);
  rb.innerHTML = '<svg viewBox="3.2 3.2 13.6 13.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M16 10a6 6 0 1 1-1.76-4.24"/><path d="M16 3.5v3.5h-3.5"/></svg>'; rb.title = "Measure again"; rb.setAttribute("aria-label", "Measure again");
  rb.addEventListener("click", () => remeasure(P));
  out.push(rp);
  return out;
}
