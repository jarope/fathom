// Folders panel (Dolphin's F7): the sidebar shows a folder tree instead of
// Places. It's rooted where you are (Home, the volume you're on, or the
// disk), opens itself down to the current folder, loads sub-folders as you
// open them, and takes drops like any folder.

import { app, invoke, el, icon, store, baseName } from "./core.js";
import { openTab } from "./tabs.js";

const open = new Set(store.get("fathom-tree-open", []));   // folders opened by hand
const kids = new Map();                                       // path -> [sub-folder paths] | null (unreadable)
let seq = 0, lastRoot = "", loading = new Set();

const saveOpen = () => store.set("fathom-tree-open", [...open].slice(-300));

/** Where the tree starts for folder `cwd`. */
export function treeRoot(cwd) {
  if (!cwd) return app.home || "/";
  const vol = /^\/Volumes\/[^/]+/.exec(cwd);
  if (vol) return vol[0];
  if (app.home && (cwd === app.home || cwd.startsWith(app.home + "/"))) return app.home;
  return "/";
}
const rootName = (r) => (r === "/" ? "Macintosh HD" : r === app.home ? "Home" : baseName(r));

async function loadKids(dir) {
  if (kids.has(dir) || loading.has(dir)) return;
  loading.add(dir);
  try {
    const l = await invoke("list_dir", { path: dir, showHidden: app.showHidden });
    kids.set(dir, l.entries.filter((e) => e.is_dir && !/\.(app|bundle|framework|photoslibrary)$/i.test(e.name)).map((e) => e.path));
  } catch { kids.set(dir, null); }
  loading.delete(dir);
}

/** Forget cached sub-folders (after file changes or toggling hidden files). */
export function invalidateTree(dir) { if (dir) kids.delete(dir); else kids.clear(); }

/** Draw the tree into `box` (the sidebar), opened down to the active folder. */
export async function renderTree(box) {
  const my = ++seq;
  const cwd = app.active && app.active.cwd;
  const root = treeRoot(cwd);
  // The chain from the root to the current folder is always open.
  const chain = [];
  if (cwd && cwd.startsWith(root)) {
    let p = cwd;
    while (p && p !== root && p.length > root.length) { chain.unshift(p); p = p.slice(0, p.lastIndexOf("/")) || "/"; }
  }
  const under = (p) => root === "/" || p.startsWith(root + "/");
  await Promise.all([root, ...chain, ...[...open].filter(under)].map(loadKids));
  if (my !== seq) return; // a newer draw started meanwhile
  // Open: the root, the folders above the current one, and any you opened.
  const isOpen = (p) => p === root || (chain.includes(p) && p !== cwd) || open.has(p);
  const tree = el("div", "ftree"); tree.setAttribute("role", "tree");
  const node = (p, depth, label) => {
    // Also a .place, so it shares the sidebar's click, right-click and drop handling.
    const n = el("div", "place tnode" + (p === cwd ? " on" : ""));
    n.dataset.path = p; n.dataset.kind = "std"; n.title = p;
    n.style.paddingLeft = 6 + depth * 14 + "px";
    n.setAttribute("role", "treeitem");
    const list = kids.get(p);
    const opened = isOpen(p) && list !== undefined;
    const tw = el("span", "twist" + (list && !list.length ? " none" : "") + (opened ? " open" : ""), "›");
    n.append(tw, icon(p === app.home ? "home" : depth === 0 && p !== "/" && p.startsWith("/Volumes/") ? "drive" : "folder"), el("span", "pname", label || baseName(p)));
    n.setAttribute("aria-expanded", opened ? "true" : "false");
    n.tabIndex = p === cwd ? 0 : -1;
    tree.append(n);
    if (opened && list) list.forEach((c) => node(c, depth + 1));
  };
  node(root, 0, rootName(root));
  box.querySelectorAll(".ftree").forEach((t) => t.remove());
  box.append(tree);
  if (lastRoot !== root || cwd) { const on = tree.querySelector(".tnode.on"); if (on) on.scrollIntoView({ block: "nearest" }); }
  lastRoot = root;
}

/** Clicks inside the tree: the triangle opens / closes, the name goes there. */
export function treeClick(ev, rerender) {
  const n = ev.target.closest(".tnode"); if (!n) return false;
  const p = n.dataset.path;
  if (ev.target.closest(".twist")) {
    if (n.getAttribute("aria-expanded") === "true") { open.delete(p); n.querySelector(".twist").classList.remove("open"); }
    else open.add(p);
    saveOpen(); rerender();
    return true;
  }
  if (ev.metaKey) openTab(p);
  else if (app.active) { if (p !== treeRoot(p)) { open.add(p); saveOpen(); } app.active.navigate(p); }
  return true;
}

/** ← → ↑ ↓ ⏎ in the tree. */
export function treeKey(ev, rerender) {
  const n = ev.target.closest && ev.target.closest(".tnode"); if (!n) return false;
  const all = [...n.parentNode.querySelectorAll(".tnode")], i = all.indexOf(n), p = n.dataset.path;
  const focus = (m) => { if (!m) return; all.forEach((x) => (x.tabIndex = -1)); m.tabIndex = 0; m.focus(); };
  if (ev.key === "ArrowDown") focus(all[i + 1]);
  else if (ev.key === "ArrowUp") focus(all[i - 1]);
  else if (ev.key === "ArrowRight") { if (n.getAttribute("aria-expanded") !== "true") { open.add(p); saveOpen(); rerender(p); } else focus(all[i + 1]); }
  else if (ev.key === "ArrowLeft") { if (n.getAttribute("aria-expanded") === "true" && i > 0) { open.delete(p); saveOpen(); rerender(p); } else focus(all.slice(0, i).reverse().find((m) => p.startsWith(m.dataset.path === "/" ? "/" : m.dataset.path + "/"))); }
  else if (ev.key === "Enter" || ev.key === " ") { if (app.active) app.active.navigate(p); }
  else return false;
  ev.preventDefault(); ev.stopPropagation();
  return true;
}
