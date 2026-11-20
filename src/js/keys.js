// Keyboard. Every rebindable shortcut is a named command with default keys;
// Preferences → Shortcuts can change them (saved in settings.json). A few
// keys stay fixed: arrows, ⏎, Esc, type-ahead, ⌘1–9 (tabs), ⌃⌘0–9 (tags).
//
// A key combo is written "Ctrl+Alt+Shift+Cmd+<KeyboardEvent.code>", e.g.
// "Shift+Cmd+KeyN" — layout-independent, and ⌥ doesn't change it.

import { app } from "./core.js";
import { undo, redo, setClip, paste, duplicateSel, transferToOther, openTerminal, batchRename } from "./ops.js";
import { openTab, closeTab, cycleTab, gotoTab, setView } from "./tabs.js";
import { showPreviewFor, closePreview, previewStep, toggleDock } from "./preview.js";
import { hideCtx } from "./menu.js";
import { toggleHidden, toggleSidebar, toggleShelf, setZoom, zoomStep } from "./view.js";
import { gridSize, setGridSize } from "./grid.js";
import { quickLook, closeQuickLook } from "./system.js";
import { toggleNth, clearTags } from "./tags.js";
import { commitDialog, push } from "./git.js";
import { prefs } from "./settings.js";
import { openPrefs } from "./prefs.js";
import { getInfo } from "./info.js";
import { actions, runOnSelection } from "./actions.js";

function zoomOrIcons(P, dir) {
  if (!P || P.viewMode !== "grid") { zoomStep(dir); return; }
  setGridSize(gridSize() + dir * 16);
  P.flash(`Icon size ${gridSize()} pt`);
}

const rename = (P) => { const s = P.selectedEntries(); if (s.length === 1) P.startRename(s[0].path); else if (s.length > 1) batchRename(P); };

/**
 * id, label, group, default keys, run(P). `global` commands also work while
 * typing in a text field. run() returning false lets the key through.
 */
