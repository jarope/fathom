// New ▸ from Template: files and folders in the templates folder (~/Templates
// unless Preferences → General says otherwise) copied into the current folder,
// then renamed in place like New Folder.

import { app, invoke, el, kindOf } from "./core.js";
import { prefs } from "./settings.js";
import { pushUndo, refreshAll } from "./ops.js";

const KIND_ICON = { folder: "folder", image: "kImage", video: "kVideo", audio: "kAudio", code: "kCode", archive: "kArchive", app: "kApp" };

/** Sub-menu entries for New from Template ▸. */
export async function templateEntries(P) {
  let t;
  try { t = await invoke("templates", { dir: prefs.templatesDir || "" }); } catch (e) { return [{ heading: "⚠ " + e }]; }
  const tidy = t.dir.replace(app.home, "~");
  if (!t.exists) {
    return [
      { heading: `No templates folder yet (${tidy})` },
      { label: "Set Up Templates Folder", fn: () => setup(P) },
    ];
  }
  const items = t.items.map((x) => ({
    label: x.name, icon: x.is_dir ? "folder" : KIND_ICON[kindOf(x.name)] || "kDoc",
    fn: () => createFrom(P, x),
  }));
  return [
    ...(items.length ? items : [{ heading: `Put files in ${tidy} to use them here` }]),
    "sep",
    { label: "Open Templates Folder", fn: () => P.navigate(t.dir) },
  ];
}

async function createFrom(P, t) {
  if (!P.cwd) return;
  let path;
  try { path = await invoke("create_from_template", { template: t.path, parent: P.cwd }); }
  catch (e) { P.flash("⚠ " + e, "warn"); return; }
  pushUndo({ kind: "create", created: [path], label: `new “${t.name}”` });
  P.els.search.value = "";
  if (P.mode === "search") await P.navigate(P.cwd, { push: false });
  await refreshAll();
  P.startRename(path);
}

async function setup(P) {
  let dir;
  try { dir = await invoke("templates_setup", { dir: prefs.templatesDir || "" }); }
  catch (e) { P.flash("⚠ " + e, "warn"); return; }
  P.flash(`Made ${dir.replace(app.home, "~")} with some starter templates — add your own`);
}

/** Preferences row: the folder, Change…, Open. */
export function templatesField(field, note, save) {
  const show = el("span", "pf-path", (prefs.templatesDir || "~/Templates"));
  const change = el("button", "mbtn small", "Change…"); change.type = "button";
  change.addEventListener("click", async () => {
    const { pickFolder } = await import("./picker.js");
    const start = (prefs.templatesDir || "~/Templates").replace(/^~/, app.home);
    const d = await pickFolder({ start, title: "Templates folder", verb: "Use" });
    if (!d) return;
    prefs.templatesDir = d === app.home + "/Templates" ? "" : d.replace(app.home, "~");
    show.textContent = prefs.templatesDir || "~/Templates";
    save();
  });
  const w = el("div", "pf-inline"); w.append(show, change);
  return field("Templates", w, note("Files and folders here appear under right-click → New from Template."));
}
