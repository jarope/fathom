// Tabs (Dolphin / Finder style). Each tab owns two panes and its own
// single/twin layout; switching tabs swaps which panes are on screen. The
// tab bar only appears once there are two or more tabs.

import { app, el, icon, baseName } from "./core.js";
import { createPane } from "./pane.js";
import { refreshPanel } from "./panel.js";
import { registerDropZone } from "./dnd.js";
import { showMenu } from "./menu.js";
import { asButton } from "./a11y.js";

let seq = 0;
const panesEl = () => document.getElementById("panes");

export const visiblePanes = () => (!app.tab ? [] : app.tab.view === "twin" ? app.tab.panes.slice() : [app.tab.panes[0]]);
export const other = (P) => P.tab.panes.find((x) => x !== P);

export function setActive(P) {
  if (!P || P.tab !== app.tab) return;
  const changed = app.active !== P;
  app.active = P; app.tab.active = P;
  app.tab.panes.forEach((x) => x.root.classList.toggle("active", x === P));
  if (changed) { renderTabs(); app.hooks.navigated(P); }
}

/** Build a tab (not yet shown). specs: optional per-pane { sortKey, sortDir }. */
export function createTab({ view = "single", panes: specs = [] } = {}) {
  const tab = { id: ++seq, view, panes: [createPane("a"), createPane("b")], active: null };
  tab.panes.forEach((p, i) => {
    p.tab = tab;
    p.showHidden = app.showHidden;
    const s = specs[i];
    if (s) { p.sortKey = s.sortKey || "name"; p.sortDir = s.sortDir || 1; if (s.viewMode === "grid" || s.viewMode === "columns") p.viewMode = s.viewMode; }
  });
  tab.active = tab.panes[0];
  return tab;
}

/** New tab showing `path`, placed after the current one, and switched to. */
export async function openTab(path, { view = "single", background = false } = {}) {
  const tab = createTab({ view });
  const at = app.tab ? app.tabs.indexOf(app.tab) + 1 : app.tabs.length;
  app.tabs.splice(at, 0, tab);
  if (!background || !app.tab) switchTo(tab); else renderTabs();
  const ok = await tab.panes[0].navigate(path || app.home);
  if (!ok) await tab.panes[0].navigate(app.home);
  if (view === "twin") await tab.panes[1].navigate(tab.panes[0].cwd);
  renderTabs(); app.hooks.save();
  return tab;
}

export function switchTo(tab) {
  if (!tab) return;
  const wasCurrent = app.tab === tab;
  app.tab = tab;
  panesEl().replaceChildren(...tab.panes.map((p) => p.root));
  applyView();
  app.active = null; // force setActive to fire its hooks
  setActive(tab.active || tab.panes[0]);
  renderTabs();
  // Panes that were off-screen weren't watched — catch up on anything that changed.
  if (!wasCurrent) visiblePanes().forEach((p) => p.refresh());
  app.hooks.save();
}

export function closeTab(tab = app.tab) {
  if (app.tabs.length < 2) return false;
  const i = app.tabs.indexOf(tab);
  app.tabs.splice(i, 1);
  if (tab === app.tab) switchTo(app.tabs[Math.min(i, app.tabs.length - 1)]);
  else { renderTabs(); app.hooks.save(); }
  return true;
}

export function cycleTab(dir) {
  if (app.tabs.length < 2) return;
  const i = app.tabs.indexOf(app.tab);
  switchTo(app.tabs[(i + dir + app.tabs.length) % app.tabs.length]);
}
export function gotoTab(n) { // 1-based; 9 = last (browser convention)
  const t = n === 9 ? app.tabs[app.tabs.length - 1] : app.tabs[n - 1];
  if (t) switchTo(t);
}

// ---- single / twin layout (per tab) ----
export function setView(mode) {
  const tab = app.tab;
  tab.view = mode;
  applyView();
  if (mode === "twin" && !tab.panes[1].cwd) tab.panes[1].navigate(tab.panes[0].cwd || app.home);
  if (mode === "single") setActive(tab.panes[0]);
  app.hooks.navigated(app.active); // watch set + session follow the layout
}
function applyView() {
  const mode = app.tab.view;
  panesEl().classList.toggle("twin", mode === "twin");
  panesEl().classList.toggle("single", mode === "single");
  document.getElementById("viewSingle").classList.toggle("on", mode === "single");
  document.getElementById("viewTwin").classList.toggle("on", mode === "twin");
  refreshPanel();
}

