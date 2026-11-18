// Places sidebar (Dolphin's Places panel / Finder's sidebar): standard
// folders, your pinned folders, iCloud Drive and mounted volumes.
//   click → go there (active pane) · ⌘-click / middle-click → new tab
//   drop files on a place → move (⌥ copy) · drop folders on blank space → pin

import { app, invoke, el, icon, store, baseName } from "./core.js";
import { showMenu } from "./menu.js";
import { openTab, other } from "./tabs.js";
import { performTransfer, openTerminal } from "./ops.js";

let places = null;
let bookmarks = store.get("fathom-places", []); // [{ name, path }]
let sb;

export async function loadPlaces() {
  try { places = await invoke("places"); } catch { places = null; }
  renderSidebar();
}

export function addBookmarks(paths) {
  const have = new Set([...bookmarks.map((b) => b.path), ...(places ? places.standard.map((p) => p.path) : [])]);
  const add = paths.filter((p) => !have.has(p)).map((p) => ({ name: baseName(p), path: p }));
  if (!add.length) { if (app.active) app.active.flash("Already in Places"); return; }
  bookmarks = bookmarks.concat(add);
  store.set("fathom-places", bookmarks);
  renderSidebar();
  if (app.active) app.active.flash(`Added ${add.length === 1 ? "“" + add[0].name + "”" : add.length + " folders"} to Places`);
}
function removeBookmark(path) {
  bookmarks = bookmarks.filter((b) => b.path !== path);
  store.set("fathom-places", bookmarks);
  renderSidebar();
}
function moveBookmark(path, dir) {
  const i = bookmarks.findIndex((b) => b.path === path), j = i + dir;
  if (i < 0 || j < 0 || j >= bookmarks.length) return;
  [bookmarks[i], bookmarks[j]] = [bookmarks[j], bookmarks[i]];
  store.set("fathom-places", bookmarks);
  renderSidebar();
}

export function renderSidebar() {
  sb.classList.toggle("hidden", !app.sidebar);
  document.getElementById("sidebarToggle").classList.toggle("on", app.sidebar);
  sb.innerHTML = "";
  if (!places) return;
  const sec = (t) => sb.append(el("div", "side-sec", t));
  const item = (name, path, kind, extra = {}) => {
    const n = el("div", "place");
    n.dataset.path = path; n.dataset.kind = extra.bookmark ? "bookmark" : extra.volume ? "volume" : "std";
    n.title = path;
    n.append(icon(kind), el("span", "pname", name));
    if (extra.volume && !extra.volume.is_root) {
      const b = el("button", "eject"); b.type = "button"; b.title = "Eject"; b.append(icon("eject"));
      n.append(b);
    }
    sb.append(n);
  };

  sec("Favourites");
  places.standard.forEach((p) => item(p.name, p.path, p.kind));
  bookmarks.forEach((b) => item(b.name, b.path, "folder", { bookmark: true }));
  if (!bookmarks.length) sb.append(el("div", "side-hint", "Drag folders here to pin them"));
  if (places.icloud) { sec("iCloud"); item("iCloud Drive", places.icloud, "cloud"); }
  if (places.volumes.length) {
    sec("Locations");
    places.volumes.forEach((v) => item(v.name, v.path, "drive", { volume: v }));
  }
  markActive();
}

/** Highlight the place matching the active pane's folder. */
export function markActive() {
  if (!sb) return;
  const cwd = app.active && app.active.cwd;
  sb.querySelectorAll(".place").forEach((n) => n.classList.toggle("on", n.dataset.path === cwd));
}

async function eject(path, name) {
  const P = app.active;
  if (P) P.flash(`Ejecting ${name}…`);
  // Step any pane off the volume first, or it keeps the disk busy.
  const moves = [];
  app.tabs.forEach((t) => t.panes.forEach((p) => { if (p.cwd && (p.cwd === path || p.cwd.startsWith(path + "/"))) moves.push(p.navigate(app.home)); }));
  await Promise.all(moves);
  try { await invoke("eject_volume", { path }); if (P) P.flash(`Ejected ${name}`); }
  catch (e) { if (P) P.flash("⚠ " + e, "warn"); }
  loadPlaces();
}

export function initSidebar() {
  sb = document.getElementById("sidebar");
  const placeOf = (ev) => ev.target.closest(".place");

  sb.addEventListener("click", (ev) => {
    const n = placeOf(ev); if (!n) return;
    if (ev.target.closest(".eject")) { eject(n.dataset.path, n.querySelector(".pname").textContent); return; }
    if (ev.metaKey) openTab(n.dataset.path);
    else if (app.active) app.active.navigate(n.dataset.path);
  });
  sb.addEventListener("auxclick", (ev) => { const n = placeOf(ev); if (n && ev.button === 1) openTab(n.dataset.path); });
  sb.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    const n = placeOf(ev); if (!n) return;
    const path = n.dataset.path, kind = n.dataset.kind, name = n.querySelector(".pname").textContent;
    const P = app.active;
    const i = bookmarks.findIndex((b) => b.path === path);
    showMenu([
      { label: "Open", fn: () => P && P.navigate(path) },
      { label: "Open in New Tab", fn: () => openTab(path), key: "⌘-click" },
      P && app.tab.view === "twin" && { label: "Open in Other Pane", fn: () => other(P).navigate(path) },
      "sep",
      { label: "Open Terminal Here", fn: () => openTerminal(P, path) },
      { label: "Reveal in Finder", fn: () => invoke("reveal_in_finder", { path }) },
      "sep",
      kind === "bookmark" && i > 0 && { label: "Move Up", fn: () => moveBookmark(path, -1) },
      kind === "bookmark" && i < bookmarks.length - 1 && { label: "Move Down", fn: () => moveBookmark(path, 1) },
      kind === "bookmark" && { label: "Remove from Places", fn: () => removeBookmark(path), danger: true },
      kind === "volume" && path !== "/" && { label: `Eject “${name}”`, fn: () => eject(path, name) },
    ], ev.clientX, ev.clientY);
  });

  // Drag & drop: onto a place = move/copy into it; onto blank space = pin folders.
  const clearCue = () => { sb.classList.remove("drop-target"); sb.querySelectorAll(".drop-into").forEach((n) => n.classList.remove("drop-into")); };
  sb.addEventListener("dragover", (ev) => {
    if (!app.dragData) return;
    const n = placeOf(ev);
    clearCue();
    if (n) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = ev.altKey || ev.ctrlKey ? "copy" : "move";
      n.classList.add("drop-into");
    } else if (app.dragData.dirs.length) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "link";
      sb.classList.add("drop-target");
    }
  });
  sb.addEventListener("dragleave", (ev) => { if (!sb.contains(ev.relatedTarget)) clearCue(); });
  sb.addEventListener("drop", (ev) => {
    const n = placeOf(ev); clearCue();
    const d = app.dragData; if (!d) return;
    ev.preventDefault(); app.dragData = null;
    if (n) performTransfer(d.paths, n.dataset.path, ev.altKey || ev.ctrlKey);
    else if (d.dirs.length) addBookmarks(d.dirs);
  });
}
