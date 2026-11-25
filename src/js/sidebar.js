// Places sidebar (Dolphin's Places panel / Finder's sidebar): your
// Favourites, iCloud Drive and mounted volumes.
// Favourites are one list in your order: it starts with the standard folders
// (Home, Desktop…) plus any old pins, and every item can be dragged up or
// down, moved to the top or removed. Standard folders keep their own icons.
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
import { renderTree, treeClick, treeKey, invalidateTree } from "./foldertree.js";
import { trashPaths } from "./ops.js";
import { servers, isConnected, disconnectServer, forgetServer, openServer, configHosts } from "./remote.js";
import { remoteUrl, connOf, serverLabel, isRemote } from "./loc.js";

let places = null;
// [{ name, path }] in your order. null until first seeded from the standard folders.
let bookmarks = store.get("fathom-favs", null);
const saveFavs = () => store.set("fathom-favs", bookmarks);
/** The icon for a favourite: a standard folder's own, else a folder. */
const favKind = (path) => (places && places.standard.find((p) => p.path === path) || { kind: "folder" }).kind;
let sb;

export async function loadPlaces() {
  try { places = await invoke("places"); } catch { places = null; }
  if (places) app.bin = places.bin;
  // First run of the single list: the standard folders, then the old pins.
  if (!bookmarks) {
    const old = store.get("fathom-places", []);
    const std = places ? places.standard.map((p) => ({ name: p.name, path: p.path })) : [];
    bookmarks = [...std, ...old.filter((b) => !std.some((p) => p.path === b.path))];
    if (places) saveFavs();
  }
  renderSidebar();
}

export function addBookmarks(paths) {
  bookmarks ||= [];
  const have = new Set(bookmarks.map((b) => b.path));
  const std = places ? places.standard : [];
  const add = paths.filter((p) => !have.has(p)).map((p) => ({ name: (std.find((s) => s.path === p) || {}).name || baseName(p), path: p }));
  if (!add.length) { if (app.active) app.active.flash("Already in Favourites"); return; }
  bookmarks = bookmarks.concat(add);
  saveFavs();
  renderSidebar();
  if (app.active) app.active.flash(`Added ${add.length === 1 ? "“" + add[0].name + "”" : add.length + " folders"} to Favourites`);
}
function removeBookmark(path) {
  bookmarks = bookmarks.filter((b) => b.path !== path);
  saveFavs();
  renderSidebar();
}
/** Move a favourite to position `to` (an index in the list as it is now). */
function placeBookmark(path, to) {
  const i = bookmarks.findIndex((b) => b.path === path);
  if (i < 0) return;
  const [b] = bookmarks.splice(i, 1);
  bookmarks.splice(Math.max(0, Math.min(bookmarks.length, to > i ? to - 1 : to)), 0, b);
  saveFavs();
  renderSidebar();
}
/** Put back any standard folders (Home, Desktop…) that were removed, at the end. */
function restoreStandard() {
  const missing = places ? places.standard.filter((p) => !bookmarks.some((b) => b.path === p.path)) : [];
  if (!missing.length) { if (app.active) app.active.flash("The standard folders are all there"); return; }
  bookmarks = bookmarks.concat(missing.map((p) => ({ name: p.name, path: p.path })));
  saveFavs();
  renderSidebar();
}

/** Favourites (Copy to / Move to targets). */
export const placeTargets = () => (bookmarks || []).map((b) => ({ name: b.name, path: b.path }));

/** Places ⇄ Folders (F7). */
export function setSideMode(mode) {
  app.sideMode = mode;
  store.set("fathom-side-mode", mode);
  if (!app.sidebar) { app.sidebar = true; store.set("fathom-sidebar", true); }
  renderSidebar();
}

// Sits above the scrolling list (so it never scrolls away); redrawn in place.
let swHost = null;
function switcher() {
  if (!swHost) { swHost = el("div", "sideswitch"); swHost.setAttribute("role", "tablist"); sb.before(swHost); }
  const w = swHost; w.innerHTML = "";
  [["places", "Places"], ["folders", "Folders"]].forEach(([m, l]) => {
    const b = el("button", "sw" + (app.sideMode === m ? " on" : ""), l); b.type = "button";
    b.setAttribute("role", "tab"); b.setAttribute("aria-selected", app.sideMode === m ? "true" : "false");
    b.title = m === "folders" ? "Folder tree (F7)" : "Places (F7)";
    b.addEventListener("click", () => setSideMode(m));
    w.append(b);
  });
  return w;
}

