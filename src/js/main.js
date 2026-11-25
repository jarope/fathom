// Fathom — boot. Wires the modules together and restores the last session.

import { app, invoke, store } from "./core.js";
import { initMenu } from "./menu.js";
import { initPreview } from "./preview.js";
import { initPanel, refreshPanel } from "./panel.js";
import { initWheel } from "./wheel.js";
import { initUpdates } from "./updates.js";
import { applyShelfSize } from "./details.js";
import { initKeys } from "./keys.js";
import { initHeader, updateTitle, syncViewButtons } from "./view.js";
import { initTabs, openTab, renderTabs } from "./tabs.js";
import { initSidebar, loadPlaces, markActive, renderSidebar } from "./sidebar.js";
import { initWatch, syncWatch } from "./watch.js";
import { saveSession, restoreSession } from "./session.js";
import { initJobs } from "./jobs.js";
import { initDnd } from "./dnd.js";
import { initSystem, qlFollow } from "./system.js";
import { loadTags } from "./tags.js";
import { initSearch } from "./search.js";
import { initGit } from "./git.js";
import { loadSettings, prefs } from "./settings.js";
import { loadActions, initActions } from "./actions.js";
import { rebuildKeymap } from "./keys.js";
import { openPrefs } from "./prefs.js";
import { initAppearance } from "./appearance.js";
import { recordRecent } from "./network.js";
import { followPane, initTerminal } from "./terminal.js";

app.showHidden = !!store.get("fathom-hidden", 0);
app.sidebar = store.get("fathom-sidebar", true) !== false;
app.infoPanel = !!store.get("fathom-dock", false);
app.folderShelf = store.get("fathom-shelf", true) !== false;

app.hooks.changed = (P) => { if (P === app.active) refreshPanel(); qlFollow(P); };
app.hooks.navigated = (P) => { recordRecent(P); followPane(P); refreshPanel(); renderTabs(); markActive(); updateTitle(); syncViewButtons(); syncWatch(); saveSession(); };
app.hooks.viewMode = () => syncViewButtons();
app.hooks.save = saveSession;
app.hooks.expanded = () => syncWatch();
app.hooks.searchesChanged = () => renderSidebar();
app.hooks.actionsChanged = () => rebuildKeymap();

initHeader();
initMenu();
initPreview();
initPanel();
initWheel();
initTabs();
initSidebar();
import("./remote.js").then((m) => m.initRemote(() => renderSidebar()));
initKeys();

(async () => {
  if (!invoke) {
    document.getElementById("panes").textContent = "Open Fathom through the app, not a browser.";
    return;
  }
  try { app.home = await invoke("home_dir"); } catch { app.home = "/"; }
  try { app.version = await window.__TAURI__.app.getVersion(); } catch { app.version = ""; }
  await loadSettings();
  applyShelfSize();
  await initAppearance();
  rebuildKeymap(); // with any custom shortcuts
  document.getElementById("prefsBtn").addEventListener("click", () => openPrefs());
  loadPlaces();
  await initWatch();
  await initJobs();
  await initDnd();
  await initSystem();
  await initSearch();
  initGit();
  initUpdates();
  initTerminal();
  await initActions();
  loadActions();
  loadTags().then(() => app.sidebar && renderSidebar());
  const start = prefs.startup === "folder" ? prefs.startFolder || app.home : null;
  if (start) { await openTab(start); if (!app.active.cwd) await app.active.navigate(app.home); }
  else if (!(await restoreSession())) await openTab(app.home);
  syncWatch();
})();
