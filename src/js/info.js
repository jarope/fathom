// Get Info (⌘I, right-click → Get Info): Finder's info window for the
// selection — or for the folder itself when nothing is selected.
//   One item: picture, kind, size (folders added up in the background),
//   where, dates, Spotlight facts (dimensions, duration, camera…), tags,
//   the app it opens with, and permissions you can change.
//   Several: how many, total size, where, shared tags.

import { app, invoke, listen, el, fmtSize, fmtDate, plural, kindIcon, isFolder } from "./core.js";
import { modal } from "./dialog.js";
import { kindLabel } from "./details.js";
import { thumbInto } from "./grid.js";
import { favourites, setTags } from "./tags.js";
import { refreshAll } from "./ops.js";

// Folder-size progress events, routed to whichever dialog asked.
const sizeWaiters = new Map(); // id -> fn(report)
let listening = false;
async function ensureListener() {
  if (listening || !listen) return;
  listening = true;
  await listen("dir-size", (e) => { const f = sizeWaiters.get(e.payload.id); if (f) f(e.payload); });
}

const bytes = (n) => `${n.toLocaleString()} byte${n === 1 ? "" : "s"}`;
export const sizeLine = (logical, disk) => `${fmtSize(logical, false)} (${bytes(logical)})${disk ? ` · ${fmtSize(disk, false)} on disk` : ""}`;

/** Start a background size count; calls show(text) as it goes. Returns a cancel fn. */
export async function countSize(paths, show) {
  await ensureListener();
  let id;
  try { id = await invoke("dir_size", { paths }); } catch (e) { show("⚠ " + e); return () => {}; }
  sizeWaiters.set(id, (r) => {
    const items = r.files + r.dirs;
    show(`${sizeLine(r.bytes, r.on_disk)} · ${items.toLocaleString()} item${items === 1 ? "" : "s"}${r.done ? "" : " — counting…"}`);
    if (r.done) sizeWaiters.delete(id);
  });
  return () => { if (sizeWaiters.has(id)) { sizeWaiters.delete(id); invoke("dir_size_cancel", { id }).catch(() => {}); } };
}

function section(title) {
  const s = el("section", "gi-sec");
  if (title) s.append(el("h3", "gi-h", title));
  const dl = el("dl", "gi-dl"); s.append(dl);
  const row = (k, v, cls) => { const dd = el("dd", cls || null); if (v instanceof Node) dd.append(v); else dd.textContent = v; dl.append(el("dt", null, k), dd); return dd; };
  return { s, row };
}

// ---- tags ----
function tagEditor(P, paths, current) {
  const box = el("div", "gi-tags");
  let have = new Set(current.map((t) => t.name.toLowerCase()));
  const draw = () => {
    box.innerHTML = "";
    const all = [...favourites];
    current.forEach((t) => { if (!all.some((f) => f.name.toLowerCase() === t.name.toLowerCase())) all.push(t); });
    all.forEach((t) => {
      const on = have.has(t.name.toLowerCase());
      const c = el("button", "tag-chip" + (on ? " on" : "")); c.type = "button";
      c.title = on ? `Remove “${t.name}”` : `Add “${t.name}”`;
      c.append(el("i", `tg tc${t.color || 0}`), document.createTextNode(t.name));
      c.addEventListener("click", async () => {
        await setTags(P, paths, on ? { remove: [t.name] } : { add: [t.name] });
        on ? have.delete(t.name.toLowerCase()) : have.add(t.name.toLowerCase());
        if (!on && !current.some((x) => x.name.toLowerCase() === t.name.toLowerCase())) current.push(t);
        draw();
      });
      box.append(c);
    });
    const add = el("input", "gi-newtag"); add.placeholder = "New tag…"; add.spellcheck = false;
    add.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter" || !add.value.trim()) return;
      e.preventDefault(); e.stopPropagation();
      const name = add.value.trim();
      await setTags(P, paths, { add: [name] });
      have.add(name.toLowerCase()); current.push({ name, color: 0 }); draw();
      box.querySelector(".gi-newtag").focus();
    });
    box.append(add);
  };
  draw();
  return box;
}

// ---- permissions ----
function permEditor(P, info) {
  const wrap = el("div", "gi-perm");
  let mode = info.mode;
  const octal = el("span", "gi-octal mono");
  const grid = el("div", "gi-pgrid");
  const who = [["Owner", info.owner, 6], ["Group", info.group, 3], ["Everyone", "", 0]];
  grid.append(el("span"), el("span", "gi-ph", "Read"), el("span", "gi-ph", "Write"), el("span", "gi-ph", info.is_dir ? "Enter" : "Run"));
  const boxes = [];
  who.forEach(([label, name, shift]) => {
    const l = el("span", "gi-pw"); l.append(document.createTextNode(label)); if (name) l.append(el("span", "gi-pn", ` (${name})`));
    grid.append(l);
    [4, 2, 1].forEach((bit) => {
      const cb = el("input"); cb.type = "checkbox"; cb.dataset.bit = bit << shift;
      grid.append(cb); boxes.push(cb);
    });
  });
  const sync = () => {
    boxes.forEach((b) => { b.checked = !!(mode & +b.dataset.bit); });
    octal.textContent = "0" + (mode & 0o777).toString(8).padStart(3, "0");
  };
  const err = el("div", "gi-err");
  boxes.forEach((b) => b.addEventListener("change", async () => {
    const next = b.checked ? mode | +b.dataset.bit : mode & ~+b.dataset.bit;
    try { await invoke("set_mode", { path: info.path, mode: next }); mode = next; err.textContent = ""; refreshAll(); }
    catch (e) { err.textContent = "⚠ " + e; }
    sync();
  }));
  sync();
  wrap.append(grid, octal, err);
  return wrap;
}

