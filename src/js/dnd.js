// Drag & drop.
//
// Inside the window a drag is handled by the page itself: press on a row and
// move, a ghost follows the pointer, and drop zones (lists, folders, tabs,
// breadcrumbs, sidebar) light up and take the drop. No macOS drag session is
// involved, so nothing can reject it.
//
// Leave the window with the button still held and the drag becomes a real
// macOS drag (started from the original mouse-down, see dnd.rs), so files can
// go to Finder, Mail, Slack… Drops from other apps arrive as Tauri's drag
// events and use the same drop zones.
//
// Copy or move follows Finder: same disk = move, other disk = copy,
// ⌥ = copy, ⌘ = move (decided by the backend at drop time).

import { app, invoke, listen, el, kindIcon } from "./core.js";
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

function setCue(t) {
  if (cue && (!t || cue.el !== t.el || cue.cls !== (t.cls || "drop-into"))) { cue.el.classList.remove(cue.cls); cue = null; }
  if (t && !cue) { cue = { el: t.el, cls: t.cls || "drop-into" }; cue.el.classList.add(cue.cls); }
}

/** Drop target under a point in page (CSS) coordinates. */
function targetAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el || !app.dragData) return { zone: null, t: null };
  for (const zone of zones) {
    if (!zone.root.isConnected || !zone.root.contains(el)) continue;
    return { zone, t: zone.over(el, app.dragData) };
  }
  return { zone: null, t: null };
}
// Tauri reports window points; the page may be zoomed.
const fromNative = (pos) => { const z = getZoom(); return [pos.x / z, pos.y / z]; };

function hover(x, y) {
  const { zone, t } = targetAt(x, y);
  if (hotZone && hotZone !== zone && hotZone.leave) hotZone.leave();
  hotZone = zone;
  setCue(t);
  return t;
}

function reset() {
  setCue(null);
  if (hotZone && hotZone.leave) hotZone.leave();
  hotZone = null;
}

/** A plain move onto the folder the items already live in does nothing. */
const parentOf = (p) => p.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";

async function dropOn(t, data) {
  if (!t || !data) return;
  if (t.act) { t.act(data); return; }
  if (!t.dest) return;
  let copy = false;
  try { copy = (await invoke("drop_action", { sources: data.paths, destDir: t.dest })).copy; } catch {}
  if (!copy && data.paths.every((p) => parentOf(p) === t.dest)) return;
  performTransfer(data.paths, t.dest, copy);
}

// ---------------------------------------------------------------- in-page drag
/**
 * Start dragging entries of pane P (called once the pointer has moved a few
 * pixels with the button down). `down` is the original mousedown event.
 */
export function startDrag(P, entries, down) {
  const data = { paths: entries.map((e) => e.path), dirs: entries.filter((e) => e.is_dir).map((e) => e.path), source: P };
  app.dragData = data;
  const ghost = el("div", "drag-ghost");
  ghost.append(kindIcon(entries[0].name, entries[0].is_dir), el("span", "dg-name", entries.length === 1 ? entries[0].name : `${entries.length} items`));
  if (entries.length > 1) ghost.append(el("span", "dg-count", String(entries.length)));
  document.body.append(ghost);
  document.body.classList.add("dragging");
  const place = (e) => { ghost.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 10}px)`; };
  place(down);

  let done = false;
  const finish = () => {
    if (done) return; done = true;
    window.removeEventListener("mousemove", move, true);
    window.removeEventListener("mouseup", up, true);
    window.removeEventListener("keydown", key, true);
    ghost.remove();
    document.body.classList.remove("dragging");
    reset();
  };
  const outside = (e) => e.clientX < 0 || e.clientY < 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight;
  const move = (e) => {
    place(e);
    ghost.classList.toggle("copy", e.altKey);
    if (outside(e)) {
      // Leaving the window: carry on as a real macOS drag (Finder, Mail…).
      finish();
      invoke("start_drag", { paths: data.paths }).catch((err) => { app.dragData = null; P.flash("⚠ " + err, "warn"); });
      return;
    }
    hover(e.clientX, e.clientY);
  };
  const up = (e) => {
    const t = hover(e.clientX, e.clientY);
    finish();
    app.dragData = null;
    dropOn(t, data);
  };
  const key = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(); app.dragData = null; }
  };
  window.addEventListener("mousemove", move, true);
  window.addEventListener("mouseup", up, true);
  window.addEventListener("keydown", key, true);
}

// --------------------------------------------------- drops from other apps
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
    hover(...fromNative(e.payload.position));
  });
  await listen("tauri://drag-over", (e) => { if (app.dragData) hover(...fromNative(e.payload.position)); });
  await listen("tauri://drag-drop", (e) => {
    if (!app.dragData && e.payload.paths?.length) app.dragData = { paths: e.payload.paths, dirs: [], source: null, external: true };
    const data = app.dragData;
    const { t } = targetAt(...fromNative(e.payload.position));
    reset();
    app.dragData = null;
    dropOn(t, data);
  });
  await listen("tauri://drag-leave", () => {
    reset();
    if (app.dragData && app.dragData.external) app.dragData = null;
  });
  // Our own macOS drag finished (dropped anywhere, or cancelled).
  await listen("native-drag-end", () => setTimeout(() => { reset(); app.dragData = null; }, 0));
}
