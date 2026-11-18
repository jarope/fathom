// File operations shared by every pane: move/copy (with conflict handling
// and progress), duplicate, clipboard (interoperates with Finder), compress /
// extract, batch rename, and undo. Nothing is ever overwritten in place: a
// "Replace" sends the existing item to the Bin first.

import { app, invoke, dialog, baseName, plural } from "./core.js";
import { visiblePanes } from "./tabs.js";
import { closePreview } from "./preview.js";
import { runJob } from "./jobs.js";
import { resolveConflicts, batchRenameDialog } from "./dialog.js";

const flashActive = (msg, cls) => (app.active || app.tab.panes[0]).flash(msg, cls);

export const refreshAll = () => Promise.all(visiblePanes().map((p) => p.reload()));
export const selectEverywhere = (paths) => visiblePanes().forEach((p) => p.selectPaths(paths));

// ---- Undo (global, like Dolphin's) ----
// Each op knows how to reverse itself without ever overwriting:
//   rename / batch → rename back; move → exact move back (refused if occupied);
//   copy / duplicate / create / compress / extract → created items go to the Bin.
export const undoStack = [];
export const pushUndo = (op) => { undoStack.push(op); if (undoStack.length > 50) undoStack.shift(); };

export async function undo() {
  const op = undoStack.pop();
  if (!op) { flashActive("Nothing to undo"); return; }
  try {
    if (op.kind === "rename") {
      await invoke("rename_path", { path: op.to, newName: baseName(op.from) });
    } else if (op.kind === "batch") {
      await invoke("batch_rename_cmd", { items: op.pairs.map(([from, to]) => [to, baseName(from)]) });
    } else if (op.kind === "move") {
      const rep = await invoke("move_exact_paths", { pairs: op.pairs.map(([s, d]) => [d, s]).reverse() });
      if (rep.errors.length) throw rep.errors[0];
    } else {
      await invoke("move_to_trash", { paths: op.created });
    }
    await refreshAll();
    if (op.kind === "rename") selectEverywhere([op.from]);
    if (op.kind === "batch" || op.kind === "move") selectEverywhere(op.pairs.map((x) => x[0]));
    const binned = !["rename", "batch", "move"].includes(op.kind);
    flashActive(`Undid ${op.label}${binned ? " — moved to Bin" : ""}${op.replacedNote ? " (replaced items are still in the Bin)" : ""}`);
  } catch (e) {
    await refreshAll();
    flashActive("⚠ Undo failed: " + e, "warn");
  }
}

// ---- Clipboard: ⌘C / ⌘X / ⌘V, shared with Finder via the system pasteboard ----
export async function setClip(P, cut) {
  const paths = P.selectedPaths(); if (!paths.length) return;
  app.clip = { paths, cut, cc: null };
  try { app.clip.cc = await invoke("pasteboard_write", { paths }); } catch {}
  visiblePanes().forEach((p) => p.markCut());
  P.flash(`${cut ? "Cut" : "Copied"} ${plural(paths.length, "item")} — ⌘V to paste${cut ? "" : " (works in Finder too)"}`);
}

/**
 * Paste into `dest` (default: P's folder). Our own clipboard wins while it's
 * still current (so a cut moves); otherwise files copied in Finder are pasted.
 * `move` (⌥⌘V) moves instead of copies, like Finder.
 */
export async function paste(P, dest, { move = false } = {}) {
  dest = dest || P.cwd;
  let pb = null;
  try { pb = await invoke("pasteboard_read"); } catch {}
  const ours = app.clip && (!pb || app.clip.cc == null || pb.change_count === app.clip.cc);
  if (ours) {
    const { paths, cut } = app.clip;
    if (cut || move) { app.clip = null; visiblePanes().forEach((p) => p.markCut()); }
    await performTransfer(paths, dest, !(cut || move));
    return;
  }
  if (pb && pb.paths.length) { await performTransfer(pb.paths, dest, !move); return; }
  P.flash("The clipboard has no files to paste");
}

