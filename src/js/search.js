// Search modes (names / Spotlight contents, this folder / whole Mac), the
// search-options menu on the 🔍 button, Spotlight result streaming, query
// help, and saved searches (shown in the sidebar).

import { app, invoke, listen, el, store } from "./core.js";
import { showMenu } from "./menu.js";
import { modal } from "./dialog.js";

// One setting for the whole window, remembered between launches.
export const searchMode = { contents: false, mac: false, ...store.get("fathom-search-mode", {}) };
const saveMode = () => store.set("fathom-search-mode", { contents: searchMode.contents, mac: searchMode.mac });

export const usesSpotlight = (m = searchMode) => m.contents || m.mac;

export function modeLabel(m = searchMode) {
  return [m.contents && "Contents", m.mac && "Mac"].filter(Boolean).join(" · ");
}
export function placeholder(m = searchMode) {
  if (m.contents) return m.mac ? "filter… ⏎ searches contents on this Mac" : "filter… ⏎ searches contents here (Spotlight)";
  return m.mac ? "filter… ⏎ finds names on this Mac" : "filter… ⏎ searches subfolders";
}

const syncPanes = () => app.tabs.forEach((t) => t.panes.forEach((p) => p.syncSearchMode && p.syncSearchMode()));

// ---- Saved searches ----
export let saved = store.get("fathom-searches", []);
const persist = () => { store.set("fathom-searches", saved); app.hooks.searchesChanged && app.hooks.searchesChanged(); };

export async function saveSearchDialog(P) {
  const query = P.els.search.value.trim(); if (!query) return;
  const body = el("div");
  body.append(el("div", "modal-lead", `Pin “${query}” to the sidebar${usesSpotlight() ? "" : ` (in ${P.cwd})`}.`));
  const input = el("input", "tag-input"); input.value = query.replace(/\b\w+:("[^"]*"|\S+)/g, "").trim() || query;
  body.append(input);
  const ok = await modal({ title: "Save Search", body, focus: input, buttons: [{ label: "Cancel", value: null }, { label: "Save", value: true, primary: true }] });
  if (!ok) return;
  saved.push({ name: input.value.trim() || query, query, contents: searchMode.contents, mac: searchMode.mac, root: searchMode.mac ? null : P.cwd });
  persist();
  P.flash("Saved — it's in the sidebar under Searches");
}

export function removeSaved(i) { saved.splice(i, 1); persist(); }

/** Run saved search `s` in pane P (going to its folder first if it has one). */
export async function runSaved(P, s) {
  Object.assign(searchMode, { contents: !!s.contents, mac: !!s.mac }); saveMode(); syncPanes();
  if (s.root && s.root !== P.cwd && !(await P.navigate(s.root).catch(() => false)) && P.cwd !== s.root) return;
  P.els.search.value = s.query;
  P.runSearch();
}

// ---- The 🔍 menu ----
export function searchMenu(P, x, y) {
  const set = (k, v) => { searchMode[k] = v; saveMode(); syncPanes(); P.els.search.focus(); };
  const q = P.els.search.value.trim();
  showMenu([
    { heading: "Match" },
    { label: "Names", on: !searchMode.contents, fn: () => set("contents", false) },
    { label: "Contents (Spotlight)", on: searchMode.contents, fn: () => set("contents", true) },
    { heading: "Where" },
    { label: "This folder and below", on: !searchMode.mac, fn: () => set("mac", false) },
    { label: "This Mac", on: searchMode.mac, fn: () => set("mac", true) },
    "sep",
    q && { label: "Save this search…", fn: () => saveSearchDialog(P) },
    { label: "Search tips…", fn: searchHelp },
  ], x, y);
}

export function searchHelp() {
  const body = el("div", "search-help");
  const rows = [
    ["invoice", "Words: names (or text inside files, in Contents mode)"],
    ['"tax return"', "Quote a phrase"],
    ["kind:pdf", "pdf · image · movie · audio · text · code · doc · sheet · slides · archive · folder · app — or any extension (kind:psd)"],
    ["modified:<7d", "Changed within 7 days (h, d, w, mo, y). modified:>1y = older than a year"],
    ["modified:today", "Changed today. Dates too: modified:>2025-01-31"],
    ["size:>100MB", "Bigger / smaller than (b, kb, mb, gb)"],
    ["tag:Red", "Has this Finder tag (tag:\"Project X\" for spaces)"],
  ];
  rows.forEach(([k, v]) => { const r = el("div", "sh-row"); r.append(el("code", null, k), el("span", null, v)); body.append(r); });
  body.append(el("div", "modal-note", "Combine freely: report kind:pdf modified:<30d · Names in this folder walks the disk (finds everything); Contents and This Mac use Spotlight (instant, indexed files only)."));
  modal({ title: "Search tips", body, wide: true, buttons: [{ label: "Done", value: true, primary: true }] });
}

// ---- Spotlight streaming ----
const panes = new Map(); // search id -> pane

export async function startSpotlight(P, query) {
  cancelSpotlight(P);
  const mode = { ...searchMode };
  let id;
  try { id = await invoke("spotlight_search", { query, root: mode.mac ? null : P.cwd, contents: mode.contents, showHidden: P.showHidden }); }
  catch (e) { P.flash("⚠ " + e, "warn"); return; }
  P.spotId = id; panes.set(id, P);
  P.showResults([], `Searching ${mode.mac ? "this Mac" : "here"}…`, true);
}

export function cancelSpotlight(P) {
  if (P.spotId == null) return;
  invoke("spotlight_cancel", { id: P.spotId }).catch(() => {});
  panes.delete(P.spotId); P.spotId = null;
}

export async function initSearch() {
  if (!listen) return;
  await listen("spotlight-batch", (e) => {
    const b = e.payload, P = panes.get(b.id);
    if (!P || P.spotId !== b.id) return;
    P.appendResults(b.entries);
    if (b.done) {
      panes.delete(b.id); P.spotId = null;
      if (b.error) { P.flash("⚠ " + b.error, "warn"); return; }
      P.finishResults(`Spotlight · ${(b.elapsed_ms / 1000).toFixed(1)} s${b.truncated ? " · showing the first 10,000" : ""}`);
    }
  });
}
