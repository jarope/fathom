// One popup menu element, reused for right-click menus, breadcrumb
// sub-folder drop-downs, the sidebar and tabs.

import { app, invoke, el, icon, plural } from "./core.js";
import { undoStack, redoStack, undo, redo, setClip, paste, duplicateSel, transferToOther, pickAndTransfer, openTerminal, compressSel, extractSel, batchRename, isArchive } from "./ops.js";
import { openTab } from "./tabs.js";
import { addBookmarks } from "./sidebar.js";
import { toggleHidden } from "./view.js";
import { menuTagRow, editTagsDialog, clearTags } from "./tags.js";
import { openWithEntries, share, quickLook } from "./system.js";
import { gitMenu } from "./git.js";

let ctx, sub, subTimer = null;

export function initMenu() {
  ctx = document.getElementById("ctx");
  sub = el("div", "ctx ctx-sub"); document.body.append(sub);
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
    n.append(el("span", "lbl", it.label));
    if (it.key) n.append(el("span", "k", it.key));
    if (it.sub) n.append(el("span", "k chev", "›"));
    if (!nested) n.addEventListener("mouseenter", () => {
      if (n.classList.contains("open")) return;
      hideSub();
      if (it.sub && !it.disabled) subTimer = setTimeout(() => openSub(n, it.sub), 120);
    });
    if (it.disabled) { /* inert */ }
    else if (it.sub) n.addEventListener("click", (e) => { e.stopPropagation(); clearTimeout(subTimer); openSub(n, it.sub); });
    else n.addEventListener("click", (e) => { e.stopPropagation(); hideCtx(); it.fn(); });
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
  ctx.classList.add("show");
  ctx.scrollTop = 0;
  place(ctx, x, y);
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
      P.git && { label: "Git", sub: () => gitMenu(P) },
      "sep",
      undoStack.length && { label: `Undo ${undoStack[undoStack.length - 1].label}`, fn: undo, key: "⌘Z" },
      redoStack.length && { label: `Redo ${redoStack[redoStack.length - 1].label}`, fn: redo, key: "⇧⌘Z" },
    ], x, y);
    return;
  }

  const one = sel.length === 1 ? sel[0] : null;
  const dirs = sel.filter((e) => e.is_dir).map((e) => e.path);
  showMenu([
    one && { label: one.is_dir ? "Open folder" : "Open", fn: () => P.activate(P.entries.indexOf(one)), key: "⏎" },
    one && one.is_dir && { label: "Open in New Tab", fn: () => openTab(one.path), key: "⌘-dbl-click" },
    { label: "Open With", sub: () => openWithEntries(P, sel.map((e) => e.path)) },
    { label: "Quick Look", fn: () => quickLook(P), key: "Space" },
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
    { custom: () => menuTagRow(P, hideCtx) },
    { label: "Tags…", fn: () => editTagsDialog(P) },
    sel.some((e) => e.tags && e.tags.length) && { label: "Remove all tags", fn: () => clearTags(P), key: "⌃⌘0" },
    "sep",
    P.git && P.mode === "browse" && { label: "Git", sub: () => gitMenu(P) },
    { label: "Share…", fn: () => share(P, sel.map((e) => e.path), x, y) },
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