// ---- Move / copy (conflict check → job with progress → refresh + undo) ----
export async function performTransfer(paths, destDir, copy) {
  if (!paths || !paths.length || !destDir) return;
  let policies = null;
  try {
    const conflicts = await invoke("plan_transfer", { sources: paths, destDir });
    if (conflicts.length) {
      policies = await resolveConflicts(conflicts, destDir, copy);
      if (!policies) return; // cancelled
    }
  } catch (e) { flashActive("⚠ " + e, "warn"); return; }

  const label = `${copy ? "Copying" : "Moving"} ${plural(paths.length, "item")} to “${baseName(destDir)}”`;
  let res;
  try { res = await runJob("start_transfer", { sources: paths, destDir, copy, policies }, label); }
  catch (e) { flashActive("⚠ " + e, "warn"); return; }
  const rep = res.report, n = rep.pairs.length;
  if (n) pushUndo(copy
    ? { kind: "copy", created: rep.pairs.map((x) => x[1]), label: `copy of ${plural(n, "item")}` }
    : { kind: "move", pairs: rep.pairs, label: `move of ${plural(n, "item")}`, replacedNote: rep.replaced > 0 });
  await refreshAll();
  selectEverywhere(rep.pairs.filter(([s]) => paths.includes(s)).map((x) => x[1]).concat(rep.merged ? paths.map((p) => destDir.replace(/\/$/, "") + "/" + baseName(p)) : []));

  const bits = [`${copy ? "Copied" : "Moved"} ${rep.done}`];
  if (rep.merged) bits.push(`${rep.merged} merged`);
  if (rep.replaced) bits.push(`${rep.replaced} replaced (old ones in the Bin)`);
  if (rep.renamed) bits.push(`${rep.renamed} kept as “copy”`);
  if (rep.skipped) bits.push(`${rep.skipped} skipped`);
  let msg = bits.join(" · ");
  if (res.cancelled) msg = rep.done ? `Cancelled — ${msg} before stopping` : `Cancelled — nothing was ${copy ? "copied" : "moved"}`;
  if (n) msg += " · ⌘Z undoes";
  flashActive(rep.errors.length ? `${msg} · ⚠ ${rep.errors[0]}` : msg, rep.errors.length || res.cancelled ? "warn" : "msg");
  if (app.previewOpen && !copy) closePreview(); // the previewed item just left this folder
}

/** F5 / F6 in twin view: copy / move the selection to the other pane's folder. */
export function transferToOther(P, copy) {
  if (app.tab.view !== "twin" || !P.selected.size) return;
  const o = app.tab.panes.find((x) => x !== P);
  if (o && o.cwd) performTransfer(P.selectedPaths(), o.cwd, copy);
}

/** Run a job that creates new items (duplicate / compress / extract). */
async function createJob(P, cmd, args, label, undoLabel, doneMsg) {
  let res;
  try { res = await runJob(cmd, args, label); }
  catch (e) { P.flash("⚠ " + e, "warn"); return; }
  const rep = res.report, created = rep.pairs.map((x) => x[1]);
  if (created.length) pushUndo({ kind: "copy", created, label: undoLabel(created.length) });
  await refreshAll();
  selectEverywhere(created);
  let msg = res.cancelled && !created.length ? "Cancelled" : (res.cancelled ? "Cancelled — " : "") + doneMsg(created.length);
  if (created.length) msg += " · ⌘Z undoes";
  P.flash(rep.errors.length ? `${msg} · ⚠ ${rep.errors[0]}` : msg, rep.errors.length || res.cancelled ? "warn" : "msg");
}

export function duplicateSel(P) {
  const sel = P.selectedPaths(); if (!sel.length) return;
  return createJob(P, "start_duplicate", { sources: sel }, `Duplicating ${plural(sel.length, "item")}`, (n) => `duplicate of ${plural(n, "item")}`, (n) => `Duplicated ${plural(n, "item")}`);
}

export function compressSel(P) {
  const sel = P.selectedPaths(); if (!sel.length) return;
  const label = sel.length === 1 ? `Compressing “${baseName(sel[0])}”` : `Compressing ${plural(sel.length, "item")}`;
  return createJob(P, "start_compress", { sources: sel }, label, () => "compress", (n) => (n ? "Created the archive" : "No archive created"));
}

export const ARCHIVE_RE = /\.(zip|tar|tgz|tbz2?|txz|7z|rar|xar|cpio|tar\.(gz|bz2|xz|zst))$/i;
export const isArchive = (e) => !e.is_dir && ARCHIVE_RE.test(e.name);

export function extractSel(P) {
  const archives = P.selectedEntries().filter(isArchive).map((e) => e.path);
  if (!archives.length) return;
  const label = archives.length === 1 ? `Extracting “${baseName(archives[0])}”` : `Extracting ${plural(archives.length, "archive")}`;
  return createJob(P, "start_extract", { archives }, label, (n) => `extract of ${plural(n, "archive")}`, (n) => `Extracted ${plural(n, "archive")}`);
}

export async function batchRename(P) {
  const entries = P.selectedEntries(); if (entries.length < 2) return;
  let pairs = null;
  const done = await batchRenameDialog(entries, async (items) => {
    try { pairs = await invoke("batch_rename_cmd", { items }); return null; }
    catch (e) { return String(e); }
  });
  if (!done || !pairs) return;
  pushUndo({ kind: "batch", pairs, label: `rename of ${plural(pairs.length, "item")}` });
  await refreshAll();
  selectEverywhere(pairs.map((x) => x[1]));
  P.flash(`Renamed ${plural(pairs.length, "item")} · ⌘Z undoes`);
}

export async function pickAndTransfer(P, copy) {
  if (!dialog) return;
  const sel = P.selectedPaths(); if (!sel.length) return;
  const dest = await dialog.open({ directory: true, multiple: false, defaultPath: P.cwd, title: copy ? "Copy to…" : "Move to…" });
  if (typeof dest === "string") performTransfer(sel, dest, copy);
}

export const openTerminal = (P, path) => invoke("open_terminal", { path }).catch((e) => P.flash("⚠ " + e, "warn"));
