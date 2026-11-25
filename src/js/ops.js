// File operations shared by every pane: move/copy (with conflict handling
// and progress), duplicate, clipboard (interoperates with Finder), compress /
// extract, batch rename, and undo. Nothing is ever overwritten in place: a
// "Replace" sends the existing item to the Bin first.

import { isRemote } from "./loc.js";
import { app, invoke, store, baseName, plural } from "./core.js";
import { visiblePanes } from "./tabs.js";
import { closePreview } from "./preview.js";
import { runJob } from "./jobs.js";
import { prefs } from "./settings.js";
import { resolveConflicts, batchRenameDialog } from "./dialog.js";

const flashActive = (msg, cls) => (app.active || app.tab.panes[0]).flash(msg, cls);

/** Copy the selected items' paths (one per line), or the folder's when nothing is selected (⌥⌘C). */
export function copyPaths(P) {
  const paths = P.selected.size ? P.selectedPaths() : P.cwd ? [P.cwd] : [];
  if (!paths.length) return;
  navigator.clipboard.writeText(paths.join("\n"));
  P.flash(paths.length > 1 ? `Copied ${paths.length} paths` : P.selected.size ? "Copied path" : "Copied folder path");
}
/** Servers are browse-only for now (SFTP Phase A): say so instead of failing.
 *  True when something here is on a server — the caller should stop. */
export function serverSoon(P, ...paths) {
  if (!paths.flat().some(isRemote)) return false;
  const who = P || app.active;
  if (who) who.flash("Servers are browse-only for now — copying, opening and changing files there comes in the next update", "warn");
  return true;
}

export const refreshAll = () => Promise.all(visiblePanes().map((p) => p.reload()));
export const selectEverywhere = (paths) => visiblePanes().forEach((p) => p.selectPaths(paths));

// ---- Undo / Redo (global, like Dolphin's) ----
// Every op can be reversed and re-applied without ever overwriting:
//   rename / batch → rename back · move → exact move back (refused if occupied)
//   copy / create (also duplicate, compress, extract) → created items go to the
//     Bin; redo brings them back out of it
//   trash → Put Back from the Bin; redo bins them again
// A new action clears the redo stack, as everywhere else.
export const undoStack = [];
export const redoStack = [];
export const pushUndo = (op) => { undoStack.push(op); if (undoStack.length > 50) undoStack.shift(); redoStack.length = 0; };

const moveExact = async (pairs) => {
  const rep = await invoke("move_exact_paths", { pairs });
  if (rep.errors.length) throw rep.errors[0];
};
const toBin = async (paths) => {
  const b = await invoke("move_to_trash", { paths });
  if (b.errors.length && !b.count) throw b.errors[0];
  return b;
};
const fromBin = async (pairs, what) => {
  if (!pairs || !pairs.length) throw `can't find ${what} in the Bin any more`;
  await moveExact(pairs.map(([orig, inBin]) => [inBin, orig]));
};

/** Apply `op` backwards (dir -1, undo) or forwards (dir +1, redo). Returns paths to select. */
async function apply(op, dir) {
  const undoing = dir < 0;
  switch (op.kind) {
    case "rename":
      await invoke("rename_path", undoing ? { path: op.to, newName: baseName(op.from) } : { path: op.from, newName: baseName(op.to) });
      return [undoing ? op.from : op.to];
    case "batch":
      await invoke("batch_rename_cmd", { items: op.pairs.map(([f, t]) => (undoing ? [t, baseName(f)] : [f, baseName(t)])) });
      return op.pairs.map((x) => x[undoing ? 0 : 1]);
    case "move":
      await moveExact(undoing ? op.pairs.map(([s, d]) => [d, s]).reverse() : op.pairs);
      return op.pairs.map((x) => x[undoing ? 0 : 1]);
    case "trash":
      if (undoing) { await fromBin(op.pairs, "them"); return op.pairs.map((x) => x[0]); }
      op.pairs = (await toBin(op.pairs.map((x) => x[0]))).pairs;
      return [];
    default: // copy / create: the op made new items
      if (undoing) { op.binned = (await toBin(op.created)).pairs; return []; }
      await fromBin(op.binned, "them"); op.binned = null;
      return op.created;
  }
}

