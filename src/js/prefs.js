// Preferences (⌘,): General, Actions, Shortcuts. Changes apply and save
// straight away (Mac-style) — no OK button to forget.

import { app, invoke, dialog, el, fmtDate } from "./core.js";
import { modal } from "./dialog.js";
import { prefs, saveSettings, settingsProblem } from "./settings.js";
import { actions, actionsProblem, saveActions, loadActions, EXAMPLES } from "./actions.js";
import { allCommands, keysFor, keyLabel, comboOf, rebuildKeymap, commandFor, RESERVED, isFixed } from "./keys.js";
import { toggleHidden, toggleShelf } from "./view.js";
import { ACCENTS, applyAppearance, followSystem, systemAccent, accentSource } from "./appearance.js";
import { themesFor, allThemes, BUILTIN, parseTheme, addTheme, removeTheme } from "./themes.js";
import { checkForUpdates } from "./updates.js";
import { templatesField } from "./templates.js";

const TERMINALS = ["Terminal", "iTerm", "Ghostty", "Warp"];
const redrawPanes = () => app.tabs.forEach((t) => t.panes.forEach((p) => p.cwd && p.mode === "browse" && p.renderList()));

const field = (label, ...controls) => {
  const r = el("div", "pf-row");
  r.append(el("div", "pf-label", label));
  const c = el("div", "pf-ctl"); c.append(...controls); r.append(c);
  return r;
};
const select = (opts, value, onChange) => {
  const s = el("select", "pf-select");
  opts.forEach(([v, l]) => { const o = el("option", null, l); o.value = v; s.append(o); });
  s.value = value;
  s.addEventListener("change", () => onChange(s.value));
  return s;
};
const check = (label, on, onChange) => {
  const l = el("label", "pf-check"), c = el("input"); c.type = "checkbox"; c.checked = on;
  c.addEventListener("change", () => onChange(c.checked));
  l.append(c, document.createTextNode(" " + label));
  return l;
};
const note = (t, cls = "") => el("div", "pf-note " + cls, t);

