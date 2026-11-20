// The Bin as a place (sidebar → Bin): browse it, Put Back to where things
// came from (Fathom's record, or Finder's, so Finder deletions work too),
// Delete Immediately, Empty Bin. Opening it needs Full Disk Access — macOS
// protects ~/.Trash like Mail or Safari, and the usual help appears if not.

import { app, invoke, el, icon, plural, baseName } from "./core.js";
import { modal } from "./dialog.js";
import { pushUndo, refreshAll } from "./ops.js";

/** Is `dir` a Bin folder (the home Bin, or a volume's .Trashes/<uid>)? */
export const isBinDir = (dir) => !!dir && (dir === app.bin || /^\/Volumes\/[^/]+\/\.Trashes\/\d+$/.test(dir));
export const binLabel = (dir) => (dir === app.bin ? "Bin" : /\/\.Trashes\/\d+$/.test(dir || "") ? `Bin on ${dir.split("/")[2]}` : null);
const tidy = (p) => (app.home && p.startsWith(app.home + "/") ? "~" + p.slice(app.home.length) : p);
const parentOf = (p) => p.slice(0, p.lastIndexOf("/")) || "/";

/** Fetch where each item in P's Bin folder came from (null outside the Bin). */
export async function loadOrigins(P) {
  if (!isBinDir(P.cwd)) { P.binOrigins = null; return; }
  const dir = P.cwd;
  let o = {};
  try { o = await invoke("bin_origins", { dir }); } catch {}
  if (P.cwd === dir) { P.binOrigins = o; syncBinBar(P); }
}

/** The strip above the files while P is in the Bin. */
export function syncBinBar(P) {
  const on = isBinDir(P.cwd) && P.mode === "browse";
  let bar = P.root.querySelector(".binbar");
  if (!on) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = el("div", "binbar");
    bar.append(icon("bin"), el("span", "binmsg"));
    const back = el("button", "mbtn small", "Put Back"); back.type = "button"; back.className += " b-putback";
    back.addEventListener("click", () => putBack(P, P.selectedPaths()));
    const empty = el("button", "mbtn small danger", "Empty Bin…"); empty.type = "button";
    empty.addEventListener("click", () => emptyBin(P));
    bar.append(back, empty);
    P.els.listing.before(bar);
  }
  const sel = P.selectedPaths(), o = P.binOrigins || {};
  const msg = bar.querySelector(".binmsg");
  if (sel.length === 1) msg.textContent = o[sel[0]] ? `From ${tidy(parentOf(o[sel[0]]))}` : "Where this came from isn't recorded — drag it where you want it.";
  else if (sel.length > 1) msg.textContent = `${plural(sel.length, "item")} selected · ${sel.filter((p) => o[p]).length} can be put back`;
  else msg.textContent = P.entries.length ? `${plural(P.entries.length, "item")} · select something to see where it came from` : "The Bin is empty.";
  bar.querySelector(".b-putback").disabled = !sel.some((p) => o[p]);
  bar.querySelector(".danger").disabled = !P.entries.length;
}

/** Put items back where they came from. ⌘Z sends them to the Bin again. */
export async function putBack(P, paths) {
  const o = P.binOrigins || {};
  const pairs = paths.filter((p) => o[p]).map((p) => [p, o[p]]);
  const unknown = paths.length - pairs.length;
  if (!pairs.length) { P.flash("⚠ Where " + (paths.length > 1 ? "these" : "this") + " came from isn't recorded — drag to where you want it", "warn"); return; }
  let rep;
  try { rep = await invoke("move_exact_paths", { pairs }); } catch (e) { P.flash("⚠ " + e, "warn"); return; }
  if (rep.pairs.length) pushUndo({ kind: "move", pairs: rep.pairs, label: `Put Back of ${plural(rep.pairs.length, "item")}` });
  await refreshAll();
  let msg = `Put back ${plural(rep.done, "item")}`;
  if (rep.done === 1) msg += ` to ${tidy(parentOf(rep.pairs[0][1]))}`;
  if (unknown) msg += ` · ${unknown} with no record stayed`;
  if (rep.errors.length) msg += ` · ⚠ ${String(rep.errors[0]).replace(/^.*: /, "")}`;
  P.flash(msg, rep.errors.length || unknown ? "warn" : "msg");
}

/** Delete items in the Bin for good, after asking. */
export async function deleteNow(P, paths) {
  if (!paths.length) return;
  const what = paths.length === 1 ? `“${baseName(paths[0])}”` : plural(paths.length, "item");
  const ok = await modal({
    title: `Delete ${what} immediately?`,
    body: el("div", "modal-lead", "This can't be undone."),
    buttons: [{ label: "Cancel", value: false }, { label: "Delete", value: true, primary: true, danger: true }],
  });
  if (!ok) return;
  let r;
  try { r = await invoke("bin_delete", { paths }); } catch (e) { P.flash("⚠ " + e, "warn"); return; }
  await refreshAll();
  P.flash(`Deleted ${plural(r.count, "item")}${r.errors.length ? " · ⚠ " + r.errors[0] : ""}`, r.errors.length ? "warn" : "msg");
}

/** Empty every Bin (Finder does it, as from its own menu). */
export async function emptyBin(P) {
  const ok = await modal({
    title: "Empty the Bin?",
    body: el("div", "modal-lead", "Everything in the Bin is deleted for good. This can't be undone."),
    buttons: [{ label: "Cancel", value: false }, { label: "Empty Bin", value: true, primary: true, danger: true }],
  });
  if (!ok) return;
  try { await invoke("bin_empty"); } catch (e) { if (P) P.flash("⚠ " + e, "warn"); return; }
  await refreshAll();
  if (P) P.flash("Emptied the Bin");
}

/** Right-click menu for items in the Bin. */
export function binItemMenu(P, sel, { keyHint, quickLook, getInfo, destEntries, openWith }) {
  const o = P.binOrigins || {}, paths = sel.map((e) => e.path), one = sel.length === 1 ? sel[0] : null;
  return [
    { heading: one ? (o[one.path] ? `From ${tidy(parentOf(o[one.path]))}` : "Origin not recorded") : plural(sel.length, "item") },
    { label: "Put Back", fn: () => putBack(P, paths), disabled: !paths.some((p) => o[p]) },
    "sep",
    one && { label: "Open", fn: () => P.activate(P.entries.indexOf(one)), key: "⏎" },
    { label: "Open With", sub: () => openWith(P, paths) },
    { label: "Quick Look", fn: () => quickLook(P), key: keyHint("quickLook") },
    { label: "Get Info", fn: () => getInfo(P), key: keyHint("getInfo") },
    "sep",
    { label: "Move to", sub: () => destEntries(P, false) },
    { label: "Copy to", sub: () => destEntries(P, true) },
    { label: paths.length > 1 ? "Copy paths" : "Copy path", fn: () => { navigator.clipboard.writeText(paths.join("\n")); P.flash("Copied"); } },
    "sep",
    { label: "Delete Immediately…", fn: () => deleteNow(P, paths), danger: true, key: keyHint("trash") },
  ];
}
