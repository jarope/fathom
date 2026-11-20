// Scroll-wheel controls (like a Linux tray volume icon: scroll over it, no
// menu to open).
//
//   over the Aa button             zoom the whole window
//   over the icon-size slider      grid icon size only
//   pinch / ⌘-scroll over the grid grid icon size only
//   pinch / ⌘-scroll over the shelf  shelf tile size only
//   sideways scroll over the shelf scroll the shelf (trackpad, MX side wheel,
//                                  ⇧-scroll) — never the list behind it
//
// One mouse-wheel click = one step (the first movement of a gesture steps at
// once, since macOS can report a notch as only a few pixels); trackpads step
// every ~30 px. A gesture stays with what it started on for as long as it
// keeps going, so zooming that moves the control doesn't hand the rest of the
// scroll to the file list.

import { app } from "./core.js";
import { zoomStep } from "./view.js";
import { gridSize, setGridSize } from "./grid.js";
import { shelfSize, setShelfSize } from "./details.js";

const GESTURE_MS = 300;

const px = (e, v) => (e.deltaMode === 1 ? v * 16 : e.deltaMode === 2 ? v * 400 : v);
const paneOf = (node) => app.tabs.flatMap((t) => t.panes).find((p) => p.root.contains(node)) || app.active;
const zoomGesture = (e) => e.ctrlKey || e.metaKey; // pinch arrives as ctrl + wheel

const iconStep = (node, dir) => {
  setGridSize(gridSize() + dir * 16);
  const P = paneOf(node); if (P) P.flash(`Icon size ${gridSize()} pt`);
};
const shelfStep = (node, dir) => {
  setShelfSize(shelfSize() + dir * 8);
  const P = paneOf(node); if (P) P.flash(`Shelf size ${shelfSize()} pt`);
};

/** What a wheel event is for: { step(dir), px } or null (leave it alone). */
function controlFor(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return null;
  if (t.closest("#zoomBtn")) return { step: (d) => zoomStep(d), px: 30 };
  if (t.closest("input.gsize")) return { step: (d) => iconStep(t, d), px: 30 };
  if (zoomGesture(e)) {
    if (t.closest(".shelf")) return { step: (d) => shelfStep(t, d), px: 12 };
    if (t.closest(".listing.grid")) return { step: (d) => iconStep(t, d), px: 12 };
  }
  return null;
}

let owner = null, acc = 0, at = -1e9;

export function initWheel() {
  window.addEventListener("wheel", (e) => {
    const now = performance.now();
    const going = owner && now - at < GESTURE_MS;

    // Sideways over the shelf: scroll the shelf itself.
    if (!going) {
      const shelf = e.target instanceof Element && e.target.closest(".shelf");
      const dx = px(e, e.deltaX), dy = px(e, e.deltaY);
      const sideways = Math.abs(dx) > Math.abs(dy) ? dx : e.shiftKey && !zoomGesture(e) ? dy : 0;
      if (shelf && sideways) { e.preventDefault(); shelf.scrollLeft += sideways; return; }
    }

    const c = going ? owner : controlFor(e);
    if (!c) { owner = null; return; }
    e.preventDefault(); e.stopPropagation();
    at = now;
    const d = px(e, e.deltaY);
    if (!going) { owner = c; acc = 0; if (d) c.step(d < 0 ? 1 : -1); return; }
    if (!d) return;
    acc += d;
    while (Math.abs(acc) >= c.px) { const dir = acc < 0 ? 1 : -1; c.step(dir); acc += dir * c.px; }
  }, { passive: false, capture: true });
}
