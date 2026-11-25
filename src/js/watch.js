// Auto-refresh: the backend watches the folders on screen (FSEvents) and
// emits `fs-changed`; matching panes refresh (debounced), keeping selection,
// scroll and filter. /Volumes is always watched so the sidebar sees mounts.

import { app, invoke, listen } from "./core.js";
import { visiblePanes } from "./tabs.js";
import { loadPlaces } from "./sidebar.js";
import { isRemote } from "./loc.js";

const timers = new Map();
const later = (key, fn, ms = 250) => { clearTimeout(timers.get(key)); timers.set(key, setTimeout(fn, ms)); };

let lastSet = "";
export function syncWatch() {
  if (!invoke || !app.tab) return;
  const dirs = new Set(["/Volumes"]);
  visiblePanes().forEach((p) => { if (p.cwd) dirs.add(p.cwd); if (p.mode === "browse") p.expanded.forEach((d) => dirs.add(d)); });
  [...dirs].forEach((d) => isRemote(d) && dirs.delete(d)); // servers are polled (below)
  const key = [...dirs].sort().join("\n");
  if (key === lastSet) return;
  lastSet = key;
  invoke("watch_dirs", { paths: [...dirs] }).catch(() => { lastSet = ""; });
}

// Server folders can't be watched: every 3 s (window focused) check their
// modified time — it changes when something is added, removed or renamed —
// and reload every 30 s anyway (edits inside files don't touch it).
const mtimes = new Map();
let lastFull = 0, polling = false;
async function pollServers() {
  if (polling || !document.hasFocus()) return;
  const panes = visiblePanes().filter((p) => isRemote(p.cwd) && p.mode === "browse" && !p.isOffline);
  if (!panes.length) return;
  polling = true;
  try {
    const dirs = [...new Set(panes.flatMap((p) => [p.cwd, ...p.expanded]))];
    const got = await invoke("sftp_mtimes", { dirs });
    const full = Date.now() - lastFull > 30000;
    if (full) lastFull = Date.now();
    const changed = new Set();
    dirs.forEach((d, i) => { const m = got[i]; if (m != null && mtimes.has(d) && mtimes.get(d) !== m) changed.add(d); if (m != null) mtimes.set(d, m); });
    panes.forEach((p) => { if (full || changed.has(p.cwd) || [...p.expanded].some((d) => changed.has(d))) p.refresh(); });
  } catch {} finally { polling = false; }
}

export async function initWatch() {
  if (!listen) return;
  setInterval(pollServers, 3000);
  window.addEventListener("focus", () => { lastFull = 0; pollServers(); });
  await listen("fs-changed", (ev) => {
    const dir = ev.payload;
    if (dir === "/Volumes") later("volumes", loadPlaces, 600);
    visiblePanes().forEach((p) => { if (p.cwd === dir || p.expanded.has(dir)) later(p, () => p.refresh()); });
  });
}
