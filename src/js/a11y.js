// Accessibility: what VoiceOver needs to make sense of Fathom, added in one
// place instead of in every view.
//   • Each pane's file list is a multi-select list; rows / tiles / grid cells
//     are its items (name + kind, selected or not), and the keyboard cursor
//     is the active item, so VoiceOver follows ↑ ↓.
//   • The status bar is read out (politely) when it changes.
//   • Sidebar places and tabs can be reached with Tab and opened with ⏎ /
//     Space, like buttons.
// Menus and dialogs mark themselves up in menu.js / dialog.js.

import { isFolder } from "./core.js";
import { kindLabel } from "./details.js";
import { binLabel } from "./bin.js";

let seq = 0;

/** Wire pane P's list and status bar. Call once per pane. */
export function a11yPane(P) {
  const L = P.els.listing, id = "p" + ++seq;
  L.setAttribute("role", "listbox");
  L.setAttribute("aria-multiselectable", "true");
  L.tabIndex = 0;
  P.els.status.setAttribute("aria-live", "polite");
  P.els.status.setAttribute("role", "status");
  let queued = 0;
  const sync = () => {
    queued = 0;
    L.setAttribute("aria-label", P.mode === "search" ? "Search results" : `Files in ${P.cwd === "/" ? "Macintosh HD" : binLabel(P.cwd) || (P.cwd || "").split("/").pop()}`);
    let active = null;
    L.querySelectorAll(".row[data-i]").forEach((r) => {
      const i = +r.dataset.i, e = P.entries[i];
      if (!e) return;
      if (!r.id) r.id = `${id}-${i}`;
      r.setAttribute("role", "option");
      r.setAttribute("aria-selected", P.selected.has(e.path) ? "true" : "false");
      r.setAttribute("aria-setsize", String(P.entries.length));
      r.setAttribute("aria-posinset", String(i + 1));
      if (!r.hasAttribute("aria-label")) r.setAttribute("aria-label", `${e.name}, ${isFolder(e) ? "folder" : kindLabel(e)}`);
      if (i === P.cursor) active = r;
    });
    if (active) L.setAttribute("aria-activedescendant", active.id); else L.removeAttribute("aria-activedescendant");
  };
  const later = () => { if (!queued) { queued = 1; queueMicrotask(sync); } };
  new MutationObserver(later).observe(L, { childList: true, subtree: true });
  return later; // call after selection changes
}

/** Make a clickable element keyboard-reachable: Tab to it, ⏎ / Space click it. */
export function asButton(n, label) {
  n.tabIndex = 0;
  if (!n.getAttribute("role")) n.setAttribute("role", "button");
  if (label) n.setAttribute("aria-label", label);
  n.addEventListener("keydown", (e) => {
    if (e.target !== n || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault(); e.stopPropagation();
    n.click();
  });
  return n;
}
