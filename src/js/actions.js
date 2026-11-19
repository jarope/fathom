// User actions (Dolphin's service menus): shell commands in the right-click
// menu, kept in ~/.config/fathom/actions.json and editable in Preferences.
//
// { name, command, on: "any"|"files"|"folders"|"here", ext: ["png", …],
//   multi: true, run: "background"|"terminal", output: false, menu: "git" }
// menu "git" puts it in the Git menu (shown only inside a repo) instead of Actions.
// %f first item · %F all items · %d this folder · %n first item's name · %% a %

import { app, invoke, listen, el, plural } from "./core.js";
import { modal } from "./dialog.js";
import { busyCard } from "./jobs.js";
import { refreshAll } from "./ops.js";
import { prefs } from "./settings.js";

export const EXAMPLES = [
  { name: "Open in VS Code", command: 'open -a "Visual Studio Code" %F', on: "any" },
  { name: "Convert to JPEG", command: 'for f in %F; do sips -s format jpeg "$f" --out "${f%.*}.jpg" >/dev/null; done', on: "files", ext: ["png", "heic", "tiff", "tif", "webp", "bmp", "gif"] },
  { name: "SHA-256 checksum", command: "shasum -a 256 %F", on: "files", output: true },
  { name: "Folder size", command: "du -sh %F", on: "folders", output: true },
  { name: "Make executable", command: "chmod +x %F", on: "files" },
  { name: "Git log here", command: "git log --oneline --graph -30", on: "here", run: "terminal", menu: "git" },
];

const HELP = "Fathom user actions. Each: name, command (zsh; %f first item, %F all items, %d this folder, %n first item's name, %% a literal %), "
  + "on (any | files | folders | here = the folder itself, from the empty-space menu), ext (optional extensions), multi (allow several items, default true), "
  + "run (background | terminal), output (show what it printed), menu (\"git\" = in the Git menu, only inside a repo). Edit here or in Fathom → Preferences → Actions.";
const FILE_VERSION = 2; // 2: "menu" added

export let actions = [];
export let actionsProblem = null;

const clean = (a) => {
  const o = { name: String(a.name || "").trim(), command: String(a.command || "") };
  o.on = ["files", "folders", "here"].includes(a.on) ? a.on : "any";
  const ext = (Array.isArray(a.ext) ? a.ext : String(a.ext || "").split(/[\s,]+/)).map((x) => String(x).replace(/^\./, "").toLowerCase()).filter(Boolean);
  if (ext.length) o.ext = ext;
  if (a.multi === false) o.multi = false;
  if (a.run === "terminal") o.run = "terminal";
  if (a.output) o.output = true;
  if (a.menu === "git") o.menu = "git";
  return o;
};

export async function loadActions() {
  if (!invoke) return actions;
  actionsProblem = null;
  try {
    const text = await invoke("config_read", { name: "actions.json" });
    if (text == null) { actions = EXAMPLES.map(clean); await saveActions(); } // first run: ship the examples
    else {
      const j = JSON.parse(text);
      actions = (Array.isArray(j) ? j : j.actions || []).map(clean).filter((a) => a.name && a.command);
      if (!(j.version >= 2)) { // one-off: the shipped "Git log here" moves to the Git menu
        actions.forEach((a) => { if (a.name === "Git log here" && /^\s*git\s/.test(a.command)) a.menu = "git"; });
        await saveActions();
      }
    }
  } catch (e) {
    actionsProblem = `actions.json couldn't be read (${e}). Fix the file, or save from Preferences to rewrite it.`;
  }
  app.hooks.actionsChanged && app.hooks.actionsChanged();
  return actions;
}

export async function saveActions(list = actions) {
  actions = list.map(clean).filter((a) => a.name);
  actionsProblem = null;
  await invoke("config_write", { name: "actions.json", text: JSON.stringify({ _help: HELP, version: FILE_VERSION, actions }, null, 2) + "\n" });
  app.hooks.actionsChanged && app.hooks.actionsChanged();
}

const extOf = (name) => { const i = name.lastIndexOf("."); return i > 0 ? name.slice(i + 1).toLowerCase() : ""; };

