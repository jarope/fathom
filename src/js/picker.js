// "Other Folder…" for Copy to / Move to: a small folder browser inside
// Fathom (instead of the macOS open panel, which looks like a Finder window).
//   click = choose that sub-folder · double-click / → = go into it
//   ← or ⌘↑ = up · type a path in the box and ⏎ to jump · ⏎ = the button

import { app, invoke, el, icon, baseName } from "./core.js";
import { modal } from "./dialog.js";

/** Resolves with the chosen folder path, or null. */
export function pickFolder({ start, title, verb, exclude = [] }) {
  let cwd = start || app.home, dirs = [], cur = -1;
  const body = el("div", "picker");
  const path = el("input", "picker-path"); path.spellcheck = false; path.autocomplete = "off";
  const up = el("button", "nb picker-up"); up.type = "button"; up.title = "Enclosing folder (⌘↑)"; up.append(icon("up"));
  const top = el("div", "picker-top"); top.append(up, path);
  const list = el("div", "picker-list"); list.tabIndex = 0;
  const note = el("div", "picker-note");
  body.append(top, list, note);

  const target = () => (cur >= 0 ? dirs[cur].path : cwd);
  const bad = (p) => exclude.some((x) => p === x || p.startsWith(x + "/"));
  const sync = () => {
    list.querySelectorAll(".picker-row").forEach((r, i) => r.classList.toggle("sel", i === cur));
    const t = target();
    note.textContent = bad(t) ? "Can't put a folder inside itself." : `${verb} into “${t === "/" ? "Macintosh HD" : baseName(t)}”`;
    if (modal.setEnabled) modal.setEnabled(!bad(t));
  };
  async function go(p) {
    let l;
    try { l = await invoke("list_dir", { path: p, showHidden: app.showHidden }); }
    catch (e) { note.textContent = "⚠ " + e; return; }
    cwd = l.dir; path.value = cwd; cur = -1;
    dirs = l.entries.filter((e) => e.is_dir && !/\.(app|bundle|framework|pkg|photoslibrary)$/i.test(e.name));
    list.replaceChildren(...dirs.map((d, i) => {
      const r = el("div", "picker-row"); r.append(icon("folder"), el("span", "nm", d.name));
      r.addEventListener("click", () => { cur = cur === i ? -1 : i; sync(); });
      r.addEventListener("dblclick", () => go(d.path));
      return r;
    }));
    if (!dirs.length) list.append(el("div", "picker-empty", "No sub-folders"));
    up.disabled = !l.parent;
    up.onclick = () => l.parent && go(l.parent);
    list.scrollTop = 0;
    sync();
  }
  path.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault(); e.stopPropagation();
    let v = path.value.trim();
    if (v === "~" || v.startsWith("~/")) v = app.home + v.slice(1);
    if (v) go(v);
  });
  list.addEventListener("keydown", (e) => {
    const n = dirs.length;
    if (e.key === "ArrowDown" && n) { e.preventDefault(); cur = Math.min(n - 1, cur + 1); sync(); list.children[cur].scrollIntoView({ block: "nearest" }); }
    else if (e.key === "ArrowUp" && n) { e.preventDefault(); if (e.metaKey) up.click(); else { cur = Math.max(0, cur - 1); sync(); list.children[cur].scrollIntoView({ block: "nearest" }); } }
    else if (e.key === "ArrowRight" && cur >= 0) { e.preventDefault(); go(dirs[cur].path); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); up.click(); }
  });
  go(cwd);
  setTimeout(() => list.focus(), 0);
  return modal({
    title, body, wide: true, enterSubmits: false, focus: list,
    buttons: [{ label: "Cancel", value: null }, { label: verb + " Here", value: "ok", primary: true }],
  }).then((v) => (v ? target() : null));
}
