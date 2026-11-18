// Finder tags: dots on rows, the colour row in the right-click menu,
// ⌃⌘1–7 / ⌃⌘0, the "Tags…" editor, and listing everything with a tag.

import { app, invoke, el, plural } from "./core.js";
import { refreshAll } from "./ops.js";
import { modal } from "./dialog.js";

/** Favourite tags (Finder's sidebar list): [{ name, color }]. */
export let favourites = [
  { name: "Red", color: 6 }, { name: "Orange", color: 7 }, { name: "Yellow", color: 5 }, { name: "Green", color: 2 },
  { name: "Blue", color: 4 }, { name: "Purple", color: 3 }, { name: "Grey", color: 1 },
];

export async function loadTags() {
  try { const t = await invoke("tag_list"); if (t && t.length) favourites = t; } catch {}
  return favourites;
}

/** Little overlapping dots for an entry's tags (null when untagged). */
export function tagDots(tags) {
  if (!tags || !tags.length) return null;
  const s = el("span", "tags");
  s.title = tags.map((t) => t.name).join(", ");
  tags.slice(0, 4).forEach((t) => s.append(el("i", `tg tc${t.color || 0}`)));
  return s;
}

const has = (e, name) => (e.tags || []).some((t) => t.name.toLowerCase() === name.toLowerCase());

async function setTags(P, paths, change, msg) {
  try { await invoke("set_tags", { paths, add: [], remove: [], clear: false, ...change }); }
  catch (e) { P.flash("⚠ " + e, "warn"); return; }
  await refreshAll();
  P.selectPaths(paths);
  if (msg) P.flash(msg);
}

/** Toggle `name` on the selection: removed if every item has it, else added to all. */
export function toggleTag(P, name) {
  const sel = P.selectedEntries(); if (!sel.length) return;
  const all = sel.every((e) => has(e, name));
  setTags(P, sel.map((e) => e.path), all ? { remove: [name] } : { add: [name] },
    `${all ? "Removed" : "Tagged"} ${plural(sel.length, "item")} ${all ? "from" : "with"} “${name}”`);
}

export function clearTags(P) {
  const sel = P.selectedEntries(); if (!sel.length) return;
  setTags(P, sel.map((e) => e.path), { clear: true }, `Cleared tags on ${plural(sel.length, "item")}`);
}

/** Add tag `name` to `paths` (files dropped on a sidebar tag). */
export const tagPaths = (P, paths, name) => setTags(P, paths, { add: [name] }, `Tagged ${plural(paths.length, "item")} with “${name}”`);

/** ⌃⌘1–7: the Nth favourite tag. */
export const toggleNth = (P, n) => favourites[n - 1] && toggleTag(P, favourites[n - 1].name);

/** The colour-dot row for the right-click menu. */
export function menuTagRow(P, hide) {
  const sel = P.selectedEntries();
  const row = el("div", "ctx-tags");
  favourites.slice(0, 9).forEach((t, i) => {
    const d = el("span", `tg-pick tc${t.color || 0}` + (sel.length && sel.every((e) => has(e, t.name)) ? " on" : ""));
    d.title = `${t.name}${i < 7 ? `  ⌃⌘${i + 1}` : ""}`;
    d.addEventListener("click", (ev) => { ev.stopPropagation(); hide(); toggleTag(P, t.name); });
    row.append(d);
  });
  return row;
}

/** "Tags…": edit the selection's tags as text, with the favourites as chips. */
export async function editTagsDialog(P) {
  const sel = P.selectedEntries(); if (!sel.length) return;
  const common = (sel[0].tags || []).map((t) => t.name).filter((n) => sel.every((e) => has(e, n)));
  const body = el("div");
  body.append(el("div", "modal-lead", sel.length === 1 ? `Tags for “${sel[0].name}”, separated by commas.` : `Tags shared by ${plural(sel.length, "item")}, separated by commas. Other tags they have are kept.`));
  const input = el("input", "tag-input"); input.value = common.join(", "); input.spellcheck = false;
  const chips = el("div", "tag-chips");
  favourites.forEach((t) => {
    const c = el("button", "tag-chip"); c.type = "button";
    c.append(el("i", `tg tc${t.color || 0}`), document.createTextNode(t.name));
    c.addEventListener("click", () => {
      const cur = input.value.split(",").map((x) => x.trim()).filter(Boolean);
      const i = cur.findIndex((x) => x.toLowerCase() === t.name.toLowerCase());
      if (i >= 0) cur.splice(i, 1); else cur.push(t.name);
      input.value = cur.join(", "); input.focus();
    });
    chips.append(c);
  });
  body.append(input, chips);
  const ok = await modal({ title: "Tags", body, focus: input, buttons: [{ label: "Cancel", value: null }, { label: "Save", value: true, primary: true }] });
  if (!ok) return;
  const want = [...new Set(input.value.split(",").map((x) => x.trim()).filter(Boolean))];
  const remove = common.filter((n) => !want.some((w) => w.toLowerCase() === n.toLowerCase()));
  setTags(P, sel.map((e) => e.path), { add: want, remove }, `Updated tags on ${plural(sel.length, "item")}`);
}

/** Show every file tagged `name` (via Spotlight) in pane P, like a search. */
export async function showTagged(P, name) {
  P.flash(`Finding “${name}”…`);
  try {
    const paths = await invoke("tag_search", { name });
    const entries = await invoke("entries_for", { paths, showHidden: P.showHidden });
    P.showResults(entries, `tagged “${name}”`);
  } catch (e) { P.flash("⚠ " + e, "warn"); }
}
