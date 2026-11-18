// Fathom — boot. Wires the modules together and restores the last session.

import { app, invoke, store } from "./core.js";
import { initMenu } from "./menu.js";
import { initPreview, refreshDock } from "./preview.js";
import { initKeys } from "./keys.js";
import { initHeader } from "./view.js";
import { initTabs, openTab, renderTabs } from "./tabs.js";
import { initSidebar, loadPlaces, markActive, renderSidebar } from "./sidebar.js";
import { initWatch, syncWatch } from "./watch.js";
import { saveSession, restoreSession } from "./session.js";
import { initJobs } from "./jobs.js";
import { initDnd } from "./dnd.js";
import { initSystem, qlFollow } from "./system.js";
import { loadTags } from "./tags.js";

app.showHidden = !!store.get("fathom-hidden", 0);
app.sidebar = store.get("fathom-sidebar", true) !== false;
app.dockPreview = !!store.get("fathom-dock", false);
app.folderShelf = store.get("fathom-shelf", true) !== false;

app.hooks.changed = (P) => { if (app.tab && P === app.tab.panes[0]) refreshDock(); qlFollow(P); };
app.hooks.navigated = () => { renderTabs(); markActive(); syncWatch(); saveSession(); };
app.hooks.save = saveSession;

initHeader();
initMenu();
initPreview();
initTabs();
initSidebar();
initKeys();

(async () => {
  if (!invoke) {
    document.getElementById("panes").textContent = "Open Fathom through the app, not a browser.";
    return;
  }
  try { app.home = await invoke("home_dir"); } catch { app.home = "/"; }
  loadPlaces();
  await initWatch();
  await initJobs();
  await initDnd();
  await initSystem();
  loadTags().then(() => app.sidebar && renderSidebar());
  if (!(await restoreSession())) await openTab(app.home);
  syncWatch();
})();
