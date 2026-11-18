// Global keyboard: routes to the active pane. Text fields keep their own keys.

import { app } from "./core.js";
import { undo, redo, setClip, paste, duplicateSel, transferToOther, openTerminal, batchRename } from "./ops.js";
import { openTab, closeTab, cycleTab, gotoTab, setView } from "./tabs.js";
import { showPreviewFor, closePreview, previewStep, toggleDock } from "./preview.js";
import { hideCtx } from "./menu.js";
import { toggleHidden, toggleSidebar, toggleShelf, setZoom, zoomStep } from "./view.js";
import { quickLook, closeQuickLook } from "./system.js";
import { toggleNth, clearTags } from "./tags.js";

export function initKeys() {
  // Zoom works everywhere (even while typing), like any Mac app.
  window.addEventListener("keydown", (e) => {
    if (!e.metaKey || e.altKey || e.ctrlKey) return;
    const c = e.code;
    if (c === "Equal" || c === "NumpadAdd") { e.preventDefault(); e.stopImmediatePropagation(); zoomStep(1); }
    else if (c === "Minus" || c === "NumpadSubtract") { e.preventDefault(); e.stopImmediatePropagation(); zoomStep(-1); }
    else if (c === "Digit0" || c === "Numpad0") { e.preventDefault(); e.stopImmediatePropagation(); setZoom(1); }
  });
  window.addEventListener("keydown", (e) => {
    if (app.modalOpen || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
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
    if (e.key === " ") { e.preventDefault(); quickLook(P); return; }
    if (e.key === "Escape" && app.qlOpen) { e.preventDefault(); closeQuickLook(); return; }

    const mod = e.metaKey || e.ctrlKey;
    const code = e.code; // layout-independent (⌥ changes e.key on macOS)
    const k = (fn) => { e.preventDefault(); fn(); };

    // Tags: ⌃⌘1–7 toggle the favourite tags, ⌃⌘0 clears.
    if (e.metaKey && e.ctrlKey && /^Digit[0-9]$/.test(code)) return k(() => (code === "Digit0" ? clearTags(P) : toggleNth(P, +code.slice(5))));

    // Tabs
    if (mod && !e.shiftKey && code === "KeyT") return k(() => openTab(P.cwd));
    if (mod && !e.shiftKey && code === "KeyW") { if (app.tabs.length > 1) k(() => closeTab()); return; } // last tab: let ⌘W close the window
    if (e.ctrlKey && e.key === "Tab") return k(() => cycleTab(e.shiftKey ? -1 : 1));
    if (e.metaKey && e.shiftKey && code === "BracketRight") return k(() => cycleTab(1));
    if (e.metaKey && e.shiftKey && code === "BracketLeft") return k(() => cycleTab(-1));
    if (e.metaKey && !e.shiftKey && !e.altKey && /^Digit[1-9]$/.test(code)) return k(() => gotoTab(+code.slice(5)));

    // Panels & view
    if (e.key === "F9" || (e.metaKey && e.ctrlKey && code === "KeyS")) return k(toggleSidebar);
    if (mod && e.shiftKey && code === "Period") return k(toggleHidden);
    if (mod && e.shiftKey && code === "KeyF") return k(toggleShelf);
    if (mod && e.key === "\\") return k(() => setView(app.tab.view === "single" ? "twin" : "single"));
    if (mod && !e.shiftKey && code === "KeyP") return k(toggleDock);

    // Create / rename / edit
    if (mod && e.shiftKey && code === "KeyN") return k(() => P.newItem(true));
    if (mod && e.altKey && code === "KeyN") return k(() => P.newItem(false));
    if (e.key === "F10") return k(() => P.newItem(true)); // Dolphin's binding
    if (e.key === "F2") return k(() => { const s = P.selectedEntries(); if (s.length === 1) P.startRename(s[0].path); else if (s.length > 1) batchRename(P); });
    if (mod && e.altKey && code === "KeyT") return k(() => P.cwd && openTerminal(P, P.cwd));
    if (mod && !e.shiftKey && code === "KeyZ") return k(undo);
    if (mod && e.shiftKey && code === "KeyZ") return k(redo);
    if (mod && code === "KeyC") return k(() => setClip(P, false));
    if (mod && code === "KeyX") return k(() => setClip(P, true));
    if (mod && e.altKey && code === "KeyV") return k(() => paste(P, null, { move: true })); // Finder's "Move Item Here"
    if (mod && code === "KeyV") return k(() => paste(P));
    if (mod && code === "KeyD") return k(() => duplicateSel(P));
    if (mod && code === "KeyF") return k(() => { P.els.search.focus(); P.els.search.select(); });
    if (mod && code === "KeyL") return k(() => P.editPath());
    if (mod && code === "KeyR") return k(() => P.reload());
    if (mod && code === "KeyA") return k(() => P.selectAll());

    // Navigation
    if (mod && e.shiftKey && code === "KeyH") return k(P.goHome);
    if (mod && e.key === "ArrowUp") return k(P.goUp);
    if (mod && e.key === "ArrowDown") return k(() => P.enterOrOpen());
    if (mod && !e.shiftKey && code === "BracketLeft") return k(P.goBack);
    if (mod && !e.shiftKey && code === "BracketRight") return k(P.goFwd);

    if (e.key === "Escape") { hideCtx(); if (P.selected.size || P.mode !== "search") P.clearSel(); else P.reload(); return; }
    if (e.key === "F5") return k(() => transferToOther(P, true));
    if (e.key === "F6") return k(() => transferToOther(P, false));
    if (e.key === "Backspace" || e.key === "Delete") return k(() => P.selected.size && P.trashSelected());
    if (e.key === "Enter") return k(() => P.enterOrOpen());
    if (e.key === "ArrowDown") return k(() => P.moveCursor(1, e.shiftKey));
    if (e.key === "ArrowUp") return k(() => P.moveCursor(-1, e.shiftKey));
    // ← → step through the folder shelf (and on into the files).
    if (app.folderShelf && P.mode === "browse" && (e.key === "ArrowRight" || e.key === "ArrowLeft")) return k(() => P.moveCursor(e.key === "ArrowRight" ? 1 : -1, e.shiftKey));
    if (!mod && !e.altKey && e.key.length === 1 && e.key !== " ") P.typeAhead(e.key);
  });
}
