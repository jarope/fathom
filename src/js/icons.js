// Real Finder icons for list rows (Details, Columns, the drag ghost).
//
// fileIcon(e) returns at once: the cached Finder icon when we have it,
// otherwise the kind glyph, which is swapped for the real icon when it
// arrives. Requests are batched (one backend call per paint) and cached:
// files by type ("ext:png"), folders / apps / packages / links by path, since
// those can have their own icons (Downloads, Applications, custom icons).
// Identical images share one string, so 5,000 plain folders cost one icon.
//
// Preferences → "Finder icons in lists" turns it off (glyphs only).

import { isRemote } from "./loc.js";
import { invoke, el, kindIcon } from "./core.js";
import { prefs } from "./settings.js";

const MAX = 4000;
const cache = new Map();   // key -> data URL ("" = macOS had none)
const pool = new Map();    // data URL -> same string (interning)
const waiting = new Map(); // key -> [glyph elements]
let queued = false;

export function iconKey(e) {
  // On a server there's no file to ask about: folders get the plain folder icon.
  if (isRemote(e.path)) { if (e.is_dir) return "ext:public.folder"; }
  else if (e.is_dir || e.is_symlink) return "path:" + e.path;
  const m = /\.([^./]+)$/.exec(e.name);
  return "ext:" + (m ? m[1].toLowerCase() : "");
}

function img(url) {
  const i = el("img", "ki fi");
  i.src = url; i.alt = ""; i.draggable = false;
  return i;
}

function flush() {
  queued = false;
  const keys = [...waiting.keys()].filter((k) => !cache.has(k));
  if (!keys.length) { waiting.clear(); return; }
  const scale = Math.min(3, Math.max(2, Math.ceil(window.devicePixelRatio || 1)));
  invoke("file_icons", { keys, size: 16, scale }).then((urls) => {
    keys.forEach((k, n) => {
      let u = urls[n] || "";
      if (u) { if (pool.has(u)) u = pool.get(u); else pool.set(u, u); }
      cache.set(k, u);
      if (cache.size > MAX) cache.delete(cache.keys().next().value);
      const els = waiting.get(k) || [];
      waiting.delete(k);
      if (u) els.forEach((g) => { if (g.isConnected) g.replaceWith(img(u)); });
    });
  }).catch(() => { keys.forEach((k) => { cache.set(k, ""); waiting.delete(k); }); });
}

/** Icon element for entry e (a glyph now, the Finder icon when it lands). */
export function fileIcon(e) {
  if (!prefs.fileIcons || !invoke) return kindIcon(e.name, e.is_dir);
  const k = iconKey(e);
  const u = cache.get(k);
  if (u) return img(u);
  const g = kindIcon(e.name, e.is_dir);
  if (u === "") return g; // known: no icon
  if (!waiting.has(k)) waiting.set(k, []);
  waiting.get(k).push(g);
  if (!queued) { queued = true; setTimeout(flush, 0); }
  return g;
}

/** Forget cached icons (e.g. after the setting changes). */
export function clearIcons() { cache.clear(); pool.clear(); }