// ---------------------------------------------------------------- General
function general() {
  const box = el("div", "pf-pane");
  if (settingsProblem) box.append(note("⚠ " + settingsProblem, "warn"));

  const folder = el("input", "pf-input"); folder.value = prefs.startFolder || app.home; folder.spellcheck = false;
  const choose = el("button", "mbtn small", "Choose…"); choose.type = "button";
  const setFolder = (v) => { prefs.startFolder = v === app.home ? "" : v; saveSettings(); };
  folder.addEventListener("change", () => setFolder(folder.value.trim()));
  choose.addEventListener("click", async () => {
    if (!dialog) return;
    const p = await dialog.open({ directory: true, multiple: false, defaultPath: folder.value, title: "Open at start-up" });
    if (typeof p === "string") { folder.value = p; setFolder(p); }
  });
  const fwrap = el("div", "pf-inline"); fwrap.append(folder, choose);
  const showFolder = () => fwrap.classList.toggle("off", prefs.startup !== "folder");
  box.append(field("At start-up", select([["restore", "Reopen my last tabs"], ["folder", "Open a folder"]], prefs.startup, (v) => { prefs.startup = v; saveSettings(); showFolder(); }), fwrap));
  showFolder();

  // Appearance
  box.append(field("Appearance", select([["system", "Match the system"], ["light", "Light"], ["dark", "Dark"]], prefs.theme || "system", (v) => {
    if (v === "system") followSystem(); else { prefs.theme = v; applyAppearance(); }
    saveSettings();
  })));
  const sw = el("div", "pf-swatches");
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  const accentNote = note("");
  const isCustom = () => /^#[0-9a-f]{6}$/i.test(prefs.accent || "");
  const paintSw = () => {
    const cur = isCustom() ? "custom" : ACCENTS.includes(prefs.accent) ? prefs.accent : "system";
    sw.querySelectorAll(".pf-swatch").forEach((b) => b.classList.toggle("on", b.dataset.v === cur));
    const src = accentSource();
    accentNote.textContent = src === "custom" ? `Custom ${prefs.accent.toUpperCase()}` : src === "named" ? cap(prefs.accent)
      : src.startsWith("theme:") ? `The theme's own (${src.slice(6)})` : `Following macOS: ${cap(systemAccent())}`;
  };
  [["system", "Match macOS (System Settings › Appearance)"], ...ACCENTS.map((a) => [a, cap(a)])].forEach(([v, t]) => {
    const b = el("button", "pf-swatch" + (v === "system" ? " sys" : "")); b.type = "button"; b.dataset.v = v; b.title = t; b.setAttribute("aria-label", t);
    if (v !== "system") b.style.setProperty("--sw", `var(--sw-${v})`);
    else b.style.setProperty("--sw", "var(--accent)");
    b.addEventListener("click", () => { prefs.accent = v; saveSettings(); applyAppearance(); paintSw(); });
    sw.append(b);
  });
  // Custom: any colour (the macOS colour picker).
  const cw = el("label", "pf-swatch custom"); cw.dataset.v = "custom"; cw.title = "Custom colour…";
  const pick = el("input"); pick.type = "color"; pick.value = isCustom() ? prefs.accent : "#3f76de"; pick.setAttribute("aria-label", "Custom accent colour");
  cw.style.setProperty("--sw", isCustom() ? prefs.accent : "conic-gradient(#ff453a, #ffd60a, #34c759, #0a84ff, #af52de, #ff453a)");
  pick.addEventListener("input", () => { prefs.accent = pick.value; cw.style.setProperty("--sw", pick.value); applyAppearance(); paintSw(); });
  pick.addEventListener("change", () => saveSettings());
  cw.append(pick); sw.append(cw);
  sw.append(accentNote); paintSw();
  box.append(field("Accent colour", sw));

  // Colour themes: one for light mode, one for dark (Fathom keeps following macOS).
  const tbox = el("div", "pf-themes");
  const drawThemes = () => {
    tbox.replaceChildren();
    const row = (label, mode, key) => {
      const r = el("div", "pf-trow");
      r.append(el("span", "pf-tl", label), select([["", "Fathom"], ...themesFor(mode)], prefs[key] || "", (v) => { prefs[key] = v; saveSettings(); applyAppearance(); paintSw(); }));
      return r;
    };
    tbox.append(row("Light", "light", "lightTheme"), row("Dark", "dark", "darkTheme"));
    const btns = el("div", "pf-inline");
    const imp = el("button", "mbtn small", "Import Theme…"); imp.type = "button";
    imp.addEventListener("click", async () => { if (await importThemeDialog()) { drawThemes(); applyAppearance(); paintSw(); } });
    btns.append(imp); tbox.append(btns);
    const mine = allThemes().filter((t) => !BUILTIN.includes(t));
    if (mine.length) {
      const list = el("div", "pf-tlist");
      mine.forEach((t) => {
        const it = el("div", "pf-titem");
        it.append(el("span", null, t.name), el("span", "pf-tmode", [t.light && "light", t.dark && "dark"].filter(Boolean).join(" + ")));
        const x = el("button", "pf-tx", "×"); x.type = "button"; x.title = `Remove “${t.name}”`;
        x.addEventListener("click", () => { removeTheme(t.id); drawThemes(); applyAppearance(); paintSw(); });
        it.append(x); list.append(it);
      });
      tbox.append(list);
    }
  };
  drawThemes();
  box.append(field("Colour theme", tbox, note("Solarized, Nord, Dracula, Gruvbox and Catppuccin are built in. Import a base16 scheme (YAML / JSON), a VS Code colour theme (.json from an extension's themes folder), or a Fathom theme file.")));
  const rng = el("input"); rng.type = "range"; rng.min = 50; rng.max = 100; rng.step = 5; rng.value = prefs.glass;
  const out = el("output", null, prefs.glass + "%");
  rng.addEventListener("input", () => { prefs.glass = +rng.value; out.textContent = rng.value + "%"; applyAppearance(); });
  rng.addEventListener("change", () => saveSettings());
  const rwrap = el("div", "pf-range"); rwrap.append(rng, out);
  box.append(field("Glass", rwrap, note("Sidebar, toolbar and menus. 100% is solid, the same as Reduce Transparency in System Settings › Accessibility.")));

  const sample = Math.floor(Date.now() / 1000) - 3600 * 26;
  const dateOpts = [["iso", "ISO"], ["locale", "System style"], ["relative", "Relative"]].map(([v, l]) => [v, `${l} — ${fmtDate(sample, v)}`]);
  box.append(field("Dates", select(dateOpts, prefs.dateFormat, (v) => { prefs.dateFormat = v; saveSettings(); redrawPanes(); })));

  box.append(templatesField(field, note, () => saveSettings()));

  box.append(field("Terminal app", select(TERMINALS.map((t) => [t, t]), prefs.terminal, (v) => { prefs.terminal = v; saveSettings(); }),
    note("Used by Open Terminal Here and actions that run in a terminal.")));

  box.append(field("Show",
    check("Hidden files", app.showHidden, (on) => on !== app.showHidden && toggleHidden()),
    check("Folder shelf (sub-folders as tiles above the files)", app.folderShelf, (on) => on !== app.folderShelf && toggleShelf()),
    check("Finder icons in lists (off = simple kind symbols)", prefs.fileIcons, (on) => { prefs.fileIcons = on; saveSettings(); app.tabs.forEach((t) => t.panes.forEach((p) => p.cwd && p.renderList())); })));

  // Updates
  const ustat = note(app.version ? `You have Fathom ${app.version}.` : "");
  const unow = el("button", "mbtn small", "Check Now"); unow.type = "button";
  unow.addEventListener("click", async () => {
    unow.disabled = true; ustat.textContent = "Checking…"; ustat.classList.remove("warn");
    const r = await checkForUpdates(true);
    unow.disabled = false;
    if (r.error) { ustat.textContent = "⚠ " + r.error; ustat.classList.add("warn"); }
    else if (r.upToDate) ustat.textContent = `Fathom ${app.version || ""} is the newest version.`.replace("  ", " ");
    else ustat.textContent = `Fathom ${r.found.version} is available — see the card at the bottom right.`;
  });
  const uw = el("div", "pf-inline"); uw.append(check("Check for updates automatically (once a day)", prefs.autoUpdate !== false, (on) => { prefs.autoUpdate = on; saveSettings(); }), unow);
  box.append(field("Updates", uw, ustat));

  box.append(note("Saved in ~/.config/fathom/settings.json — hand edits are fine; restart Fathom to pick them up."));
  return box;
}

