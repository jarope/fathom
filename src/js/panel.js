// Information panel (F11 / ⌘P, Dolphin's F11): a panel on the right of the
// window that follows the active pane.
//   One item:  picture (Quick Look thumbnail — images, PDFs, video, documents,
//              text — or the Finder icon), name, kind and size, dates, tags,
//              Spotlight facts (dimensions, duration, camera…), and for
//              folders the size on demand.
//   Several:   how many, size of the files, kinds; total size on demand.
//   Nothing:   the folder itself.
// Click the picture for Quick Look. Drag the left edge to resize.

import { app, invoke, store, el, fmtSize, fmtDate, plural, kindIcon, isFolder } from "./core.js";
import { kindLabel } from "./details.js";
import { thumbInto } from "./grid.js";
import { tagDots } from "./tags.js";
import { countSize, getInfo } from "./info.js";
import { quickLook } from "./system.js";

const W_MIN = 220, W_MAX = 560;
let panel, body, timer = 0, gen = 0, cancelCount = () => {};

export function initPanel() {
  panel = document.getElementById("infoPanel");
  body = panel.querySelector(".ip-body");
  const w = +store.get("fathom-panel-w", 300);
  panel.style.width = Math.min(W_MAX, Math.max(W_MIN, w)) + "px";
  document.getElementById("dockToggle").addEventListener("click", togglePanel);
  // Resize from the left edge.
  panel.querySelector(".ip-grip").addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    const x0 = ev.clientX, w0 = panel.offsetWidth;
    document.body.classList.add("col-resizing");
    const move = (e) => { panel.style.width = Math.min(W_MAX, Math.max(W_MIN, w0 + (x0 - e.clientX))) + "px"; };
    const up = () => {
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
      document.body.classList.remove("col-resizing");
      store.set("fathom-panel-w", panel.offsetWidth);
      app.tab && app.tab.panes.forEach((p) => p.resizeGrid && p.resizeGrid());
    };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  });
  showPanel();
}

export function togglePanel() {
  app.infoPanel = !app.infoPanel;
  store.set("fathom-dock", app.infoPanel);
  showPanel();
  app.tab && app.tab.panes.forEach((p) => p.resizeGrid && p.resizeGrid());
}

function showPanel() {
  if (!panel) return;
  panel.hidden = !app.infoPanel;
  document.getElementById("dockToggle").classList.toggle("on", app.infoPanel);
  if (app.infoPanel) refreshPanel(true);
  else { cancelCount(); cancelCount = () => {}; }
}

/** Selection or folder changed somewhere: redraw (briefly debounced). */
export function refreshPanel(now = false) {
  if (!panel || !app.infoPanel) return;
  clearTimeout(timer);
  if (now) draw(); else timer = setTimeout(draw, 60);
}

// ---------------------------------------------------------------- drawing
function facts() {
  const dl = el("dl", "ip-dl");
  const row = (k, v, cls) => { if (v == null || v === "") return null; const dd = el("dd", cls || null); if (v instanceof Node) dd.append(v); else dd.textContent = v; dl.append(el("dt", null, k), dd); return dd; };
  return { dl, row };
}

function sizeButton(paths, dd, label = "Calculate") {
  const b = el("button", "ip-calc", label); b.type = "button";
  b.addEventListener("click", async () => {
    b.disabled = true;
    const g = gen;
    cancelCount();
    cancelCount = await countSize(paths, (t) => { if (g === gen) dd.textContent = t.replace(/ \(.*?bytes?\)/, ""); });
  });
  dd.replaceChildren(b);
}

function header(e, title, sub) {
  const pic = el("div", "ip-pic");
  pic.append(kindIcon(e.name, e.is_dir));
  thumbInto(pic, e, 256);
  const h = el("div", "ip-head");
  h.append(pic, el("div", "ip-name", title), el("div", "ip-sub", sub));
  return { h, pic };
}