export const COMMANDS = [
  // Files
  { id: "newFolder", group: "Files", label: "New Folder", keys: ["Shift+Cmd+KeyN", "F10"], run: (P) => P.newItem(true) },
  { id: "newFile", group: "Files", label: "New Text File", keys: ["Alt+Cmd+KeyN"], run: (P) => P.newItem(false) },
  { id: "rename", group: "Files", label: "Rename", keys: ["F2"], run: rename },
  { id: "duplicate", group: "Files", label: "Duplicate", keys: ["Cmd+KeyD"], run: duplicateSel },
  { id: "trash", group: "Files", label: "Move to Bin", keys: ["Backspace", "Delete", "Cmd+Backspace"], run: (P) => P.selected.size && P.trashSelected() },
  { id: "copy", group: "Files", label: "Copy", keys: ["Cmd+KeyC"], run: (P) => setClip(P, false) },
  { id: "cut", group: "Files", label: "Cut", keys: ["Cmd+KeyX"], run: (P) => setClip(P, true) },
  { id: "paste", group: "Files", label: "Paste", keys: ["Cmd+KeyV"], run: (P) => paste(P) },
  { id: "moveHere", group: "Files", label: "Move Here (from clipboard)", keys: ["Alt+Cmd+KeyV"], run: (P) => paste(P, null, { move: true }) },
  { id: "copyOther", group: "Files", label: "Copy to other pane", keys: ["F5"], run: (P) => transferToOther(P, true) },
  { id: "moveOther", group: "Files", label: "Move to other pane", keys: ["F6"], run: (P) => transferToOther(P, false) },
  { id: "undo", group: "Files", label: "Undo", keys: ["Cmd+KeyZ"], run: undo },
  { id: "redo", group: "Files", label: "Redo", keys: ["Shift+Cmd+KeyZ"], run: redo },
  { id: "quickLook", group: "Files", label: "Quick Look", keys: ["Space"], run: quickLook },
  { id: "getInfo", group: "Files", label: "Get Info", keys: ["Cmd+KeyI"], run: (P) => getInfo(P) },
  { id: "open", group: "Files", label: "Open", keys: ["Cmd+ArrowDown"], run: (P) => P.enterOrOpen() },
  { id: "selectAll", group: "Files", label: "Select All", keys: ["Cmd+KeyA"], run: (P) => P.selectAll() },
  // Go
  { id: "back", group: "Go", label: "Back", keys: ["Cmd+BracketLeft"], run: (P) => P.goBack() },
  { id: "forward", group: "Go", label: "Forward", keys: ["Cmd+BracketRight"], run: (P) => P.goFwd() },
  { id: "up", group: "Go", label: "Enclosing Folder", keys: ["Cmd+ArrowUp"], run: (P) => P.goUp() },
  { id: "home", group: "Go", label: "Home", keys: ["Shift+Cmd+KeyH"], run: (P) => P.goHome() },
  { id: "editPath", group: "Go", label: "Type a Path", keys: ["Cmd+KeyL"], run: (P) => P.editPath() },
  { id: "find", group: "Go", label: "Search", keys: ["Cmd+KeyF"], run: (P) => { P.els.search.focus(); P.els.search.select(); } },
  { id: "reload", group: "Go", label: "Reload", keys: ["Cmd+KeyR"], run: (P) => P.reload() },
  { id: "terminal", group: "Go", label: "Open Terminal Here", keys: ["Alt+Cmd+KeyT"], run: (P) => P.cwd && openTerminal(P, P.cwd) },
  // Tabs & view
  { id: "newTab", group: "Tabs & View", label: "New Tab", keys: ["Cmd+KeyT"], run: (P) => openTab(P.cwd) },
  { id: "closeTab", group: "Tabs & View", label: "Close Tab", keys: ["Cmd+KeyW"], run: () => (app.tabs.length > 1 ? closeTab() : false) }, // last tab: ⌘W closes the window
  { id: "nextTab", group: "Tabs & View", label: "Next Tab", keys: ["Ctrl+Tab", "Shift+Cmd+BracketRight"], run: () => cycleTab(1) },
  { id: "prevTab", group: "Tabs & View", label: "Previous Tab", keys: ["Ctrl+Shift+Tab", "Shift+Cmd+BracketLeft"], run: () => cycleTab(-1) },
  { id: "twin", group: "Tabs & View", label: "Single / Twin Pane", keys: ["Cmd+Backslash"], run: () => setView(app.tab.view === "single" ? "twin" : "single") },
  { id: "sidebar", group: "Tabs & View", label: "Sidebar", keys: ["F9", "Ctrl+Cmd+KeyS"], run: toggleSidebar },
  { id: "hidden", group: "Tabs & View", label: "Show Hidden Files", keys: ["Shift+Cmd+Period"], run: toggleHidden },
  { id: "viewGrid", group: "Tabs & View", label: "View as Grid", keys: ["Alt+Cmd+Digit1"], run: (P) => P.setViewMode("grid") },
  { id: "viewDetails", group: "Tabs & View", label: "View as Details", keys: ["Alt+Cmd+Digit2"], run: (P) => P.setViewMode("details") },
  { id: "viewColumns", group: "Tabs & View", label: "View as Columns", keys: ["Alt+Cmd+Digit3"], run: (P) => P.setViewMode("columns") },
  { id: "shelf", group: "Tabs & View", label: "Folder Shelf", keys: ["Shift+Cmd+KeyF"], run: toggleShelf },
  { id: "dock", group: "Tabs & View", label: "Preview Panel", keys: ["Cmd+KeyP"], run: toggleDock },
  // Like Finder: in a grid pane ⌘+ / ⌘− change the icon size; elsewhere they zoom the window.
  { id: "zoomIn", group: "Tabs & View", label: "Zoom In (icon size in grid)", keys: ["Cmd+Equal", "Cmd+NumpadAdd"], global: true, run: (P) => zoomOrIcons(P, 1) },
  { id: "zoomOut", group: "Tabs & View", label: "Zoom Out (icon size in grid)", keys: ["Cmd+Minus", "Cmd+NumpadSubtract"], global: true, run: (P) => zoomOrIcons(P, -1) },
  { id: "winZoomIn", group: "Tabs & View", label: "Zoom Window In", keys: ["Alt+Cmd+Equal"], global: true, run: () => zoomStep(1) },
  { id: "winZoomOut", group: "Tabs & View", label: "Zoom Window Out", keys: ["Alt+Cmd+Minus"], global: true, run: () => zoomStep(-1) },
  { id: "zoomReset", group: "Tabs & View", label: "Actual Size", keys: ["Cmd+Digit0", "Cmd+Numpad0"], global: true, run: () => setZoom(1) },
  // Git & app
  { id: "gitCommit", group: "Git", label: "Commit…", keys: [], run: (P) => P.git && commitDialog(P) },
  { id: "gitPush", group: "Git", label: "Push", keys: [], run: (P) => P.git && push(P) },
  { id: "prefs", group: "Fathom", label: "Preferences…", keys: ["Cmd+Comma"], global: true, run: () => openPrefs() },
];

/** Combos Fathom won't take (macOS owns them). */
export const RESERVED = new Set(["Cmd+KeyQ", "Cmd+KeyH", "Cmd+KeyM", "Alt+Cmd+KeyH", "Cmd+Tab", "Cmd+Space", "Ctrl+Space"]);
const FIXED = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Shift+ArrowUp", "Shift+ArrowDown", "Shift+ArrowLeft", "Shift+ArrowRight", "Enter", "Escape"];
export const isFixed = (c) => FIXED.includes(c) || /^Cmd\+Digit[1-9]$/.test(c) || /^Ctrl\+Cmd\+Digit[0-9]$/.test(c);

