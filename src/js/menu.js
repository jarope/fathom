// One popup menu element, reused for right-click menus, breadcrumb
// sub-folder drop-downs, the sidebar and tabs.

import { app, invoke, el, icon, plural } from "./core.js";
import { undoStack, undo, setClip, paste, duplicateSel, transferToOther, pickAndTransfer, openTerminal, compressSel, extractSel, batchRename, isArchive } from "./ops.js";
import { openTab } from "./tabs.js";
import { addBookmarks } from "./sidebar.js";
import { toggleHidden } from "./view.js";

let ctx;

export function initMenu() {
  ctx = document.getElementById("ctx");
  document.addEventListener("click", hideCtx);
  document.addEventListener("scroll", (e) => { if (!ctx.contains(e.target)) hideCtx(); }, true);
  window.addEventListener("blur", hideCtx);
}

export const hideCtx = () => ctx && ctx.classList.remove("show");

/**
 * entries: array of "sep" | { label, fn, key?, icon?, danger?, on?, disabled? }
 * Falsy entries are skipped; doubled / trailing separators collapse.
 */
export function showMenu(entries, x, y) {
  ctx.innerHTML = "";
  for (const it of entries) {
    if (!it) continue;
    if (it === "sep") {
      if (ctx.lastChild && !ctx.lastChild.classList.contains("ctx-sep")) ctx.append(el("div", "ctx-sep"));
      continue;
    }
    const n = el("div", "ctx-item" + (it.danger ? " danger" : "") + (it.on ? " on" : "") + (it.disabled ? " disabled" : ""));
    if (it.icon) n.append(icon(it.icon));
    n.append(el("span", "lbl", it.label));
    if (it.key) n.append(el("span", "k", it.key));
    if (!it.disabled) n.addEventListener("click", (e) => { e.stopPropagation(); hideCtx(); it.fn(); });
    ctx.append(n);
  }
  if (ctx.lastChild && ctx.lastChild.classList.contains("ctx-sep")) ctx.lastChild.remove();
  if (!ctx.childElementCount) return;
  ctx.classList.add("show");
  ctx.scrollTop = 0;
  const w = ctx.offsetWidth || 230, h = ctx.offsetHeight || 240;
  ctx.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + "px";
  ctx.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + "px";
}

/** Right-click menu for pane P. Acts on its current selection; empty selection → folder menu. */
export function openContextMenu(P, x, y) {
  const sel = P.selectedEntries();
  const twin = app.tab.view === "twin";
  const clip = app.clip;

  if (!sel.length) {
    if (!P.cwd) return;
    showMenu([
      { label: "New Folder", fn: () => P.newItem(true), key: "⇧⌘N" },
      { label: "New Text File", fn: () => P.newItem(false), key: "⌥⌘N" },
      "sep",
      { label: clip ? `Paste ${plural(clip.paths.length, "item")}` : "Paste", fn: () => paste(P), key: "⌘V" },
      { label: "Move Here (from clipboard)", fn: () => paste(P, null, { move: true }), key: "⌥⌘V" },
      "sep",
      { label: "Open in New Tab", fn: () => openTab(P.cwd), key: "⌘T" },
      { label: "Open Terminal Here", fn: () => openTerminal(P, P.cwd), key: "⌥⌘T" },
      { label: "Add to Places", fn: () => addBookmarks([P.cwd]) },
      { label: "Copy folder path", fn: () => { navigator.clipboard.writeText(P.cwd); P.flash("Copied path"); } },
      { label: app.showHidden ? "Hide hidden files" : "Show hidden files", fn: toggleHidden, key: "⇧⌘." },
      "sep",
      undoStack.length && { label: `Undo ${undoStack[undoStack.length - 1].label}`, fn: undo, key: "⌘Z" },
    ], x, y);
    return;
  }

  const one = sel.length === 1 ? sel[0] : null;
  const dirs = sel.filter((e) => e.is_dir).map((e) => e.path);
  showMenu([
    one && { label: one.is_dir ? "Open folder" : "Open", fn: () => P.activate(P.entries.indexOf(one)), key: "⏎" },
    one && one.is_dir && { label: "Open in New Tab", fn: () => openTab(one.path), key: "⌘-dbl-click" },
    one && { label: "Rename…", fn: () => P.startRename(one.path), key: "F2" },
    !one && { label: `Rename ${sel.length} items…`, fn: () => batchRename(P), key: "F2" },
    { label: "Duplicate", fn: () => duplicateSel(P), key: "⌘D" },
    "sep",
    P.mode === "browse" && { label: "New Folder", fn: () => P.newItem(true), key: "⇧⌘N" },
    P.mode === "browse" && { label: "New Text File", fn: () => P.newItem(false), key: "⌥⌘N" },
    "sep",
    { label: "Cut", fn: () => setClip(P, true), key: "⌘X" },
    { label: "Copy", fn: () => setClip(P, false), key: "⌘C" },
    one && one.is_dir && { label: "Paste into folder", fn: () => paste(P, one.path) },
    "sep",
    { label: one ? `Compress “${one.name}”` : `Compress ${sel.length} items`, fn: () => compressSel(P) },
    sel.some(isArchive) && { label: sel.filter(isArchive).length > 1 ? "Extract archives here" : "Extract here", fn: () => extractSel(P) },
    "sep",
    { label: "Reveal in Finder", fn: () => invoke("reveal_in_finder", { path: sel[0].path }) },
    one && one.is_dir && { label: "Open Terminal Here", fn: () => openTerminal(P, one.path) },
    dirs.length && { label: "Add to Places", fn: () => addBookmarks(dirs) },
    { label: sel.length > 1 ? "Copy paths" : "Copy path", fn: () => { navigator.clipboard.writeText(sel.map((e) => e.path).join("\n")); P.flash(sel.length > 1 ? "Copied paths" : "Copied path"); } },
    "sep",
    twin && { label: "Copy to other pane", fn: () => transferToOther(P, true), key: "F5" },
    twin && { label: "Move to other pane", fn: () => transferToOther(P, false), key: "F6" },
    { label: "Copy to…", fn: () => pickAndTransfer(P, true) },
    { label: "Move to…", fn: () => pickAndTransfer(P, false) },
    "sep",
    { label: `Move ${sel.length > 1 ? sel.length + " items " : ""}to Bin`, fn: P.trashSelected, danger: true, key: "⌫" },
  ], x, y);
}
