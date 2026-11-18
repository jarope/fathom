// Fathom — boot. Wires the modules together and restores the last session.

import { app, invoke, store } from "./core.js";
import { initMenu } from "./menu.js";
import { initPreview, refreshDock } from "./preview.js";
import { initKeys } from "./keys.js";
import { initHeader } from "./view.js";
import { initTabs, openTab, renderTabs } from "./tabs.js";
import { initSidebar, loadPlaces, markActive } from "./sidebar.js";
import { initWatch, syncWatch } from "./watch.js";
import { saveSession, restoreSession } from "./session.js";
import { initJobs } from "./jobs.js";

app.showHidden = !!store.get("fathom-hidden", 0);
app.sidebar = store.get("fathom-sidebar", true) !== false;
app.dockPreview = !!store.get("fathom-dock", false);
app.folderShelf = store.get("fathom-shelf", true) !== false;

app.hooks.changed = (P) => { if (app.tab && P === app.tab.panes[0]) refreshDock(); };
app.hooks.navigated = () => { renderTabs(); markActive(); syncWatch(); saveSession(); };
app.hooks.save = saveSession;

initHeader();
initMenu();
initPreview();
initTabs();
initSidebar();
initKeys();
document.addEventListener("dragend", () => { app.dragData = null; });

(async () => {
  if (!invoke) {
    document.getElementById("panes").textContent = "Open Fathom through the app, not a browser.";
    return;
  }
  try { app.home = await invoke("home_dir"); } catch { app.home = "/"; }
  loadPlaces();
  await initWatch();
  await initJobs();
  if (!(await restoreSession())) await openTab(app.home);
  syncWatch();
})();