// ---------------------------------------------------------------- Actions
function actionsPane() {
  const box = el("div", "pf-pane");
  let list = actions.map((a) => ({ ...a }));
  let editing = -1;

  const persist = async () => {
    try { await saveActions(list); rebuildKeymap(); }
    catch (e) { box.querySelector(".pf-err").textContent = "⚠ " + e; }
  };

  const render = () => {
    box.innerHTML = "";
    if (actionsProblem) box.append(note("⚠ " + actionsProblem, "warn"));
    box.append(el("div", "pf-err"));
    const rows = el("div", "pf-actions");
    list.forEach((a, i) => {
      if (i === editing) { rows.append(editor(a, i)); return; }
      const r = el("div", "pf-act");
      const info = el("div", "pf-act-info");
      const on = { any: "anything", files: "files", folders: "folders", here: "the folder you're in" }[a.on];
      info.append(el("div", "pf-act-name", a.name), el("div", "pf-act-meta",
        `${on}${a.ext ? ` (${a.ext.join(", ")})` : ""}${a.multi === false ? " · one at a time" : ""} · ${a.run === "terminal" ? "in terminal" : a.output ? "shows output" : "background"}${a.menu === "git" ? " · Git menu" : ""}`));
      info.append(el("code", "pf-act-cmd", a.command));
      const btns = el("div", "pf-act-btns");
      const b = (t, title, fn) => { const x = el("button", "mbtn small", t); x.type = "button"; x.title = title; x.addEventListener("click", fn); btns.append(x); };
      b("↑", "Move up", () => { if (i > 0) { [list[i - 1], list[i]] = [list[i], list[i - 1]]; persist(); render(); } });
      b("Edit", "Edit", () => { editing = i; render(); });
      b("✕", "Delete", () => { list.splice(i, 1); persist(); render(); });
      r.append(info, btns);
      rows.append(r);
    });
    if (!list.length) rows.append(note("No actions yet."));
    box.append(rows);
    const bar = el("div", "pf-bar");
    const add = el("button", "mbtn small", "Add Action"); add.type = "button";
    add.addEventListener("click", () => { list.push({ name: "", command: "", on: "any" }); editing = list.length - 1; render(); });
    const ex = el("button", "mbtn small", "Add the examples"); ex.type = "button";
    ex.addEventListener("click", () => { EXAMPLES.forEach((e) => { if (!list.some((a) => a.name === e.name)) list.push({ ...e }); }); persist(); render(); });
    const file = el("button", "mbtn small", "Open actions.json"); file.type = "button";
    file.addEventListener("click", () => invoke("open_path", { path: app.home + "/.config/fathom/actions.json" }));
    const reload = el("button", "mbtn small", "Reload"); reload.type = "button"; reload.title = "Re-read actions.json after editing it by hand";
    reload.addEventListener("click", async () => { await loadActions(); list = actions.map((a) => ({ ...a })); editing = -1; rebuildKeymap(); render(); });
    bar.append(add, ex, el("span", "grow"), file, reload);
    box.append(bar);
    box.append(note("Right-click → Actions ▸ (or Git ▸) runs them. In the command: %f first item · %F all items · %d this folder · %n first item's name · %% a literal %. Runs in zsh as a login shell, from the current folder."));
  };

  const editor = (a, i) => {
    const f = el("div", "pf-edit");
    const name = el("input", "pf-input"); name.value = a.name; name.placeholder = "Name in the menu";
    const cmd = el("textarea", "pf-input pf-cmd"); cmd.value = a.command; cmd.rows = 2; cmd.spellcheck = false; cmd.placeholder = 'e.g. open -a "Preview" %F';
    const ext = el("input", "pf-input"); ext.value = (a.ext || []).join(", "); ext.placeholder = "any type (or e.g. png, jpg)";
    let on = a.on || "any", run = a.run || "background", multi = a.multi !== false, output = !!a.output, menu = a.menu || "actions";
    f.append(field("Name", name), field("Command", cmd),
      field("Shows for", select([["any", "Files and folders"], ["files", "Files"], ["folders", "Folders"], ["here", "The folder you're in (empty-space menu)"]], on, (v) => (on = v))),
      field("File types", ext),
      field("Show in", select([["actions", "Actions menu"], ["git", "Git menu (only inside a git repo)"]], menu, (v) => (menu = v))),
      field("Runs", select([["background", "In the background"], ["terminal", "In the terminal app"]], run, (v) => (run = v)),
        check("Several items at once", multi, (v) => (multi = v)), check("Show its output", output, (v) => (output = v))));
    const err = el("div", "pf-err");
    const bar = el("div", "pf-bar");
    const cancel = el("button", "mbtn small", "Cancel"), save = el("button", "mbtn small primary", "Save");
    cancel.type = save.type = "button";
    cancel.addEventListener("click", () => { if (!a.name && !a.command) list.splice(i, 1); editing = -1; render(); });
    save.addEventListener("click", () => {
      const n = name.value.trim();
      if (!n || !cmd.value.trim()) { err.textContent = "⚠ An action needs a name and a command"; return; }
      if (list.some((x, j) => j !== i && x.name === n)) { err.textContent = "⚠ Another action already has that name"; return; }
      list[i] = { name: n, command: cmd.value.trim(), on, ext: ext.value, multi, run, output, menu };
      editing = -1; persist(); render();
    });
    bar.append(el("span", "grow"), cancel, save);
    f.append(err, bar);
    setTimeout(() => (a.name ? cmd : name).focus(), 0);
    return f;
  };

  render();
  return box;
}