async function step(from, to, dir) {
  const op = from.pop();
  if (!op) { flashActive(dir < 0 ? "Nothing to undo" : "Nothing to redo"); return; }
  try {
    const sel = await apply(op, dir);
    to.push(op);
    await refreshAll();
    if (sel.length) selectEverywhere(sel);
    const binned = (op.kind === "trash" && dir > 0) || (["copy", "create"].includes(op.kind) && dir < 0);
    const putBack = op.kind === "trash" && dir < 0;
    flashActive(`${dir < 0 ? "Undid" : "Redid"} ${op.label}${binned ? " — moved to Bin" : putBack ? " — put back from the Bin" : ""}${op.replacedNote && dir < 0 ? " (replaced items are still in the Bin)" : ""}`);
  } catch (e) {
    await refreshAll();
    flashActive(`⚠ ${dir < 0 ? "Undo" : "Redo"} failed: ${e}`, "warn");
  }
}

export const undo = () => step(undoStack, redoStack, -1);
export const redo = () => step(redoStack, undoStack, 1);

/** Move paths to the Bin, remembering where they went so ⌘Z puts them back. */
export async function trashPaths(P, paths) {
  if (!paths.length || serverSoon(P, paths)) return;
  let b;
  try { b = await invoke("move_to_trash", { paths }); }
  catch (e) { P.flash("⚠ " + e, "warn"); return; }
  if (b.pairs.length) pushUndo({ kind: "trash", pairs: b.pairs, label: `Move to Bin of ${plural(b.pairs.length, "item")}` });
  await refreshAll();
  if (app.previewOpen) closePreview();
  let msg = b.count ? `Moved ${plural(b.count, "item")} to the Bin${b.pairs.length ? " · ⌘Z puts back" : ""}` : "Nothing was moved to the Bin";
  if (b.errors.length) msg += ` · ⚠ ${b.errors[0]}`;
  P.flash(msg, b.errors.length ? "warn" : "msg");
}

// ---- Clipboard: ⌘C / ⌘X / ⌘V, shared with Finder via the system pasteboard ----
export async function setClip(P, cut) {
  const paths = P.selectedPaths(); if (!paths.length) return;
  app.clip = { paths, cut, cc: null };
  if (!paths.some(isRemote)) { try { app.clip.cc = await invoke("pasteboard_write", { paths }); } catch {} }
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
  if (!paths || !paths.length || !destDir || serverSoon(null, paths, destDir)) return;
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
  const sel = P.selectedPaths(); if (!sel.length || serverSoon(P, sel)) return;
  return createJob(P, "start_duplicate", { sources: sel }, `Duplicating ${plural(sel.length, "item")}`, (n) => `duplicate of ${plural(n, "item")}`, (n) => `Duplicated ${plural(n, "item")}`);
}

export function compressSel(P) {
  const sel = P.selectedPaths(); if (!sel.length || serverSoon(P, sel)) return;
  const label = sel.length === 1 ? `Compressing “${baseName(sel[0])}”` : `Compressing ${plural(sel.length, "item")}`;
  return createJob(P, "start_compress", { sources: sel }, label, () => "compress", (n) => (n ? "Created the archive" : "No archive created"));
}

export const ARCHIVE_RE = /\.(zip|tar|tgz|tbz2?|txz|7z|rar|xar|cpio|tar\.(gz|bz2|xz|zst))$/i;
export const isArchive = (e) => !e.is_dir && ARCHIVE_RE.test(e.name);

export function extractSel(P) {
  const archives = P.selectedEntries().filter(isArchive).map((e) => e.path);
  if (!archives.length || serverSoon(P, archives)) return;
  const label = archives.length === 1 ? `Extracting “${baseName(archives[0])}”` : `Extracting ${plural(archives.length, "archive")}`;
  return createJob(P, "start_extract", { archives }, label, (n) => `extract of ${plural(n, "archive")}`, (n) => `Extracted ${plural(n, "archive")}`);
}

export async function batchRename(P) {
  const entries = P.selectedEntries(); if (entries.length < 2 || serverSoon(P, P.cwd)) return;
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

/** Copy to / Move to: dest from the submenu, or (none) Fathom's folder browser. */
export async function pickAndTransfer(P, copy, dest = null) {
  const sel = P.selectedPaths(); if (!sel.length) return;
  if (!dest) {
    const { pickFolder } = await import("./picker.js");
    const dirs = P.selectedEntries().filter((e) => e.is_dir).map((e) => e.path);
    dest = await pickFolder({ start: recentDests()[0] || P.cwd, title: copy ? "Copy to…" : "Move to…", verb: copy ? "Copy" : "Move", exclude: dirs });
  }
  if (!dest) return;
  store.set("fathom-recent-dest", [dest, ...recentDests().filter((d) => d !== dest)].slice(0, 5));
  performTransfer(sel, dest, copy);
}
export const recentDests = () => store.get("fathom-recent-dest", []);

export const openTerminal = (P, path) => invoke("open_terminal", { path, app: prefs.terminal }).catch((e) => P.flash("⚠ " + e, "warn"));
