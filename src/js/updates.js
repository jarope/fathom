// Updates: a quiet check once a day (Preferences → General → Updates can turn
// it off), a small card when there's a new version, and "Check Now".
// Installing downloads the signed build, verifies it, swaps it in and
// relaunches (see update.rs). Development builds never check.

import { invoke, listen, el, store } from "./core.js";
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

/** On launch: check if it's been a day (and updates are on). */
export function initUpdates() {
  if (prefs.autoUpdate === false) return;
  const last = +store.get("fathom-update-checked", 0);
  if (Date.now() - last < DAY) return;
  setTimeout(() => checkForUpdates(false), 8000); // not during start-up
}