// ---- tab bar ----
const tabTitle = (t) => {
  const p = t.active || t.panes[0];
  return p.cwd ? (p.cwd === app.home ? "Home" : baseName(p.cwd)) : "…";
};

export function renderTabs() {
  const bar = document.getElementById("tabbar");
  bar.classList.toggle("show", app.tabs.length > 1);
  if (app.tabs.length < 2) { bar.innerHTML = ""; return; }
  bar.innerHTML = "";
  app.tabs.forEach((t, i) => {
    const n = el("div", "tab" + (t === app.tab ? " on" : ""));
    n.dataset.i = i;
    n.title = (t.active || t.panes[0]).cwd || "";
    n.append(icon("folder"), el("span", "tname", tabTitle(t)));
    n.setAttribute("role", "tab"); n.setAttribute("aria-selected", t === app.tab ? "true" : "false");
    asButton(n, `Tab: ${tabTitle(t)}`);
    const x = el("button", "tclose"); x.type = "button"; x.title = "Close tab (⌘W)"; x.append(icon("close"));
    n.append(x);
    bar.append(n);
  });
  const add = el("button", "tabadd"); add.type = "button"; add.title = "New tab (⌘T)"; add.append(icon("plus"));
  bar.append(add);
}

export function initTabs() {
  const bar = document.getElementById("tabbar");
  const tabOf = (ev) => { const n = ev.target.closest(".tab"); return n ? app.tabs[+n.dataset.i] : null; };
  bar.addEventListener("click", (ev) => {
    if (ev.target.closest(".tabadd")) { openTab(app.active ? app.active.cwd : app.home); return; }
    const t = tabOf(ev); if (!t) return;
    if (ev.target.closest(".tclose")) closeTab(t); else switchTo(t);
  });
  bar.addEventListener("auxclick", (ev) => { if (ev.button === 1) { const t = tabOf(ev); if (t) closeTab(t); } });
  bar.addEventListener("dblclick", (ev) => { if (!ev.target.closest(".tab")) openTab(app.active ? app.active.cwd : app.home); });
  bar.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    const t = tabOf(ev); if (!t) return;
    showMenu([
      { label: "New Tab", fn: () => openTab((t.active || t.panes[0]).cwd), key: "⌘T" },
      { label: "Close Tab", fn: () => closeTab(t), key: "⌘W" },
      app.tabs.length > 1 && { label: "Close Other Tabs", fn: () => { app.tabs.filter((x) => x !== t).forEach((x) => closeTab(x)); switchTo(t); } },
    ], ev.clientX, ev.clientY);
  });

  // Drag files over a tab: it highlights; hold to spring it open; drop to move there.
  let spring = null, springTab = null;
  registerDropZone({
    root: bar,
    over: (n) => {
      const tn = n.closest(".tab"); if (!tn) return null;
      const t = app.tabs[+tn.dataset.i];
      if (t !== springTab) { clearTimeout(spring); springTab = t; spring = setTimeout(() => { if (t !== app.tab) switchTo(t); }, 750); }
      return { el: tn, dest: (t.active || t.panes[0]).cwd };
    },
    leave: () => { clearTimeout(spring); spring = null; springTab = null; },
  });
}

// ---- Open Location (⇧⌘R / ⌥⇧⌘R) ----
const parentOf = (p) => p.replace(/\/[^/]+$/, "") || "/";
/** True when an entry lives somewhere other than the folder P shows (search hits, tag views, expanded rows). */
export const elsewhere = (P, e) => P.mode !== "browse" || parentOf(e.path) !== P.cwd;
/** Go to the folder holding P's selected item and select it — here, or in the other pane (opening twin view). */
export async function openLocation(P, otherPane = false) {
  const e = P && P.selectedEntries()[0];
  if (!e) return;
  const dir = parentOf(e.path);
  let T = P;
  if (otherPane) {
    T = other(P);
    if (app.tab.view !== "twin") { if (!T.cwd) await T.navigate(dir); setView("twin"); }
    setActive(T);
  } else if (!elsewhere(P, e)) { P.selectPaths([e.path]); return; }
  if (await T.navigate(dir)) T.selectPaths([e.path]);
}
