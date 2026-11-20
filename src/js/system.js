// macOS integration: Open With ▸, Share ▸ and real Quick Look on Space.

import { app, invoke, listen, dialog, el } from "./core.js";
import { getZoom } from "./view.js";
import { showPreviewFor } from "./preview.js";

// ---- Open With ----
const iconCache = new Map(); // app path -> data URI (or "" while unavailable)

async function appIcon(path) {
  if (!iconCache.has(path)) iconCache.set(path, invoke("file_icon", { path, size: 36 }).catch(() => ""));
  return iconCache.get(path);
}

const openWith = (P, paths, app) => invoke("open_with", { paths, app }).catch((e) => P.flash("⚠ " + e, "warn"));

/** Sub-menu entries for "Open With ▸" (built when the sub-menu opens). */
export async function openWithEntries(P, paths) {
  let apps = [];
  try { apps = await invoke("open_with_apps", { paths }); } catch {}
  const icons = await Promise.all(apps.map((a) => appIcon(a.path)));
  const items = apps.map((a, i) => ({ label: a.is_default ? `${a.name} (default)` : a.name, img: icons[i], fn: () => openWith(P, paths, a.path) }));
  if (items.length > 1) items.splice(1, 0, "sep");
  return [
    ...(items.length ? items : [{ label: "No suggested apps", disabled: true, fn: () => {} }]),
    "sep",
    { label: "Other…", fn: async () => {
      if (!dialog) return;
      const pick = await dialog.open({ title: "Open With", defaultPath: "/Applications", multiple: false, directory: false, filters: [{ name: "Applications", extensions: ["app"] }] });
      if (typeof pick === "string") openWith(P, paths, pick);
    } },
  ];
}

// ---- Share ----
/** The macOS share menu at CSS point (x, y). */
export function share(P, paths, x, y) {
  const z = getZoom();
  invoke("share", { paths, x: x * z, y: y * z }).catch((e) => P.flash("⚠ " + e, "warn"));
}

// ---- Quick Look ----
// Space toggles the real QLPreviewPanel. With several items selected it pages
// through them (← →); otherwise it follows the cursor as you move (↑ ↓ work
// from the panel too, and the selection moves with them).
function qlItems(P) {
  const sel = P.selectedEntries();
  const cur = P.cursor >= 0 ? P.entries[P.cursor] : null;
  if (sel.length > 1) {
    const paths = sel.map((e) => e.path);
    return { paths, index: Math.max(0, cur ? paths.indexOf(cur.path) : 0) };
  }
  const e = cur || sel[0];
  return e ? { paths: [e.path], index: 0 } : null;
}

export async function quickLook(P) {
  if (app.qlOpen) { closeQuickLook(); return; }
  const it = qlItems(P); if (!it) return;
  try {
    if (await invoke("quick_look", { ...it, open: true })) app.qlOpen = true;
  } catch {
    showPreviewFor(P); // no native Quick Look (e.g. the browser harness)
  }
}

export function closeQuickLook() {
  app.qlOpen = false;
  invoke("quick_look_close").catch(() => {});
}

/** Keep an open panel in step with the active pane's selection. */
export function qlFollow(P) {
  if (!app.qlOpen || P !== app.active) return;
  const it = qlItems(P); if (!it) return;
  invoke("quick_look", { ...it, open: false }).then((open) => { if (!open) app.qlOpen = false; }).catch(() => {});
}

export async function initSystem() {
  if (!listen) return;
  await listen("ql-nav", (e) => { const P = app.active; if (P) P.moveCursor(e.payload.dir); });
  await listen("ql-closed", () => { app.qlOpen = false; });
}

// ---- Full Disk Access ----
// Some folders (Mail, Messages, Safari, Time Machine, other users' Library…)
// are closed to every app until you allow it in System Settings. Say so,
// once per folder per session, with a button to the right page.
const fdaShown = new Set();
export async function fullDiskAccessHelp(path) {
  if (fdaShown.has(path)) return;
  fdaShown.add(path);
  const { modal } = await import("./dialog.js");
  const body = el("div");
  body.append(
    el("div", "modal-lead", `macOS keeps “${path.split("/").pop() || path}” private, so no app can look inside until you allow it.`),
    el("div", "modal-note", "To browse folders like this, turn on Fathom in System Settings › Privacy & Security › Full Disk Access, then quit and reopen Fathom. You only need to do this once."),
  );
  const go = await modal({ title: "Fathom needs Full Disk Access", body, buttons: [{ label: "Not Now", value: null }, { label: "Open Privacy Settings", value: true, primary: true }] });
  if (go) invoke("open_path", { path: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" }).catch(() => {});
}
