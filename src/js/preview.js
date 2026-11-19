// Quick-Look-style full preview (Space) and the docked half-view panel that
// tracks the current tab's left pane.

import { app, store } from "./core.js";
import { getPreview, isPreviewable, dimText } from "./previews.js";
import { openContextMenu } from "./menu.js";

let preview, pvImg, pvName, pvDim;
let dock, dockImg, dockEmpty, dockName, dockDim;

export function initPreview() {
  const $ = (id) => document.getElementById(id);
  preview = $("preview"); pvImg = $("pvImg"); pvName = $("pvName"); pvDim = $("pvDim");
  dock = $("dock"); dockImg = $("dockImg"); dockEmpty = $("dockEmpty"); dockName = $("dockName"); dockDim = $("dockDim");

  // Left-click the backdrop closes; clicks on the image/caption don't.
  preview.addEventListener("click", (ev) => { if (ev.target === preview) closePreview(); });
  // Right-click anywhere in the big view opens the normal menu for the shown image.
  preview.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    const P = app.active; if (!P) return;
    const e = previewTarget(P); if (e) P.selectSingle(P.entries.indexOf(e));
    openContextMenu(P, ev.clientX, ev.clientY);
  });
  $("dockToggle").addEventListener("click", toggleDock);
  dockImg.addEventListener("click", () => showPreviewFor(app.tab.panes[0]));
}

export function previewTarget(P) {
  let e = P.cursor >= 0 ? P.entries[P.cursor] : null;
  if (!(e && !e.is_dir && isPreviewable(e.name))) e = P.selectedEntries().find((x) => !x.is_dir && isPreviewable(x.name)) || null;
  return e;
}

/** Step the selection to the next/prev previewable file (skipping folders etc.). */
export function previewStep(P, dir) {
  for (let i = P.cursor + dir; i >= 0 && i < P.entries.length; i += dir) {
    const e = P.entries[i];
    if (!e.is_dir && isPreviewable(e.name)) {
      P.selectSingle(i);
      P.reveal(i);
      return true;
    }
  }
  return false;
}

export async function showPreviewFor(P) {
  const e = previewTarget(P);
  if (!e) return false;
  P.selectSingle(P.entries.indexOf(e)); // keep the pane selection == what's shown, so ops act on it
  pvName.textContent = e.name; pvDim.textContent = "…";
  preview.classList.add("show"); app.previewOpen = true;
  const t = await getPreview(e.path, e.name, 1600);
  if (t && t.data) { pvImg.src = t.data; pvDim.textContent = dimText(t, e.size); }
  else { pvImg.removeAttribute("src"); pvDim.textContent = "can't preview"; }
  return true;
}

export function closePreview() {
  if (!preview) return;
  preview.classList.remove("show"); app.previewOpen = false; pvImg.removeAttribute("src");
}

// ---- docked panel: right of the pane in single view, under the left pane in twin ----
export function toggleDock() {
  app.dockPreview = !app.dockPreview;
  store.set("fathom-dock", app.dockPreview);
  placeDock();
}

export function placeDock() {
  if (!dock || !app.tab) return;
  document.getElementById("dockToggle").classList.toggle("on", app.dockPreview);
  if (!app.dockPreview) { dock.style.display = "none"; if (dock.parentNode) dock.remove(); return; }
  dock.style.display = "flex";
  const left = app.tab.panes[0];
  if (app.tab.view === "single") { dock.className = "dock side"; document.getElementById("panes").append(dock); }
  else { dock.className = "dock bottom"; left.root.insertBefore(dock, left.els.status); }
  refreshDock();
}

export async function refreshDock() {
  if (!app.dockPreview || !app.tab) return;
  const e = previewTarget(app.tab.panes[0]);
  if (!e) { dockImg.style.display = "none"; dockEmpty.style.display = "block"; dockName.textContent = ""; dockDim.textContent = ""; return; }
  dockEmpty.style.display = "none"; dockName.textContent = e.name; dockDim.textContent = "…";
  const t = await getPreview(e.path, e.name, 1200);
  if (previewTarget(app.tab.panes[0]) !== e) return; // selection moved on while loading
  if (t && t.data) { dockImg.src = t.data; dockImg.style.display = "block"; dockDim.textContent = dimText(t, e.size); }
  else { dockImg.style.display = "none"; dockDim.textContent = "can't preview"; }
}
