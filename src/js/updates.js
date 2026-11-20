// Updates: a quiet check once a day (Preferences → General → Updates can turn
// it off), a small card when there's a new version, and "Check Now".
// Installing downloads the signed build, verifies it, swaps it in and
// relaunches (see update.rs). Development builds never check.

import { app, invoke, listen, el, store } from "./core.js";
import { prefs } from "./settings.js";

const DAY = 24 * 3600 * 1000;
let card = null;

/** Ask GitHub for a newer version. manual = show the answer even when there's nothing. */
export async function checkForUpdates(manual = false) {
  if (!invoke) return { error: "No backend" };
  let found;
  try { found = await invoke("update_check"); }
  catch (e) { return { error: String(e) }; }
  store.set("fathom-update-checked", Date.now());
  if (!found) return { upToDate: true };
  if (!manual && store.get("fathom-update-skip", "") === found.version) return { skipped: found };
  showCard(found);
  return { found };
}

function showCard(u) {
  const host = document.getElementById("jobs");
  if (!host) return;
  if (card) card.remove();
  card = el("div", "job glass upd");
  const top = el("div", "job-top");
  top.append(el("div", "job-label", `Fathom ${u.version} is available`));
  const x = el("button", "job-x", "✕"); x.type = "button"; x.title = "Later";
  x.addEventListener("click", () => { card.remove(); card = null; syncHost(); });
  top.append(x);
  const sub = el("div", "upd-sub", `You have ${u.current}.`);
  const notes = u.notes ? el("div", "upd-notes", u.notes.slice(0, 600)) : null;
  const btns = el("div", "upd-btns");
  const skip = el("button", "mbtn small", "Skip This Version"); skip.type = "button";
  skip.addEventListener("click", () => { store.set("fathom-update-skip", u.version); card.remove(); card = null; syncHost(); });
  const go = el("button", "mbtn small primary", "Install & Relaunch"); go.type = "button";
  const bar = el("div", "job-bar"); bar.append(el("i")); bar.hidden = true;
  go.addEventListener("click", async () => {
    go.disabled = skip.disabled = true; go.textContent = "Downloading…"; bar.hidden = false;
    const off = listen ? await listen("update-progress", (e) => {
      const { done, total } = e.payload;
      if (total) bar.firstChild.style.width = Math.min(100, (done / total) * 100) + "%";
    }) : null;
    try { await invoke("update_install"); } // relaunches on success
    catch (e) { sub.textContent = "⚠ " + e; go.disabled = skip.disabled = false; go.textContent = "Try Again"; bar.hidden = true; }
    if (off) off();
  });
  btns.append(skip, go);
  card.append(top, sub, ...(notes ? [notes] : []), bar, btns);
  host.prepend(card);
  syncHost();
}
const syncHost = () => { const h = document.getElementById("jobs"); if (h) h.classList.toggle("show", h.childElementCount > 0); };

const RELEASES = "https://github.com/jarope/fathom/releases";

/** First launch after an update: a short "updated" card with a link to what's new. */
function announceUpdated() {
  const now = app.version, before = store.get("fathom-last-version", "");
  if (!now) return;
  store.set("fathom-last-version", now);
  // No version on record: a fresh install, or 0.27.2 and earlier (which didn't
  // record it). Those had the updater, so a past update check means "updated".
  if (before === now || (!before && !store.get("fathom-update-checked", 0))) return;
  const host = document.getElementById("jobs");
  if (!host) return;
  const c = el("div", "job glass upd");
  const close = () => { c.remove(); syncHost(); };
  const top = el("div", "job-top");
  const x = el("button", "job-x", "✕"); x.type = "button"; x.title = "Close";
  x.addEventListener("click", close);
  top.append(el("div", "job-label", `Fathom updated to ${now}`), x);
  const btns = el("div", "upd-btns");
  const notes = el("button", "mbtn small", "What's New"); notes.type = "button";
  notes.addEventListener("click", () => { invoke && invoke("open_path", { path: `${RELEASES}/tag/v${now}` }).catch(() => {}); close(); });
  btns.append(notes);
  c.append(top, ...(before ? [el("div", "upd-sub", `You were on ${before}.`)] : []), btns);
  host.prepend(c);
  syncHost();
  setTimeout(() => c.isConnected && close(), 20000);
}

/** On launch: say if Fathom was just updated, then check if it's been a day (and updates are on). */
export function initUpdates() {
  announceUpdated();
  if (prefs.autoUpdate === false) return;
  const last = +store.get("fathom-update-checked", 0);
  if (Date.now() - last < DAY) return;
  setTimeout(() => checkForUpdates(false), 8000); // not during start-up
}
