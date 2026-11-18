// Header controls and window-wide view settings: theme, hidden files,
// sidebar, layout buttons, and the title-bar drag region.

import { app, store } from "./core.js";
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

export function initHeader() {
  const $ = (id) => document.getElementById(id);

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
