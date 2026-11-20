// One popup menu element, reused for right-click menus, breadcrumb
// sub-folder drop-downs, the sidebar and tabs.

import { isFolder } from "./core.js";
import { app, invoke, el, icon, plural } from "./core.js";
import { undoStack, redoStack, undo, redo, setClip, paste, duplicateSel, transferToOther, pickAndTransfer, recentDests, openTerminal, compressSel, extractSel, batchRename, isArchive } from "./ops.js";
import { openTab } from "./tabs.js";
import { addBookmarks, placeTargets } from "./sidebar.js";
import { other, openLocation, elsewhere } from "./tabs.js";
import { toggleHidden } from "./view.js";
import { menuTagRow, editTagsDialog, clearTags } from "./tags.js";
import { openWithEntries, share, quickLook } from "./system.js";
import { gitMenu } from "./git.js";
import { keyHint } from "./keys.js";
import { actionEntries } from "./actions.js";
import { openPrefs } from "./prefs.js";
import { getInfo } from "./info.js";

let ctx, sub, subTimer = null;

// Holding ⌥ swaps items that have an alternate (macOS menus do the same).
let altDown = false;
const syncAlt = () => { ctx && ctx.classList.toggle("alt", altDown); sub && sub.classList.toggle("alt", altDown); };

export function initMenu() {
  ctx = document.getElementById("ctx");
  sub = el("div", "ctx ctx-sub"); document.body.append(sub);
  const track = (e) => { if (e.altKey !== altDown) { altDown = e.altKey; syncAlt(); } };
  ["keydown", "keyup", "mousemove", "mousedown", "contextmenu"].forEach((t) => window.addEventListener(t, track, true));
  document.addEventListener("click", hideCtx);
  document.addEventListener("scroll", (e) => { if (!ctx.contains(e.target) && !sub.contains(e.target)) hideCtx(); }, true);
  window.addEventListener("blur", hideCtx);
}

export const hideCtx = () => { if (ctx) ctx.classList.remove("show"); if (sub) sub.classList.remove("show"); clearTimeout(subTimer); };
const hideSub = () => { clearTimeout(subTimer); if (sub) sub.classList.remove("show"); ctx && ctx.querySelectorAll(".ctx-item.open").forEach((n) => n.classList.remove("open")); };

/** Fill a menu element. entries: see showMenu. Returns false if nothing to show. */
function fill(box, entries, nested) {
  box.innerHTML = "";
  for (const it of entries) {
    if (!it) continue;
    if (it === "sep") {
      if (box.lastChild && !box.lastChild.classList.contains("ctx-sep")) box.append(el("div", "ctx-sep"));
      continue;
    }
    if (it.custom) { const c = it.custom(); if (c) box.append(c); continue; }
    if (it.heading) { box.append(el("div", "ctx-head", it.heading)); continue; }
    const n = el("div", "ctx-item" + (it.danger ? " danger" : "") + (it.on ? " on" : "") + (it.disabled ? " disabled" : "") + (it.sub ? " has-sub" : ""));
    if (it.img !== undefined) { const im = el("img", "ctx-img"); if (it.img) im.src = it.img; n.append(im); }
    else if (it.icon) n.append(icon(it.icon));
    const alt = it.alt;
    n.append(el("span", "lbl" + (alt ? " noalt" : ""), it.label));
    if (alt) n.append(el("span", "lbl ifalt", alt.label));
    if (it.key) n.append(el("span", "k" + (alt ? " noalt" : ""), it.key));
    if (alt && alt.key) n.append(el("span", "k ifalt", alt.key));
    if (it.sub) n.append(el("span", "k chev", "›"));
    if (!nested) n.addEventListener("mouseenter", () => {
      if (n.classList.contains("open")) return;
      hideSub();
      if (it.sub && !it.disabled) subTimer = setTimeout(() => openSub(n, it.sub), 120);
    });
    if (it.disabled) { /* inert */ }
    else if (it.sub) n.addEventListener("click", (e) => { e.stopPropagation(); clearTimeout(subTimer); openSub(n, it.sub); });
    else n.addEventListener("click", (e) => { e.stopPropagation(); hideCtx(); (alt && e.altKey ? alt.fn : it.fn)(); });
    box.append(n);
  }
  if (box.lastChild && box.lastChild.classList.contains("ctx-sep")) box.lastChild.remove();
  return box.childElementCount > 0;
}

function place(box, x, y, flipX) {
  const w = box.offsetWidth || 230, h = box.offsetHeight || 240;
  if (flipX != null && x + w > window.innerWidth - 8) x = flipX - w;
  box.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + "px";
  box.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + "px";
}

