// Session restore: tabs, each tab's layout, folders and sort order come back
// on next launch. (Window size/position is handled natively by the
// window-state plugin.)

import { app, store } from "./core.js";
import { createTab, switchTo } from "./tabs.js";

const KEY = "fathom-session";
let timer = null;

export function saveSession() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (!app.tabs.length) return;
    store.set(KEY, {
      cur: app.tabs.indexOf(app.tab),
      tabs: app.tabs.map((t) => ({
        view: t.view,
        active: Math.max(0, t.panes.indexOf(t.active)),
        panes: t.panes.map((p) => ({ cwd: p.cwd, sortKey: p.sortKey, sortDir: p.sortDir, viewMode: p.viewMode })),
      })),
    });
  }, 300);
}

/** Rebuild the saved tabs. Returns false if there was nothing usable to restore. */
export async function restoreSession() {
  const s = store.get(KEY, null);
  if (!s || !Array.isArray(s.tabs) || !s.tabs.length) return false;
  const specs = s.tabs.slice(0, 30);
  specs.forEach((spec) => app.tabs.push(createTab({ view: spec.view === "twin" ? "twin" : "single", panes: spec.panes || [] })));
  switchTo(app.tabs[Math.min(Math.max(0, s.cur | 0), app.tabs.length - 1)]);

  await Promise.all(app.tabs.map(async (tab, ti) => {
    const spec = specs[ti], ps = spec.panes || [];
    // A saved folder may be gone (renamed, unmounted) — fall back to Home.
    // Server folders reconnect only if no password is needed (else a Reconnect placeholder).
    const go = (P, cwd) => P.navigate(cwd, { quiet: true });
    if (!(ps[0] && ps[0].cwd && (await go(tab.panes[0], ps[0].cwd)))) await tab.panes[0].navigate(app.home);
    if (ps[1] && ps[1].cwd) { if (!(await go(tab.panes[1], ps[1].cwd)) && tab.view === "twin") await tab.panes[1].navigate(tab.panes[0].cwd); }
    else if (tab.view === "twin") await tab.panes[1].navigate(tab.panes[0].cwd);
    tab.active = tab.panes[spec.active === 1 && tab.view === "twin" ? 1 : 0];
  }));
  switchTo(app.tab); // re-apply the active pane now that folders are loaded
  return true;
}
