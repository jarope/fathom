// Quick-Look-style full preview (Space) — used when native Quick Look isn't
// available (the browser test harness).

import { app } from "./core.js";
import { getPreview, isPreviewable, dimText } from "./previews.js";
import { openContextMenu } from "./menu.js";

let preview, pvImg, pvName, pvDim;

export function initPreview() {
  const $ = (id) => document.getElementById(id);
  preview = $("preview"); pvImg = $("pvImg"); pvName = $("pvName"); pvDim = $("pvDim");

  // Left-click the backdrop closes; clicks on the image/caption don't.
  preview.addEventListener("click", (ev) => { if (ev.target === preview) closePreview(); });
  // Right-click anywhere in the big view opens the normal menu for the shown image.
  preview.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    const P = app.active; if (!P) return;
    const e = previewTarget(P); if (e) P.selectSingle(P.entries.indexOf(e));
    openContextMenu(P, ev.clientX, ev.clientY);
  });
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