/** Open Get Info for P's selection, or its folder when nothing is selected. */
export async function getInfo(P) {
  if (!P || !invoke) return;
  let sel = P.selectedEntries();
  if (!sel.length) {
    if (!P.cwd) return;
    sel = [{ path: P.cwd, name: P.cwd === "/" ? "Macintosh HD" : P.cwd.split("/").pop(), is_dir: true, parent: P.parent, tags: [] }];
  }
  return sel.length === 1 ? infoOne(P, sel[0]) : infoMany(P, sel);
}

async function infoOne(P, e) {
  let info;
  try { info = await invoke("file_info", { path: e.path }); }
  catch (err) { P.flash("⚠ " + err, "warn"); return; }
  const folder = isFolder(e);
  const body = el("div", "gi");
  // Header
  const head = el("div", "gi-head");
  const pic = el("div", "gi-pic"); pic.append(kindIcon(e.name, e.is_dir)); thumbInto(pic, e, 128);
  const ht = el("div", "gi-ht");
  ht.append(el("div", "gi-name", info.name));
  const sub = el("div", "gi-sub", info.kind || kindLabel(e));
  ht.append(sub);
  head.append(pic, ht);
  body.append(head);

  // General
  const g = section("General");
  g.row("Kind", info.kind || kindLabel(e));
  const sizeDD = g.row("Size", folder ? "Counting…" : sizeLine(info.size, info.on_disk));
  let cancel = () => {};
  if (folder) cancel = await countSize([info.path], (t) => { sizeDD.textContent = t; if (!/counting/.test(t)) sub.textContent = `${info.kind || "Folder"} · ${t.split(" (")[0]}`; });
  else sub.textContent = `${info.kind || kindLabel(e)} · ${fmtSize(info.size, false)}`;
  const where = el("button", "gi-link mono", (info.path.replace(/\/[^/]+$/, "") || "/"));
  where.type = "button"; where.title = "Show in this pane";
  where.addEventListener("click", async () => { closeIt(); const dir = info.path.replace(/\/[^/]+$/, "") || "/"; if (await P.navigate(dir)) P.selectPaths([info.path]); });
  g.row("Where", where);
  if (info.is_symlink) g.row("Points to", info.link_target || "?", "mono");
  g.row("Created", fmtDate(info.created));
  g.row("Modified", fmtDate(info.modified));
  if (info.last_opened) g.row("Last opened", fmtDate(Math.round(info.last_opened)));
  if (e.added) g.row("Added", fmtDate(e.added));
  body.append(g.s);

  // More info (Spotlight)
  if (info.meta.length) {
    const m = section("More Info");
    info.meta.forEach(([k, v]) => m.row(k, v, k === "Where from" || k === "Content type" ? "mono wrap" : null));
    body.append(m.s);
  }

  // Tags
  const tg = el("section", "gi-sec"); tg.append(el("h3", "gi-h", "Tags"), tagEditor(P, [info.path], [...(e.tags || [])]));
  body.append(tg);

  // Opens with
  if (!folder) {
    const ow = section("Opens With");
    const dd = ow.row("App", "…");
    invoke("open_with_apps", { paths: [info.path] }).then((apps) => {
      const d = apps.find((a) => a.is_default);
      dd.textContent = d ? d.name : apps.length ? "No default app" : "No app can open this";
    }).catch(() => { dd.textContent = "—"; });
    body.append(ow.s);
  }

  // Permissions
  const pm = el("section", "gi-sec"); pm.append(el("h3", "gi-h", "Sharing & Permissions"), permEditor(P, info));
  body.append(pm);

  let closeIt = () => {};
  const done = modal({ title: "Get Info", body, wide: true, buttons: [{ label: "Done", value: true, primary: true }], enterSubmits: false });
  closeIt = () => document.querySelector(".modal-wrap:last-child .mbtn.primary")?.click();
  await done;
  cancel();
}

async function infoMany(P, sel) {
  const body = el("div", "gi");
  const head = el("div", "gi-head");
  const pic = el("div", "gi-pic gi-stack"); pic.append(kindIcon(sel[0].name, sel[0].is_dir));
  const ht = el("div", "gi-ht"); ht.append(el("div", "gi-name", plural(sel.length, "item")));
  const dirs = sel.filter(isFolder).length;
  const sub = el("div", "gi-sub", [dirs && plural(dirs, "folder"), sel.length - dirs && plural(sel.length - dirs, "file")].filter(Boolean).join(", "));
  ht.append(sub); head.append(pic, ht); body.append(head);
  const g = section("General");
  const sizeDD = g.row("Total size", "Counting…");
  const cancel = await countSize(sel.map((e) => e.path), (t) => { sizeDD.textContent = t; });
  const parents = [...new Set(sel.map((e) => e.parent || e.path.replace(/\/[^/]+$/, "")))];
  g.row("Where", parents.length === 1 ? parents[0] : `${parents.length} folders`, "mono");
  const kinds = {}; sel.forEach((e) => { const k = kindLabel(e); kinds[k] = (kinds[k] || 0) + 1; });
  g.row("Kinds", Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${n} × ${k}`).join(", "));
  body.append(g.s);
  const common = (sel[0].tags || []).filter((t) => sel.every((e) => (e.tags || []).some((x) => x.name.toLowerCase() === t.name.toLowerCase())));
  const tg = el("section", "gi-sec"); tg.append(el("h3", "gi-h", "Tags (shared)"), tagEditor(P, sel.map((e) => e.path), [...common]));
  body.append(tg);
  await modal({ title: "Get Info", body, wide: true, buttons: [{ label: "Done", value: true, primary: true }], enterSubmits: false });
  cancel();
}