/** Does action `a` apply to these entries? ([] = the folder itself, from the empty-space menu.) */
export function applies(a, sel) {
  if (!sel.length) return a.on === "here";
  if (a.on === "here") return false;
  if (a.multi === false && sel.length > 1) return false;
  return sel.every((e) => {
    if (a.on === "files" && e.is_dir) return false;
    if (a.on === "folders" && !e.is_dir) return false;
    if (a.ext && (e.is_dir || !a.ext.includes(extOf(e.name)))) return false;
    return true;
  });
}

/** Entries for the actions in `menu` ("actions" | "git") that fit the selection,
 * then a "This folder" group of folder actions (so they're reachable even when
 * rows fill the listing and there's no empty space to right-click). */
export function menuActions(P, sel, menu = "actions") {
  const mine = actions.filter((a) => (a.menu || "actions") === menu);
  const item = (a, paths) => ({ label: a.name + (a.run === "terminal" ? "  ↗" : ""), fn: () => runAction(P, a, paths) });
  const out = mine.filter((a) => applies(a, sel)).map((a) => item(a, sel.map((e) => e.path)));
  const here = sel.length ? mine.filter((a) => a.on === "here") : [];
  if (here.length) {
    if (out.length) out.push("sep");
    out.push({ heading: "This folder" }, ...here.map((a) => item(a, [])));
  }
  return out;
}

/** The Actions ▸ submenu (with an "Edit Actions…" footer). */
export function actionEntries(P, sel, editFn) {
  const out = menuActions(P, sel);
  return [
    ...(out.length ? out : [{ label: "No actions for this", disabled: true, fn: () => {} }]),
    "sep",
    { label: "Edit Actions…", fn: editFn },
  ];
}

/** Run from a shortcut: on the selection, or the folder when nothing is selected. */
export function runOnSelection(P, a) {
  const sel = P.selectedEntries();
  if (!applies(a, sel)) { P.flash(`“${a.name}” doesn't apply to ${sel.length ? "this selection" : "the folder"}`, "warn"); return; }
  runAction(P, a, sel.map((e) => e.path));
}

// ---- Running ----
const waiting = new Map(), early = new Map();

export async function initActions() {
  if (!listen) return;
  await listen("action-done", (e) => {
    const w = waiting.get(e.payload.id);
    if (w) { waiting.delete(e.payload.id); w(e.payload); } else early.set(e.payload.id, e.payload);
  });
}

export async function runAction(P, a, paths) {
  if (!P.cwd) return;
  const terminal = a.run === "terminal" ? prefs.terminal : null;
  let id;
  try { id = await invoke("run_action", { command: a.command, dir: P.cwd, paths, terminal }); }
  catch (e) { P.flash("⚠ " + e, "warn"); return; }
  if (terminal) { P.flash(`“${a.name}” opened in ${terminal}`); return; }

  const done = new Promise((res) => { if (early.has(id)) { res(early.get(id)); early.delete(id); } else waiting.set(id, res); });
  let close = null;
  const t = setTimeout(() => { close = busyCard(a.name, paths.length ? plural(paths.length, "item") : P.cwd, () => invoke("cancel_action", { id })); }, 300);
  const r = await done;
  clearTimeout(t); if (close) close();
  await refreshAll(); // the action may have made or changed files
  if (r.cancelled) { P.flash(`Cancelled “${a.name}”`); return; }
  const ok = r.code === 0;
  if (!ok || (a.output && r.output)) {
    const body = el("div");
    body.append(el("div", "modal-lead", ok ? `“${a.name}” printed:` : `“${a.name}” failed (exit ${r.code ?? "killed"}).`), el("pre", "gc-out", r.output || "(no output)"));
    const b = [{ label: "OK", value: true, primary: true }];
    if (r.output) b.unshift({ label: "Copy", value: "copy" });
    const v = await modal({ title: a.name, body, wide: true, buttons: b });
    if (v === "copy") navigator.clipboard.writeText(r.output);
  } else P.flash(`✓ ${a.name}`);
}