// ---------------------------------------------------------------- Shortcuts
function shortcutsPane() {
  const box = el("div", "pf-pane");
  const top = el("div", "pf-bar");
  const filter = el("input", "pf-input"); filter.placeholder = "Filter commands or keys…"; filter.spellcheck = false;
  const resetAll = el("button", "mbtn small", "Reset All"); resetAll.type = "button";
  top.append(filter, resetAll);
  const msg = el("div", "pf-note sc-msg");
  const list = el("div", "sc-list");
  box.append(top, msg, list, note("Click + to add a key, a key to remove it. Fixed: arrows, ⏎, Esc, ⌘1–9 (tabs), ⌃⌘0–9 (tags)."));

  const save = (id, keys, cmd) => {
    if (JSON.stringify(keys) === JSON.stringify(cmd.keys)) delete prefs.shortcuts[id]; else prefs.shortcuts[id] = keys;
    saveSettings(); rebuildKeymap();
  };
  let recording = null; // { cmd, chip }
  const stopRecording = () => { if (!recording) return; window.removeEventListener("keydown", onRecord, true); recording = null; };
  const onRecord = (e) => {
    e.preventDefault(); e.stopImmediatePropagation();
    const combo = comboOf(e); if (!combo) return; // lone modifier: keep waiting
    const { cmd } = recording; stopRecording();
    if (combo === "Escape") { render(); return; }
    if (RESERVED.has(combo)) { msg.textContent = `⚠ ${keyLabel(combo)} belongs to macOS — pick another.`; msg.className = "pf-note sc-msg warn"; render(); return; }
    if (isFixed(combo)) { msg.textContent = `⚠ ${keyLabel(combo)} is one of Fathom's fixed keys — pick another.`; msg.className = "pf-note sc-msg warn"; render(); return; }
    const other = commandFor(combo);
    if (other && other.id !== cmd.id) {
      save(other.id, keysFor(other).filter((k) => k !== combo), other);
      msg.textContent = `${keyLabel(combo)} moved from “${other.label}” to “${cmd.label}”.`; msg.className = "pf-note sc-msg warn";
    } else msg.textContent = "";
    const keys = keysFor(cmd); if (!keys.includes(combo)) save(cmd.id, [...keys, combo], cmd);
    render();
  };

  const render = () => {
    stopRecording();
    list.innerHTML = "";
    const q = filter.value.trim().toLowerCase();
    let group = null;
    allCommands().forEach((cmd) => {
      const keys = keysFor(cmd);
      const hay = (cmd.label + " " + cmd.group + " " + keys.map(keyLabel).join(" ")).toLowerCase();
      if (q && !hay.includes(q)) return;
      if (cmd.group !== group) { group = cmd.group; list.append(el("div", "sc-group", group)); }
      const r = el("div", "sc-row");
      r.append(el("span", "sc-label", cmd.label));
      const chips = el("span", "sc-keys");
      keys.forEach((k) => {
        const c = el("button", "sc-key", keyLabel(k)); c.type = "button"; c.title = "Remove this key";
        c.addEventListener("click", () => { save(cmd.id, keysFor(cmd).filter((x) => x !== k), cmd); msg.textContent = ""; render(); });
        chips.append(c);
      });
      const add = el("button", "sc-key sc-add", "+"); add.type = "button"; add.title = "Add a key";
      add.addEventListener("click", () => {
        render(); // cancels any other recording
        const a = [...list.querySelectorAll(".sc-row")].find((x) => x.dataset.id === cmd.id)?.querySelector(".sc-add");
        if (!a) return;
        a.textContent = "Press keys… (Esc cancels)"; a.classList.add("rec");
        recording = { cmd };
        window.addEventListener("keydown", onRecord, true);
      });
      chips.append(add);
      r.dataset.id = cmd.id;
      r.append(chips);
      const custom = !!prefs.shortcuts[cmd.id];
      const reset = el("button", "sc-reset" + (custom ? "" : " off"), "↺"); reset.type = "button"; reset.title = "Back to the default";
      reset.addEventListener("click", () => { delete prefs.shortcuts[cmd.id]; saveSettings(); rebuildKeymap(); render(); });
      r.append(reset);
      if (custom) r.classList.add("custom");
      list.append(r);
    });
  };
  filter.addEventListener("input", render);
  resetAll.addEventListener("click", () => { prefs.shortcuts = {}; saveSettings(); rebuildKeymap(); msg.textContent = "All shortcuts are back to their defaults."; msg.className = "pf-note sc-msg"; render(); });
  box.cleanup = stopRecording;
  render();
  return box;
}

