// Header controls and window-wide view settings: theme, hidden files,
// sidebar, layout buttons, and the title-bar drag region.

import { app, store } from "./core.js";
import { showMenu } from "./menu.js";
import { setView } from "./tabs.js";
import { renderSidebar } from "./sidebar.js";

export function toggleHidden() {
  app.showHidden = !app.showHidden;
  store.set("fathom-hidden", app.showHidden ? 1 : 0);
  document.getElementById("hiddenToggle").classList.toggle("on", app.showHidden);
  app.tabs.forEach((t) => t.panes.forEach((p) => p.setHidden(app.showHidden)));
}

export function toggleShelf() {
  app.folderShelf = !app.folderShelf;
  store.set("fathom-shelf", app.folderShelf);
  document.getElementById("shelfToggle").classList.toggle("on", app.folderShelf);
  app.tabs.forEach((t) => t.panes.forEach((p) => { if (p.cwd) { p.renderList(); p.markCut(); } }));
}

export function toggleSidebar() {
  app.sidebar = !app.sidebar;
  store.set("fathom-sidebar", app.sidebar);
  renderSidebar();
}

// ---- Zoom: scales the whole window (text, icons, rows) like ⌘+ in Safari ----
// Remembered between launches, so a laptop and a big monitor can each get a comfy size.
const ZOOMS = [0.75, 0.85, 0.9, 1, 1.1, 1.2, 1.3, 1.45, 1.6];
let zoom = 1;
export const getZoom = () => zoom;
const pct = (z) => Math.round(z * 100) + "%";

function applyZoom(z) {
  zoom = z;
  // The title bar keeps its real height so the traffic lights stay centred in it.
  document.documentElement.style.setProperty("--z", z);
  const wv = window.__TAURI__?.webview?.getCurrentWebview?.();
  if (wv?.setZoom) wv.setZoom(z).catch(() => { document.documentElement.style.zoom = z; });
  else document.documentElement.style.zoom = z; // browser harness
  const b = document.getElementById("zoomBtn");
  if (b) { b.title = `Zoom ${pct(z)} — ⌘+ / ⌘− / ⌘0`; b.classList.toggle("on", z !== 1); }
}

export function setZoom(z, announce = true) {
  z = Math.min(ZOOMS[ZOOMS.length - 1], Math.max(ZOOMS[0], z));
  store.set("fathom-zoom", z);
  applyZoom(z);
  if (announce && app.active) app.active.flash(`Zoom ${pct(z)}`);
}
export const zoomStep = (dir) => {
  const i = ZOOMS.findIndex((x) => x >= zoom - 0.001);
  setZoom(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? 3 : i) + dir))]);
};

function zoomMenu(btn) {
  const r = btn.getBoundingClientRect();
  showMenu([
    { label: "Larger", fn: () => zoomStep(1), key: "⌘+" },
    { label: "Smaller", fn: () => zoomStep(-1), key: "⌘−" },
    { label: "Actual Size", fn: () => setZoom(1), key: "⌘0" },
    "sep",
    ...ZOOMS.map((z) => ({ label: pct(z), fn: () => setZoom(z), on: Math.abs(z - zoom) < 0.001 })),
  ], r.left, r.bottom + 6);
}

export function initHeader() {
  const $ = (id) => document.getElementById(id);

  applyZoom(store.get("fathom-zoom", 1));
  $("zoomBtn").addEventListener("click", (e) => { e.stopPropagation(); zoomMenu($("zoomBtn")); });

  // Theme (stored as a raw string — predates the JSON store).
  let saved = null;
  try { saved = localStorage.getItem("fathom-theme"); } catch {}
  if (saved === "light" || saved === "dark") document.documentElement.setAttribute("data-theme", saved);
  $("theme").addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("fathom-theme", next); } catch {}
  });

  $("hiddenToggle").classList.toggle("on", app.showHidden);
  $("hiddenToggle").addEventListener("click", toggleHidden);
  $("sidebarToggle").addEventListener("click", toggleSidebar);
  $("shelfToggle").classList.toggle("on", app.folderShelf);
  $("shelfToggle").addEventListener("click", toggleShelf);
  $("viewSingle").addEventListener("click", () => setView("single"));
  $("viewTwin").addEventListener("click", () => setView("twin"));

  // Header = title bar: its non-button parts drag the window (double-click zooms).
  document.querySelectorAll(".header, .brand, .brand *, .header-right").forEach((n) => n.setAttribute("data-tauri-drag-region", ""));
}
