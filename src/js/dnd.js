// Drag & drop, all native. Dragging rows starts a real macOS drag session
// (so files can go to Finder, Mail, Slack…), and every drop into Fathom —
// from itself or any other app — arrives as Tauri's drag events with a
// position. Drop zones (lists, breadcrumbs, tabs, sidebar) register here and
// are hit-tested with elementFromPoint.
//
// Copy or move follows Finder: same disk = move, other disk = copy,
// ⌥ = copy, ⌘ = move (decided by the backend at drop time).

import { app, invoke, listen } from "./core.js";
import { getZoom } from "./view.js";
import { performTransfer } from "./ops.js";

const zones = [];
let cue = null;     // { el, cls } currently highlighted
let hotZone = null; // zone currently under the pointer

/**
 * zone = { root, over(el, data) → target | null, leave?() }
 * target = { el, cls?, dest?: folder path, act?: (data) => void }
 */
export function registerDropZone(zone) { zones.push(zone); }

/** Start a native drag of the given entries (called from a row's dragstart). */
export function startDrag(P, entries) {
  app.dragData = { paths: entries.map((e) => e.path), dirs: entries.filter((e) => e.is_dir).map((e) => e.path), source: P };
  invoke("start_drag", { paths: app.dragData.paths }).catch((e) => { app.dragData = null; P.flash("⚠ " + e, "warn"); });
}

function setCue(t) {
  if (cue && (!t || cue.el !== t.el || cue.cls !== (t.cls || "drop-into"))) { cue.el.classList.remove(cue.cls); cue = null; }
  if (t && !cue) { cue = { el: t.el, cls: t.cls || "drop-into" }; cue.el.classList.add(cue.cls); }
}

function targetAt(pos) {
  const z = getZoom();
  const el = document.elementFromPoint(pos.x / z, pos.y / z);
  if (!el || !app.dragData) return { zone: null, t: null };
  for (const zone of zones) {
    if (!zone.root.isConnected || !zone.root.contains(el)) continue;
    return { zone, t: zone.over(el, app.dragData) };
  }
  return { zone: null, t: null };
}

function hover(pos) {
  const { zone, t } = targetAt(pos);
  if (hotZone && hotZone !== zone && hotZone.leave) hotZone.leave();
  hotZone = zone;
  setCue(t);
}

function reset() {
  setCue(null);
  if (hotZone && hotZone.leave) hotZone.leave();
  hotZone = null;
}

/** A plain move onto the folder the items already live in does nothing. */
const parentOf = (p) => p.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";

async function drop(pos) {
  const { t } = targetAt(pos);
  const data = app.dragData;
  reset();
  app.dragData = null;
  if (!t || !data) return;
  if (t.act) { t.act(data); return; }
  if (!t.dest) return;
  let copy = false;
  try { copy = (await invoke("drop_action", { sources: data.paths, destDir: t.dest })).copy; } catch {}
  if (!copy && data.paths.every((p) => parentOf(p) === t.dest)) return;
  performTransfer(data.paths, t.dest, copy);
}

export async function initDnd() {
  if (!listen) return;
  await listen("tauri://drag-enter", (e) => {
    const paths = e.payload.paths || [];
    if (!app.dragData) {
      if (!paths.length) return; // not files (text, a link…)
      const d = { paths, dirs: null, source: null, external: true };
      app.dragData = d;
      invoke("classify_paths", { paths }).then((isDir) => { d.dirs = paths.filter((_, i) => isDir[i]); }).catch(() => { d.dirs = []; });
    }
    hover(e.payload.position);
  });
  await listen("tauri://drag-over", (e) => { if (app.dragData) hover(e.payload.position); });
  await listen("tauri://drag-drop", (e) => {
    if (!app.dragData && e.payload.paths?.length) app.dragData = { paths: e.payload.paths, dirs: [], source: null, external: true };
    drop(e.payload.position);
  });
  await listen("tauri://drag-leave", () => {
    reset();
    if (app.dragData && app.dragData.external) app.dragData = null; // ours may come back in
  });
  // Our own drag finished (dropped anywhere, or cancelled).
  await listen("native-drag-end", () => setTimeout(() => { reset(); app.dragData = null; }, 0));
}