async function openSub(item, build) {
  item.classList.add("open");
  const entries = typeof build === "function" ? await build() : build;
  if (!item.classList.contains("open") || !ctx.classList.contains("show")) return;
  if (!fill(sub, entries, true)) { sub.classList.remove("show"); return; }
  sub.classList.add("show"); sub.scrollTop = 0;
  const r = item.getBoundingClientRect();
  place(sub, r.right + 2, r.top - 5, r.left - 2);
}

/**
 * entries: array of "sep" | { heading } | { custom: () => Node } |
 *   { label, fn, key?, icon?, img?, danger?, on?, disabled?, sub?: entries | () => Promise<entries> }
 * Falsy entries are skipped; doubled / trailing separators collapse.
 */
export function showMenu(entries, x, y) {
  hideSub();
  if (!fill(ctx, entries, false)) return;
  syncAlt();
  ctx.classList.add("show");
  ctx.scrollTop = 0;
  place(ctx, x, y);
}

/** Copy to ▸ / Move to ▸: the other pane, recent places you sent things, Places, or browse. */
function destEntries(P, copy) {
  const here = P.cwd, sel = new Set(P.selectedPaths());
  const ok = (d) => d && d !== here && ![...sel].some((s) => d === s || d.startsWith(s + "/"));
  const item = (name, path, ic) => ({ label: name, icon: ic, fn: () => pickAndTransfer(P, copy, path) });
  const nameOf = (p) => (p === "/" ? "Macintosh HD" : p.split("/").pop());
  const o = app.tab.view === "twin" ? other(P) : null;
  const seen = new Set();
  const uniq = (list) => list.filter((x) => ok(x.path) && !seen.has(x.path) && seen.add(x.path));
  const pane = o && uniq([{ path: o.cwd }]).map((x) => item(`${nameOf(x.path)} (other pane)`, x.path, "folder"));
  const recent = uniq(recentDests().map((p) => ({ path: p }))).map((x) => item(nameOf(x.path), x.path, "folder"));
  const placesL = uniq(placeTargets()).map((x) => item(x.name, x.path, "folder"));
  return [
    ...(pane || []),
    ...(recent.length ? [pane && pane.length ? "sep" : null, { heading: "Recent" }, ...recent] : []),
    ...(placesL.length ? ["sep", { heading: "Places" }, ...placesL] : []),
    "sep",
    { label: "Other Folder…", fn: () => pickAndTransfer(P, copy) },
  ];
}

/** View ▸ — the pane's view mode. */
export const viewEntries = (P) => [
  { label: "Grid", on: P.viewMode === "grid", fn: () => P.setViewMode("grid"), key: keyHint("viewGrid") },
  { label: "Details", on: P.viewMode === "details", fn: () => P.setViewMode("details"), key: keyHint("viewDetails") },
  { label: "Columns", on: P.viewMode === "columns", fn: () => P.setViewMode("columns"), key: keyHint("viewColumns") },
];
/** Sort By ▸ — the grid has no column header, so sorting lives here too. */
export function sortEntries(P) {
  const keys = [["name", "Name"], ["kind", "Kind"], ["size", "Size"], ["modified", "Modified"], ["created", "Created"], ["added", "Date Added"], ["ext", "Extension"]];
  if (P.mode === "search") keys.splice(1, 0, ["folder", "Folder"]);
  return [
    ...keys.map(([k, label]) => ({ label, on: P.sortKey === k, fn: () => P.sortBy(k) })),
    "sep",
    { label: "Ascending", on: P.sortDir === 1, fn: () => P.sortDir !== 1 && P.sortBy(P.sortKey) },
    { label: "Descending", on: P.sortDir === -1, fn: () => P.sortDir !== -1 && P.sortBy(P.sortKey) },
  ];
}