// User actions are commands too (no keys unless you give them some).
// Git-menu actions sit with the Git commands; the rest get their own group.
export const allCommands = () => {
  const cmd = (a) => ({ id: "action:" + a.name, group: a.menu === "git" ? "Git" : "Actions", label: a.name, keys: [], run: (P) => runOnSelection(P, a) });
  const git = actions.filter((a) => a.menu === "git").map(cmd);
  const lastGit = COMMANDS.map((c) => c.group).lastIndexOf("Git") + 1;
  return [...COMMANDS.slice(0, lastGit), ...git, ...COMMANDS.slice(lastGit), ...actions.filter((a) => a.menu !== "git").map(cmd)];
};

export const keysFor = (cmd) => prefs.shortcuts[cmd.id] || cmd.keys;
let keymap = new Map();
export function rebuildKeymap() {
  keymap = new Map();
  allCommands().forEach((c) => keysFor(c).forEach((k) => { if (!keymap.has(k)) keymap.set(k, c); }));
}
/** Which command a combo runs now (for clash warnings). */
export const commandFor = (combo) => keymap.get(combo) || null;

const MOD_CODES = /^(Shift|Control|Alt|Meta|OS|CapsLock|Fn)(Left|Right)?$/;
/** The combo for a keydown, or null for a lone modifier. */
export function comboOf(e) {
  if (!e.code || MOD_CODES.test(e.code)) return null;
  return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Cmd", e.code].filter(Boolean).join("+");
}

const NAMES = {
  Equal: "=", Minus: "−", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Period: ".", Comma: ",", Slash: "/",
  Semicolon: ";", Quote: "'", Backquote: "`", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  Backspace: "⌫", Delete: "⌦", Enter: "⏎", Escape: "Esc", Tab: "⇥", Space: "Space", NumpadAdd: "+ (keypad)",
  NumpadSubtract: "− (keypad)", Home: "↖", End: "↘", PageUp: "⇞", PageDown: "⇟",
};
/** "Shift+Cmd+KeyN" → "⇧⌘N". */
export function keyLabel(combo) {
  if (!combo) return "";
  const parts = combo.split("+"), code = parts.pop();
  const sym = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Cmd: "⌘" };
  const key = NAMES[code] || code.replace(/^Key|^Digit/, "").replace(/^Numpad(\d)$/, "$1 (keypad)");
  return parts.map((m) => sym[m]).join("") + key;
}
/** The first key of a command, for menus ("" when it has none). */
export const keyHint = (id) => { const c = COMMANDS.find((x) => x.id === id); return c ? keyLabel(keysFor(c)[0]) : ""; };

const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);

export function initKeys() {
  rebuildKeymap();
  // Global commands (zoom, Preferences) work everywhere, even while typing.
  window.addEventListener("keydown", (e) => {
    const cmd = keymap.get(comboOf(e));
    if (!cmd || !cmd.global || (app.modalOpen && cmd.id === "prefs")) return;
    e.preventDefault(); e.stopImmediatePropagation();
    cmd.run(app.active);
  });
  window.addEventListener("keydown", (e) => {
    if (app.modalOpen || typing()) return;
    const P = app.active; if (!P) return;

    if (app.previewOpen) {
      if (e.key === " " || e.key === "Escape") { e.preventDefault(); closePreview(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); if (previewStep(P, 1)) showPreviewFor(P); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); if (previewStep(P, -1)) showPreviewFor(P); return; }
      if (e.key === "F5") { e.preventDefault(); transferToOther(P, true); return; }
      if (e.key === "F6") { e.preventDefault(); transferToOther(P, false); return; }
      if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); if (P.selected.size) P.trashSelected(); return; }
      e.preventDefault(); return;
    }
    if (e.key === "Escape" && app.qlOpen) { e.preventDefault(); closeQuickLook(); return; }

    const combo = comboOf(e), code = e.code;
    const k = (fn) => { e.preventDefault(); fn(); };

    const cmd = combo && keymap.get(combo);
    if (cmd && !cmd.global) {
      if (cmd.run(P) !== false) e.preventDefault();
      return;
    }

    // Fixed keys
    if (e.metaKey && e.ctrlKey && /^Digit[0-9]$/.test(code)) return k(() => (code === "Digit0" ? clearTags(P) : toggleNth(P, +code.slice(5))));
    if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && /^Digit[1-9]$/.test(code)) return k(() => gotoTab(+code.slice(5)));
    if (e.key === "Escape") { hideCtx(); if (P.selected.size || P.mode !== "search") P.clearSel(); else P.reload(); return; }
    if (e.key === "Enter" && !e.metaKey) return k(() => P.enterOrOpen());
    if (e.key === "ArrowDown" && !e.metaKey) return k(() => P.moveLine(1, e.shiftKey));
    if (e.key === "ArrowUp" && !e.metaKey) return k(() => P.moveLine(-1, e.shiftKey));
    // ← →: open/close folders in Details, step through the shelf and the grid.
    if (P.mode === "browse" && !e.metaKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) return k(() => P.arrowSide(e.key === "ArrowRight" ? 1 : -1, e.shiftKey));
    if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1 && e.key !== " ") P.typeAhead(e.key);
  });
}