export function renderSidebar() {
  sb.classList.toggle("hidden", !app.sidebar);
  document.getElementById("sidebarToggle").classList.toggle("on", app.sidebar);
  sb.innerHTML = "";
  switcher().hidden = !app.sidebar;
  if (app.sideMode === "folders") return renderTree(sb);
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
  (bookmarks || []).forEach((b) => item(b.name, b.path, favKind(b.path), { bookmark: true, fav: true }));
  if (!bookmarks || !bookmarks.length) sb.append(el("div", "side-hint", "Drag folders here to add them"));
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
  const svs = servers();
  if (svs.length) {
    sec("Servers");
    svs.forEach(({ conn }) => {
      const n = el("div", "place remoteplace" + (isConnected(conn) ? " live" : ""));
      n.dataset.path = remoteUrl(conn); n.dataset.kind = "server"; n.dataset.conn = conn;
      n.title = `${conn} (SFTP)` + (isConnected(conn) ? " · connected" : "");
      n.append(icon("network"), el("span", "pname", serverLabel(conn)));
      if (isConnected(conn)) { const b = el("button", "eject"); b.type = "button"; b.title = "Disconnect"; b.append(icon("eject")); n.append(b); }
      asButton(n, `Server ${serverLabel(conn)}`);
      sb.append(n);
    });
  }
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
  if (app.sideMode === "folders" && app.sidebar) { if (app.active) invalidateTree(app.active.cwd); renderSidebar(); return; }
  const cwd = app.active && app.active.cwd;
  sb.querySelectorAll(".place").forEach((n) => n.classList.toggle("on", n.dataset.conn ? connOf(cwd || "") === n.dataset.conn : n.dataset.path === cwd));
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

  app.sideMode = store.get("fathom-side-mode", "places");
  const rerender = async (focusPath) => {
    await renderSidebar();
    const m = focusPath && [...sb.querySelectorAll(".tnode")].find((x) => x.dataset.path === focusPath);
    if (m) { sb.querySelectorAll(".tnode").forEach((x) => (x.tabIndex = -1)); m.tabIndex = 0; m.focus(); }
  };
  sb.addEventListener("keydown", (ev) => { if (app.sideMode === "folders") treeKey(ev, rerender); });
  sb.addEventListener("click", (ev) => {
    if (app.sideMode === "folders" && treeClick(ev, rerender)) return;
    const n = placeOf(ev); if (!n) return;
    if (n.dataset.tag) { if (app.active) showTagged(app.active, n.dataset.tag); return; }
    if (n.dataset.search) { if (app.active) runSaved(app.active, saved[+n.dataset.search]); return; }
    if (n.dataset.recent) { ev.stopPropagation(); const r = n.getBoundingClientRect(); recentMenu(r.right - 8, r.top); return; }
    if (n.dataset.server) { connectToServer(); return; }
    if (n.dataset.conn && ev.target.closest(".eject")) { disconnectServer(n.dataset.conn); return; }
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
    if (kind === "server") {
      const conn = n.dataset.conn;
      showMenu([
        { label: "Open", fn: () => openServer(conn, P) },
        { label: "Open in New Tab", fn: () => openTab(path), key: "⌘-click" },
        P && app.tab.view === "twin" && { label: "Open in Other Pane", fn: () => openServer(conn, other(P)) },
        "sep",
        isConnected(conn) && { label: "Disconnect", fn: () => disconnectServer(conn) },
        { label: "Forget Server…", fn: () => forgetServer(conn), danger: true },
      ], ev.clientX, ev.clientY);
      return;
    }
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
      kind === "bookmark" && i > 0 && { label: "Move to Top", fn: () => placeBookmark(path, 0) },
      kind === "bookmark" && i > 0 && { label: "Move Up", fn: () => placeBookmark(path, i - 1) },
      kind === "bookmark" && i < bookmarks.length - 1 && { label: "Move Down", fn: () => placeBookmark(path, i + 2) },
      kind === "bookmark" && { label: "Remove from Favourites", fn: () => removeBookmark(path), danger: true },
      kind === "bookmark" && places && places.standard.some((p) => !bookmarks.some((b) => b.path === p.path)) && { label: "Restore Standard Folders", fn: restoreStandard },
      kind === "volume" && path !== "/" && { label: `Eject “${name}”`, fn: () => eject(path, name) },
      "sep",
      { label: "Reveal in Finder", fn: () => invoke("reveal_in_finder", { path }) },
    ], ev.clientX, ev.clientY);
  });

  // Drag a favourite up or down to reorder (a line shows where it will land).
  let suppressClick = false;
  sb.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0 || app.sideMode === "folders") return;
    const n = ev.target.closest(".place[data-kind='bookmark']"); if (!n || ev.target.closest("button")) return;
    const y0 = ev.clientY, path = n.dataset.path;
    let line = null, to = -1;
    const favEls = () => [...sb.querySelectorAll(".place[data-kind='bookmark']")];
    const move = (e) => {
      if (!line && Math.abs(e.clientY - y0) < 5) return;
      if (!line) { line = el("div", "fav-line"); sb.append(line); n.classList.add("fav-dragging"); document.body.classList.add("fav-reordering"); }
      const els = favEls(); if (!els.length) return;
      // The gap nearest the pointer: before item k (or after the last).
      to = els.length;
      for (let k = 0; k < els.length; k++) { const r = els[k].getBoundingClientRect(); if (e.clientY < r.top + r.height / 2) { to = k; break; } }
      const sr = sb.getBoundingClientRect();
      const ref = to < els.length ? els[to].getBoundingClientRect().top : els[els.length - 1].getBoundingClientRect().bottom;
      line.style.top = ref - sr.top + sb.scrollTop - 1 + "px";
    };
    const up = () => {
      window.removeEventListener("mousemove", move, true); window.removeEventListener("mouseup", up, true);
      if (!line) return;
      line.remove(); n.classList.remove("fav-dragging"); document.body.classList.remove("fav-reordering");
      suppressClick = true; setTimeout(() => (suppressClick = false), 0);
      if (to >= 0) placeBookmark(path, to);
    };
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", up, true);
  });
  sb.addEventListener("click", (ev) => { if (suppressClick) { suppressClick = false; ev.stopImmediatePropagation(); } }, true);

  // Drag & drop: onto a place = move/copy into it; onto blank space = add to Favourites.
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
