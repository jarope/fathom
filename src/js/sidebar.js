// Places sidebar (Dolphin's Places panel / Finder's sidebar): standard
// folders, your pinned folders, iCloud Drive and mounted volumes.
//   click → go there (active pane) · ⌘-click / middle-click → new tab
//   drop files on a place → move (⌥ copy) · drop folders on blank space → pin

import { app, invoke, el, icon, store, baseName } from "./core.js";
import { showMenu } from "./menu.js";
import { openTab, other } from "./tabs.js";
import { openTerminal } from "./ops.js";
import { registerDropZone } from "./dnd.js";
import { favourites, showTagged, tagPaths } from "./tags.js";
import { saved, runSaved, removeSaved } from "./search.js";
import { asButton } from "./a11y.js";
import { emptyBin } from "./bin.js";
import { recentMenu, connectToServer } from "./network.js";
import { trashPaths } from "./ops.js";

let places = null;
let bookmarks = store.get("fathom-places", []); // [{ name, path }]
let sb;

export async function loadPlaces() {
  try { places = await invoke("places"); } catch { places = null; }
  if (places) app.bin = places.bin;
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

/** Standard places + pinned folders (Copy to / Move to targets). */
export const placeTargets = () => [
  ...(places ? places.standard.map((p) => ({ name: p.name, path: p.path })) : []),
  ...bookmarks.map((b) => ({ name: b.name, path: b.path })),
];

export function renderSidebar() {
  sb.classList.toggle("hidden", !app.sidebar);
  document.getElementById("sidebarToggle").classList.toggle("on", app.sidebar);
  sb.innerHTML = "";
  if (!places) return;
  const sec = (t) => sb.append(el("div", "side-sec", t));
  const item = (name, path, kind, extra = {}) => {
    const n = el("div", "place" + (extra.fav ? " fav" : ""));
    n.dataset.path = path; n.dataset.kind = extra.bookmark ? "bookmark" : extra.volume ? "volume" : extra.bin ? "bin" : "std";
    n.title = path;
    n.append(icon(kind), el("span", "pname", name));
    asButton(n, name);
    if (extra.volume && !extra.volume.is_root) {
      const b = el("button", "eject"); b.type = "button"; b.title = "Eject"; b.append(icon("eject"));
      n.append(b);
    }
    sb.append(n);
  };

  sec("Favourites");
  places.standard.forEach((p) => item(p.name, p.path, p.kind, { fav: true }));
  bookmarks.forEach((b) => item(b.name, b.path, "folder", { bookmark: true, fav: true }));
  if (!bookmarks.length) sb.append(el("div", "side-hint", "Drag folders here to pin them"));
  const rec = el("div", "place recentplace"); rec.dataset.recent = "1"; rec.title = "Folders you were in lately";
  rec.append(icon("recent"), el("span", "pname", "Recent"), el("span", "pchev", "›"));
  asButton(rec, "Recent folders"); sb.append(rec);
  if (places.icloud) { sec("iCloud"); item("iCloud Drive", places.icloud, "cloud"); }
  sec("Locations");
  places.volumes.forEach((v) => item(v.name, v.path, v.network ? "network" : "drive", { volume: v }));
  if (places.bin) item("Bin", places.bin, "bin", { bin: true });
  const srv = el("div", "place serverplace"); srv.dataset.server = "1"; srv.title = "Connect to Server (⌘K)";
  srv.append(icon("network"), el("span", "pname", "Connect to Server…"));
  asButton(srv, "Connect to Server"); sb.append(srv);
  if (saved.length) {
    sec("Searches");
    saved.forEach((s, i) => {
      const n = el("div", "place searchplace");
      n.dataset.search = i;
      n.title = `${s.query}${s.contents ? " · contents" : ""}${s.mac ? " · this Mac" : s.root ? " · in " + s.root : ""}`;
      n.append(icon("search"), el("span", "pname", s.name));
      asButton(n, `Saved search: ${s.name}`);
      sb.append(n);
    });
  }
  if (favourites.length) {
    sec("Tags");
    favourites.forEach((t) => {
      const n = el("div", "place tagplace");
      n.dataset.tag = t.name; n.title = `Everything tagged “${t.name}” · drop files here to tag them`;
      n.append(el("i", `tg tc${t.color || 0}`), el("span", "pname", t.name));
      asButton(n, `Tag: ${t.name}`);
      sb.append(n);
    });
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
    if (n.dataset.tag) { if (app.active) showTagged(app.active, n.dataset.tag); return; }
    if (n.dataset.search) { if (app.active) runSaved(app.active, saved[+n.dataset.search]); return; }
    if (n.dataset.recent) { ev.stopPropagation(); const r = n.getBoundingClientRect(); recentMenu(r.right - 8, r.top); return; }
    if (n.dataset.server) { connectToServer(); return; }
    if (ev.target.closest(".eject")) { eject(n.dataset.path, n.querySelector(".pname").textContent); return; }
    if (ev.metaKey) openTab(n.dataset.path);
    else if (app.active) app.active.navigate(n.dataset.path);
  });
  sb.addEventListener("auxclick", (ev) => { const n = placeOf(ev); if (n && n.dataset.path && ev.button === 1) openTab(n.dataset.path); });
  sb.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    const n = placeOf(ev); if (!n || n.dataset.tag || n.dataset.recent || n.dataset.server) return;
    if (n.dataset.search) {
      const i = +n.dataset.search;
      showMenu([
        { label: "Run", fn: () => app.active && runSaved(app.active, saved[i]) },
        { label: "Run in New Tab", fn: async () => { await openTab(saved[i].root || app.active.cwd); runSaved(app.active, saved[i]); } },
        "sep",
        { label: "Remove from sidebar", fn: () => removeSaved(i), danger: true },
      ], ev.clientX, ev.clientY);
      return;
    }
    const path = n.dataset.path, kind = n.dataset.kind, name = n.querySelector(".pname").textContent;
    const P = app.active;
    if (kind === "bin") {
      showMenu([
        { label: "Open", fn: () => P && P.navigate(path) },
        { label: "Open in New Tab", fn: () => openTab(path), key: "⌘-click" },
        "sep",
        { label: "Empty Bin…", fn: () => emptyBin(P), danger: true },
      ], ev.clientX, ev.clientY);
      return;
    }
    const i = bookmarks.findIndex((b) => b.path === path);
    showMenu([
      { label: "Open", fn: () => P && P.navigate(path) },
      { label: "Open in New Tab", fn: () => openTab(path), key: "⌘-click" },
      P && app.tab.view === "twin" && { label: "Open in Other Pane", fn: () => other(P).navigate(path) },
      "sep",
      { label: "Open Terminal Here", fn: () => openTerminal(P, path) },
      "sep",
      kind === "bookmark" && i > 0 && { label: "Move Up", fn: () => moveBookmark(path, -1) },
      kind === "bookmark" && i < bookmarks.length - 1 && { label: "Move Down", fn: () => moveBookmark(path, 1) },
      kind === "bookmark" && { label: "Remove from Places", fn: () => removeBookmark(path), danger: true },
      kind === "volume" && path !== "/" && { label: `Eject “${name}”`, fn: () => eject(path, name) },
      "sep",
      { label: "Reveal in Finder", fn: () => invoke("reveal_in_finder", { path }) },
    ], ev.clientX, ev.clientY);
  });

  // Drag & drop: onto a place = move/copy into it; onto blank space = pin folders.
  registerDropZone({
    root: sb,
    over: (n, data) => {
      const pl = n.closest(".place");
      if (pl && (pl.dataset.search || pl.dataset.recent || pl.dataset.server)) return null;
      if (pl && pl.dataset.tag) return { el: pl, act: (d) => app.active && tagPaths(app.active, d.paths, pl.dataset.tag) };
      if (pl && pl.dataset.kind === "bin") return { el: pl, act: (d) => app.active && trashPaths(app.active, d.paths.filter((p) => !p.startsWith(app.bin + "/"))) };
      if (pl) return { el: pl, dest: pl.dataset.path };
      if (data.dirs === null || data.dirs.length) return { el: sb, cls: "drop-target", act: (d) => d.dirs && d.dirs.length && addBookmarks(d.dirs) };
      return null;
    },
  });
}