async function draw() {
  const g = ++gen;
  cancelCount(); cancelCount = () => {};
  const P = app.active;
  body.replaceChildren();
  if (!P || !P.cwd) { body.append(el("div", "ip-empty", "Nothing to show")); return; }
  const sel = P.selectedEntries();
  if (sel.length > 1) return drawMany(P, sel);
  const here = !sel.length;
  const e = here
    ? { path: P.cwd, name: P.cwd === "/" ? "Macintosh HD" : P.cwd.split("/").pop(), is_dir: true, tags: [] }
    : sel[0];
  const folder = isFolder(e);
  const { h, pic } = header(e, e.name, folder ? (here ? plural(P.base.length, "item") : "Folder") : `${kindLabel(e)} · ${fmtSize(e.size, false)}`);
  if (!folder) { pic.classList.add("ql"); pic.title = "Quick Look (Space)"; pic.addEventListener("click", () => quickLook(P)); }
  body.append(h);
  const td = tagDots(e.tags); if (td) { const t = el("div", "ip-tags"); t.append(td, document.createTextNode((e.tags || []).map((x) => x.name).join(", "))); body.append(t); }

  const f = facts();
  if (!here) f.row("Kind", kindLabel(e));
  const sizeDD = f.row("Size", folder ? " " : fmtSize(e.size, false));
  if (folder) sizeButton([e.path], sizeDD);
  if (P.mode !== "browse" || here) f.row("Where", (e.parent || e.path.replace(/\/[^/]+$/, "")) || "/", "mono");
  if (!here) {
    f.row("Modified", e.modified ? fmtDate(e.modified) : "");
    f.row("Created", e.created ? fmtDate(e.created) : "");
    f.row("Added", e.added ? fmtDate(e.added) : "");
  }
  body.append(f.dl);
  const more = el("dl", "ip-dl ip-more"); body.append(more);
  const actions = el("div", "ip-actions");
  const gi = el("button", "ip-btn", "Get Info…"); gi.type = "button"; gi.title = "⌘I";
  gi.addEventListener("click", () => getInfo(P));
  actions.append(gi);
  body.append(actions);

  // Spotlight facts (one quick lookup, after the selection settles).
  if (here || !invoke) return;
  await new Promise((r) => setTimeout(r, 120));
  if (g !== gen) return;
  let info;
  try { info = await invoke("file_info", { path: e.path }); } catch { return; }
  if (g !== gen) return;
  if (info.kind) body.querySelector(".ip-dl dd").textContent = info.kind;
  if (info.last_opened) { more.append(el("dt", null, "Last opened"), el("dd", null, fmtDate(Math.round(info.last_opened)))); }
  info.meta.filter(([k]) => k !== "Content type").forEach(([k, v]) => {
    more.append(el("dt", null, k), el("dd", k === "Where from" ? "mono wrap" : null, v));
  });
}

function drawMany(P, sel) {
  const dirs = sel.filter(isFolder), files = sel.filter((e) => !isFolder(e));
  const { h } = header(sel[0], plural(sel.length, "item"), [dirs.length && plural(dirs.length, "folder"), files.length && plural(files.length, "file")].filter(Boolean).join(", "));
  h.querySelector(".ip-pic").classList.add("stack");
  body.append(h);
  const f = facts();
  const sizeDD = f.row("Size", " ");
  const fileBytes = files.reduce((n, e) => n + (e.size || 0), 0);
  if (dirs.length) {
    sizeDD.replaceChildren(document.createTextNode(files.length ? `${fmtSize(fileBytes, false)} in files · ` : ""));
    const holder = el("span"); sizeDD.append(holder);
    sizeButton(sel.map((e) => e.path), holder, "Calculate total");
  } else sizeDD.textContent = fmtSize(fileBytes, false);
  const kinds = {}; sel.forEach((e) => { const k = kindLabel(e); kinds[k] = (kinds[k] || 0) + 1; });
  f.row("Kinds", Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${n} × ${k}`).join(", "));
  const times = sel.map((e) => e.modified).filter(Boolean).sort((a, b) => a - b);
  if (times.length) f.row("Modified", times[0] === times[times.length - 1] ? fmtDate(times[0]) : `${fmtDate(times[0])} – ${fmtDate(times[times.length - 1])}`);
  body.append(f.dl);
  const actions = el("div", "ip-actions");
  const gi = el("button", "ip-btn", "Get Info…"); gi.type = "button"; gi.addEventListener("click", () => getInfo(P));
  actions.append(gi); body.append(actions);
}
