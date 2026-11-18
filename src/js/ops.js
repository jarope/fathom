// File operations shared by every pane: move/copy, duplicate, clipboard, undo.
// Nothing here ever overwrites — the backend auto-renames collisions.

import { app, invoke, dialog, baseName, plural } from "./core.js";
import { visiblePanes } from "./tabs.js";
import { closePreview } from "./preview.js";

const flashActive = (msg, cls) => (app.active || app.tab.panes[0]).flash(msg, cls);

export const refreshAll = () => Promise.all(visiblePanes().map((p) => p.reload()));
export const selectEverywhere = (paths) => visiblePanes().forEach((p) => p.selectPaths(paths));

// ---- Undo (global, like Dolphin's) ----
// Each op knows how to reverse itself without ever overwriting:
//   rename → rename back; move → exact move back (refused if occupied);
//   copy / duplicate / create → the created items go to the Bin (recoverable).
export const undoStack = [];
export const pushUndo = (op) => { undoStack.push(op); if (undoStack.length > 50) undoStack.shift(); };

export async function undo() {
  const op = undoStack.pop();
  if (!op) { flashActive("Nothing to undo"); return; }
  try {
    if (op.kind === "rename") {
      await invoke("rename_path", { path: op.to, newName: baseName(op.from) });
    } else if (op.kind === "move") {
      const rep = await invoke("move_exact_paths", { pairs: op.pairs.map(([s, d]) => [d, s]) });
      if (rep.errors.length) throw rep.errors[0];
    } else {
      await invoke("move_to_trash", { paths: op.created });
    }
    await refreshAll();
    if (op.kind === "rename") selectEverywhere([op.from]);
    if (op.kind === "move") selectEverywhere(op.pairs.map((x) => x[0]));
    flashActive(`Undid ${op.label}${op.kind === "rename" || op.kind === "move" ? "" : " — moved to Bin"}`);
  } catch (e) {
    await refreshAll();
    flashActive("⚠ Undo failed: " + e, "warn");
  }
}

// ---- Clipboard (⌘C / ⌘X / ⌘V) ----
export function setClip(P, cut) {
  const paths = P.selectedPaths(); if (!paths.length) return;
  app.clip = { paths, cut };
  navigator.clipboard.writeText(paths.join("\n")).catch(() => {}); // paths as text, for pasting elsewhere
  visiblePanes().forEach((p) => p.markCut());
  P.flash(`${cut ? "Cut" : "Copied"} ${plural(paths.length, "item")} — ⌘V to paste`);
}

export async function paste(P, dest) {
  if (!app.clip) { P.flash("Clipboard is empty"); return; }
  const { paths, cut } = app.clip;
  if (cut) app.clip = null; // a cut is consumed by its paste
  await performTransfer(paths, dest || P.cwd, !cut);
}

// ---- Move / copy ----
export async function performTransfer(paths, destDir, copy) {
  if (!paths || !paths.length || !destDir) return;
  let rep;
  try {
    rep = await invoke(copy ? "copy_paths" : "move_paths", { sources: paths, destDir });
  } catch (e) { flashActive("⚠ " + e, "warn"); return; }
  const n = rep.pairs.length;
  if (n) pushUndo(copy
    ? { kind: "copy", created: rep.pairs.map((x) => x[1]), label: `copy of ${plural(n, "item")}` }
    : { kind: "move", pairs: rep.pairs, label: `move of ${plural(n, "item")}` });
  await refreshAll(); // both source and destination update
  selectEverywhere(rep.pairs.map((x) => x[1]));
  let msg = `${copy ? "Copied" : "Moved"} ${rep.done}`;
  if (rep.renamed) msg += ` (${rep.renamed} renamed to avoid overwrite)`;
  if (rep.skipped) msg += `, ${rep.skipped} already there`;
  if (n) msg += " · ⌘Z undoes";
  flashActive(rep.errors.length ? `${msg} · ⚠ ${rep.errors[0]}` : msg, rep.errors.length ? "warn" : "msg");
  if (app.previewOpen && !copy) closePreview(); // the previewed item just left this folder
}

/** F5 / F6 in twin view: copy / move the selection to the other pane's folder. */
export function transferToOther(P, copy) {
  if (app.tab.view !== "twin" || !P.selected.size) return;
  const o = app.tab.panes.find((x) => x !== P);
  if (o && o.cwd) performTransfer(P.selectedPaths(), o.cwd, copy);
}

export async function duplicateSel(P) {
  const sel = P.selectedPaths(); if (!sel.length) return;
  let rep;
  try { rep = await invoke("duplicate_paths", { sources: sel }); }
  catch (e) { P.flash("⚠ " + e, "warn"); return; }
  const n = rep.pairs.length;
  if (n) pushUndo({ kind: "copy", created: rep.pairs.map((x) => x[1]), label: `duplicate of ${plural(n, "item")}` });
  await refreshAll();
  selectEverywhere(rep.pairs.map((x) => x[1]));
  P.flash(rep.errors.length ? `Duplicated ${n} · ⚠ ${rep.errors[0]}` : `Duplicated ${n}`, rep.errors.length ? "warn" : "msg");
}

export async function pickAndTransfer(P, copy) {
  if (!dialog) return;
  const sel = P.selectedPaths(); if (!sel.length) return;
  const dest = await dialog.open({ directory: true, multiple: false, defaultPath: P.cwd, title: copy ? "Copy to…" : "Move to…" });
  if (typeof dest === "string") performTransfer(sel, dest, copy);
}

export const openTerminal = (P, path) => invoke("open_terminal", { path }).catch((e) => P.flash("⚠ " + e, "warn"));