// ---------------------------------------------------------------- window
let open = false;
export async function openPrefs(tab = "general") {
  if (open) return; open = true;
  const body = el("div", "pf");
  const tabs = el("div", "pf-tabs"), holder = el("div", "pf-holder");
  const make = { general, actions: actionsPane, shortcuts: shortcutsPane };
  let cur = null;
  const show = (k) => {
    if (cur && cur.cleanup) cur.cleanup();
    tabs.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.k === k));
    holder.innerHTML = ""; cur = make[k](); holder.append(cur);
  };
  [["general", "General"], ["actions", "Actions"], ["shortcuts", "Shortcuts"]].forEach(([k, l]) => {
    const b = el("button", "pf-tab", l); b.type = "button"; b.dataset.k = k;
    b.addEventListener("click", () => show(k)); tabs.append(b);
  });
  body.append(tabs, holder);
  show(tab);
  await modal({ title: "Preferences", body, wide: true, buttons: [{ label: "Done", value: true, primary: true }], enterSubmits: false });
  if (cur && cur.cleanup) cur.cleanup();
  open = false;
}

// ---------------------------------------------------------------- theme import
/** Paste or choose a theme file; keeps it and switches to it. Resolves true if imported. */
async function importThemeDialog() {
  const body = el("div", "pf-import");
  const ta = el("textarea", "pf-ta"); ta.spellcheck = false;
  ta.placeholder = "Paste a theme here — base16 YAML / JSON, a VS Code colour theme, or Fathom JSON…";
  const choose = el("button", "mbtn small", "Choose File…"); choose.type = "button";
  const status = el("div", "pf-note");
  let parsed = null, fileName = "";
  const check = () => {
    parsed = null;
    if (!ta.value.trim()) { status.textContent = ""; if (modal.setEnabled) modal.setEnabled(false); return; }
    try {
      parsed = parseTheme(ta.value, fileName);
      status.textContent = `Found “${parsed.name}” — ${[parsed.light && "light", parsed.dark && "dark"].filter(Boolean).join(" and ")}`;
      status.classList.remove("warn");
    } catch (e) { status.textContent = "⚠ " + e.message; status.classList.add("warn"); }
    if (modal.setEnabled) modal.setEnabled(!!parsed);
  };
  ta.addEventListener("input", () => { fileName = ""; check(); });
  choose.addEventListener("click", async () => {
    if (!dialog) return;
    const p = await dialog.open({ title: "Import Theme", multiple: false, directory: false, filters: [{ name: "Themes", extensions: ["json", "jsonc", "yaml", "yml"] }] });
    if (typeof p !== "string") return;
    try { ta.value = await invoke("read_text_file", { path: p }); fileName = p; check(); }
    catch (e) { status.textContent = "⚠ " + e; status.classList.add("warn"); }
  });
  const top = el("div", "pf-inline"); top.append(choose);
  body.append(top, ta, status);
  setTimeout(() => { if (modal.setEnabled) modal.setEnabled(false); }, 0);
  const ok = await modal({ title: "Import Theme", body, wide: true, enterSubmits: false, focus: ta,
    buttons: [{ label: "Cancel", value: null }, { label: "Import", value: true, primary: true }] });
  if (!ok || !parsed) return false;
  const id = addTheme(parsed);
  if (parsed.light) prefs.lightTheme = id;
  if (parsed.dark) prefs.darkTheme = id;
  saveSettings();
  return true;
}