/** Right-click menu for pane P. Acts on its current selection; empty selection → folder menu. */
export function openContextMenu(P, x, y) {
  const sel = P.selectedEntries();
  const twin = app.tab.view === "twin";
  const clip = app.clip;

  if (!sel.length) {
    if (!P.cwd) return;
    showMenu([
      { label: "New Folder", fn: () => P.newItem(true), key: keyHint("newFolder") },
      { label: "New Text File", fn: () => P.newItem(false), key: keyHint("newFile") },
      "sep",
      { label: clip ? `Paste ${plural(clip.paths.length, "item")}` : "Paste", fn: () => paste(P), key: keyHint("paste") },
      { label: "Move Here (from clipboard)", fn: () => paste(P, null, { move: true }), key: keyHint("moveHere") },
      "sep",
      { label: "Open in New Tab", fn: () => openTab(P.cwd), key: keyHint("newTab") },
      { label: "Open Terminal Here", fn: () => openTerminal(P, P.cwd), key: keyHint("terminal") },
      { label: "Add to Places", fn: () => addBookmarks([P.cwd]) },
      { label: "Copy folder path", fn: () => { navigator.clipboard.writeText(P.cwd); P.flash("Copied path"); } },
      { label: "Get Info", fn: () => getInfo(P), key: keyHint("getInfo") },
      "sep",
      { label: "View", sub: () => viewEntries(P) },
      { label: "Sort By", sub: () => sortEntries(P) },
      { label: app.showHidden ? "Hide hidden files" : "Show hidden files", fn: toggleHidden, key: keyHint("hidden") },
      "sep",
      P.git && { label: "Git", sub: () => gitMenu(P) },
      { label: "Actions", sub: () => actionEntries(P, [], () => openPrefs("actions")) },
      "sep",
      undoStack.length && { label: `Undo ${undoStack[undoStack.length - 1].label}`, fn: undo, key: keyHint("undo") },
      redoStack.length && { label: `Redo ${redoStack[redoStack.length - 1].label}`, fn: redo, key: keyHint("redo") },
    ], x, y);
    return;
  }

  const one = sel.length === 1 ? sel[0] : null;
  const dirs = sel.filter((e) => e.is_dir).map((e) => e.path);
  showMenu([
    one && { label: isFolder(one) ? "Open folder" : "Open", fn: () => P.activate(P.entries.indexOf(one)), key: "⏎" },
    one && isFolder(one) && { label: "Open in New Tab", fn: () => openTab(one.path), key: "⌘-dbl-click" },
    { label: "Open With", sub: () => openWithEntries(P, sel.map((e) => e.path)) },
    one && elsewhere(P, one) && { label: "Open Location", fn: () => openLocation(P), key: keyHint("openLocation"),
      alt: { label: "Open Location in Other Pane", fn: () => openLocation(P, true), key: keyHint("openLocationOther") } },
    { label: "Quick Look", fn: () => quickLook(P), key: keyHint("quickLook") },
    { label: "Get Info", fn: () => getInfo(P), key: keyHint("getInfo") },
    one && { label: "Rename…", fn: () => P.startRename(one.path), key: keyHint("rename") },
    !one && { label: `Rename ${sel.length} items…`, fn: () => batchRename(P), key: keyHint("rename") },
    { label: "Duplicate", fn: () => duplicateSel(P), key: keyHint("duplicate") },
    "sep",
    P.mode === "browse" && { label: "New Folder", fn: () => P.newItem(true), key: keyHint("newFolder") },
    P.mode === "browse" && { label: "New Text File", fn: () => P.newItem(false), key: keyHint("newFile") },
    "sep",
    { label: "Cut", fn: () => setClip(P, true), key: keyHint("cut") },
    { label: "Copy", fn: () => setClip(P, false), key: keyHint("copy") },
    one && isFolder(one) && { label: "Paste into folder", fn: () => paste(P, one.path) },
    "sep",
    { label: one ? `Compress “${one.name}”` : `Compress ${sel.length} items`, fn: () => compressSel(P) },
    sel.some(isArchive) && { label: sel.filter(isArchive).length > 1 ? "Extract archives here" : "Extract here", fn: () => extractSel(P) },
    "sep",
    { custom: () => menuTagRow(P, hideCtx) },
    { label: "Tags…", fn: () => editTagsDialog(P) },
    sel.some((e) => e.tags && e.tags.length) && { label: "Remove all tags", fn: () => clearTags(P), key: "⌃⌘0" },
    "sep",
    { label: "Actions", sub: () => actionEntries(P, sel, () => openPrefs("actions")) },
    P.git && P.mode === "browse" && { label: "Git", sub: () => gitMenu(P) },
    { label: "Share…", fn: () => share(P, sel.map((e) => e.path), x, y) },
    one && one.is_dir && { label: "Open Terminal Here", fn: () => openTerminal(P, one.path) },
    dirs.length && { label: "Add to Places", fn: () => addBookmarks(dirs) },
    { label: sel.length > 1 ? "Copy paths" : "Copy path", fn: () => { navigator.clipboard.writeText(sel.map((e) => e.path).join("\n")); P.flash(sel.length > 1 ? "Copied paths" : "Copied path"); } },
    "sep",
    twin && { label: "Copy to other pane", fn: () => transferToOther(P, true), key: keyHint("copyOther") },
    twin && { label: "Move to other pane", fn: () => transferToOther(P, false), key: keyHint("moveOther") },
    { label: "Copy to", sub: () => destEntries(P, true) },
    { label: "Move to", sub: () => destEntries(P, false) },
    "sep",
    { label: "Reveal in Finder", fn: () => invoke("reveal_in_finder", { path: sel[0].path }) },
    "sep",
    { label: `Move ${sel.length > 1 ? sel.length + " items " : ""}to Bin`, fn: P.trashSelected, danger: true, key: keyHint("trash") },
  ], x, y);
}
