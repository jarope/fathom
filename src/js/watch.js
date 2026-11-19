// Auto-refresh: the backend watches the folders on screen (FSEvents) and
// emits `fs-changed`; matching panes refresh (debounced), keeping selection,
// scroll and filter. /Volumes is always watched so the sidebar sees mounts.

import { app, invoke, listen } from "./core.js";
import { visiblePanes } from "./tabs.js";
import { loadPlaces } from "./sidebar.js";

const timers = new Map();
const later = (key, fn, ms = 250) => { clearTimeout(timers.get(key)); timers.set(key, setTimeout(fn, ms)); };

let lastSet = "";
export function syncWatch() {
  if (!invoke || !app.tab) return;
  const dirs = new Set(["/Volumes"]);
  visiblePanes().forEach((p) => { if (p.cwd) dirs.add(p.cwd); if (p.mode === "browse") p.expanded.forEach((d) => dirs.add(d)); });
  const key = [...dirs].sort().join("\n");
  if (key === lastSet) return;
  lastSet = key;
  invoke("watch_dirs", { paths: [...dirs] }).catch(() => { lastSet = ""; });
}

export async function initWatch() {
  if (!listen) return;
  await listen("fs-changed", (ev) => {
    const dir = ev.payload;
    if (dir === "/Volumes") later("volumes", loadPlaces, 600);
    visiblePanes().forEach((p) => { if (p.cwd === dir || p.expanded.has(dir)) later(p, () => p.refresh()); });
  });
}
