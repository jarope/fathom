// Theme maker (Preferences → Colour theme → New Theme… / Edit): change a
// theme's colours with the whole window as the live preview. One tab per
// mode (light / dark); each colour has a swatch (the macOS Colours panel,
// with its eyedropper), a hex field and, for everything but background and
// text, Auto — leave it to Fathom, which works it out from those two. Text
// colours show their contrast against the background and hover row (WCAG:
// 4.5 reads as body text, 3 for large text and icons). Cancel puts back how
// things were; Save keeps it in settings.json like an imported theme, and
// Export writes the Fathom theme file that Import Theme reads.

import { dialog, el, invoke } from "./core.js";
import { modal } from "./dialog.js";
import { prefs, saveSettings } from "./settings.js";
import { applyAppearance, resolvedTheme } from "./appearance.js";
import { FIELDS, REQUIRED, allThemes, themeById, BUILTIN, applyPalette, setAccentInline, currentColours,
  parseHex, contrast, onColour, addTheme, updateTheme, themeFile } from "./themes.js";

const root = document.documentElement;
const MODES = [["light", "Light"], ["dark", "Dark"]];
const EXTRAS = ["font", "glow"];
const clone = (o) => (o ? JSON.parse(JSON.stringify(o)) : null);

/** Fathom's own colours for a mode (no theme). Separator and accent stay Auto,
 *  so the accent keeps following yours / macOS's until you pick one. */
function fathomPalette(mode) {
  const was = root.getAttribute("data-theme");
  root.setAttribute("data-theme", mode);
  applyPalette(root, null, mode);
  setAccentInline(root, null);
  const c = currentColours(root);
  root.setAttribute("data-theme", was);
  delete c.separator; delete c.accent;
  return c;
}

/** A theme's palette for `mode`, or Fathom's when it has none. */
const paletteFrom = (id, mode) => clone(id && themeById(id)?.[mode]) || fathomPalette(mode);

const GREY = [128, 128, 128];
/** Lowest contrast of colour `fg` against each of `bases` (keys into `shown`). */
const worst = (shown, fg, bases) => { const f = parseHex(shown[fg]) || GREY; return Math.min(...bases.map((k) => contrast(f, parseHex(shown[k]) || f))); };

/** WCAG rating for a contrast ratio. */
const rate = (r) => (r >= 4.5 ? ["good", "AA"] : r >= 3 ? ["ok", "Large"] : ["bad", "Low"]);

/** What each colour is checked against: [label, [colour keys]] (text-like fields only). */
const CHECKS = {
  text: ["on background and hover", ["background", "hover"]],
  text2: ["on background, hover and window", ["background", "hover", "window"]],
  text3: ["on background and hover", ["background", "hover"]],
  folder: ["on background", ["background"]],
  success: ["on background", ["background"]],
  warning: ["on background", ["background"]],
  danger: ["on background", ["background"]],
};

/**
 * Open the theme maker. `id`: a theme to change (yours) or to start a copy of
 * (built in); none starts from what's on screen now. Resolves the saved
 * theme's id, or null if cancelled.
 */
export async function themeMaker(id = null) {
  const src = id ? themeById(id) : null;
  const mine = src && !BUILTIN.includes(src);
  const now = resolvedTheme();
  const name = src ? (mine ? src.name : `${src.name} (my copy)`) : "My Theme";
  const pal = { light: null, dark: null };
  if (src) MODES.forEach(([m]) => { pal[m] = clone(src[m]); });
  else pal[now] = paletteFrom(now === "dark" ? prefs.darkTheme : prefs.lightTheme, now);
  let mode = pal[now] ? now : pal.light ? "light" : "dark";

  // ---- layout ----
  const body = el("div", "tm");
  const nameIn = el("input", "pf-input tm-name"); nameIn.value = name; nameIn.spellcheck = false; nameIn.placeholder = "Theme name";
  const exportBtn = el("button", "mbtn small", "Export…"); exportBtn.type = "button";
  exportBtn.title = "Save as a Fathom theme file (.json) to share or keep";
  const head = el("div", "tm-head"); head.append(nameIn, exportBtn);
  const tabs = el("div", "pf-tabs tm-tabs");
  const pane = el("div", "tm-pane");
  const status = el("div", "pf-note tm-status");
  body.append(head, tabs, pane, status);

  const tabBtns = MODES.map(([m, label]) => {
    const b = el("button", "pf-tab"); b.type = "button";
    b.addEventListener("click", () => { mode = m; draw(); });
    tabs.append(b);
    return [m, label, b];
  });

  let rows = []; // [{ key, swatch, hex, auto, badge }] for the current tab

  /** Show the current tab's palette on the window (or Fathom's, for a missing version). */
  function preview() {
    const p = pal[mode];
    root.setAttribute("data-theme", mode);
    applyPalette(root, p, mode);
    setAccentInline(root, p && parseHex(p.accent) ? p.accent : null);
  }

  /** Swatches, hex fields and contrast badges follow the palette (and what Fathom works out). */
  function refresh() {
    preview();
    const p = pal[mode]; if (!p) return;
    const shown = currentColours(root);
    rows.forEach((r) => {
      const own = p[r.key] && parseHex(p[r.key]) ? p[r.key] : null;
      r.swatch.value = own || shown[r.key] || "#808080";
      if (document.activeElement !== r.hex) r.hex.value = own || "";
      r.hex.placeholder = REQUIRED.has(r.key) ? "" : `Auto (${shown[r.key] || "—"})`;
      r.hex.classList.remove("bad");
      if (r.auto) r.auto.hidden = !own;
      const c = CHECKS[r.key];
      if (r.key === "accent") {
        const a = parseHex(shown.accent), ratio = a ? contrast(a, parseHex(onColour(a))) : 0;
        badge(r.badge, ratio, "text on the accent (selected rows, buttons)");
      } else if (c) badge(r.badge, worst(shown, r.key, c[1]), c[0]);
    });
    const bad = FIELDS.filter(([k]) => ["text", "text2", "text3"].includes(k) && worst(shown, k, CHECKS[k][1]) < 4.5).map(([, , l]) => l.toLowerCase());
    status.textContent = bad.length ? `Hard to read: ${bad.join(", ")} (under 4.5:1). Fine for a look you like, but check it in a dim room.` : "";
  }

  function badge(node, ratio, what) {
    const [cls, label] = rate(ratio);
    node.className = "tm-badge " + cls;
    node.textContent = `${label} ${ratio.toFixed(1)}`;
    node.title = `${ratio.toFixed(2)}:1 contrast, ${what}. 4.5 reads as body text; 3 for large text and icons.`;
  }

  /** Set one colour ("" = Auto) and update everything. */
  function set(key, v) {
    const p = pal[mode]; if (!p) return;
    if (v) p[key] = v; else delete p[key];
    refresh();
  }

  function draw() {
    tabBtns.forEach(([m, label, b]) => { b.classList.toggle("on", m === mode); b.textContent = label + (pal[m] ? "" : " (none)"); });
    pane.replaceChildren(); rows = [];
    const p = pal[mode];
    const other = mode === "dark" ? "light" : "dark";

    // Start from: replace this version with another theme's (or Fathom's) colours.
    const startOpts = [["", "Fathom"], ...allThemes().filter((t) => t[mode]).map((t) => [t.id, t.name])];
    const start = el("select", "pf-select");
    const ph = el("option", null, p ? "Start again from…" : "Start from…"); ph.value = "-"; ph.disabled = true; start.append(ph);
    startOpts.forEach(([v, l]) => { const o = el("option", null, l); o.value = v; start.append(o); });
    start.value = "-";
    start.addEventListener("change", () => { pal[mode] = paletteFrom(start.value, mode); draw(); });
    const bar = el("div", "tm-bar");
    bar.append(start);

    if (!p) {
      const add = el("button", "mbtn small", `Add ${mode === "dark" ? "Dark" : "Light"} Version`); add.type = "button";
      add.title = "Start from Fathom's own colours";
      add.addEventListener("click", () => { pal[mode] = fathomPalette(mode); draw(); });
      bar.prepend(add);
      pane.append(bar, el("div", "pf-note tm-empty",
        `This theme has no ${mode} version, so in ${mode} mode Fathom keeps its own colours (or another theme you pick for ${mode}).`));
      refresh();
      return;
    }
    if (pal[other]) {
      const rm = el("button", "mbtn small", `Remove ${mode === "dark" ? "Dark" : "Light"} Version`); rm.type = "button";
      rm.addEventListener("click", () => { pal[mode] = null; draw(); });
      bar.append(rm);
    }

    const grid = el("div", "tm-grid");
    FIELDS.forEach(([key, , label, hint]) => {
      const lab = el("div", "tm-label"); lab.append(el("div", null, label), el("div", "tm-hint", hint));
      const swatch = el("input", "tm-swatch"); swatch.type = "color"; swatch.title = `${label}: pick a colour (the eyedropper picks one from the screen)`;
      swatch.addEventListener("input", () => set(key, swatch.value));
      const hex = el("input", "pf-input tm-hex"); hex.spellcheck = false; hex.setAttribute("aria-label", label + " hex colour");
      hex.addEventListener("input", () => {
        const v = hex.value.trim();
        if (!v && !REQUIRED.has(key)) return set(key, "");
        const h = parseHex(v);
        if (h && /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) set(key, "#" + v.replace(/^#/, "").toLowerCase().replace(/^(.)(.)(.)$/, "$1$1$2$2$3$3"));
        else hex.classList.add("bad");
      });
      hex.addEventListener("blur", () => refresh());
      let auto = null;
      if (!REQUIRED.has(key)) {
        auto = el("button", "tm-auto", "Auto"); auto.type = "button";
        auto.title = "Let Fathom work this out from the background and text";
        auto.addEventListener("click", () => set(key, ""));
      }
      const b = el("span", "tm-badge");
      const ctl = el("div", "tm-ctl"); ctl.append(swatch, hex, auto || el("span", "tm-auto-gap"), b);
      grid.append(lab, ctl);
      rows.push({ key, swatch, hex, auto, badge: b });
    });

    const extras = el("div", "tm-extras");
    const ex = (k, label, title) => {
      const l = el("label", "pf-check"), c = el("input"); c.type = "checkbox";
      c.checked = k === "font" ? p.font === "vt323" : !!p.glow; l.title = title;
      c.addEventListener("change", () => { if (k === "font") { if (c.checked) p.font = "vt323"; else delete p.font; } else if (c.checked) p.glow = true; else delete p.glow; refresh(); });
      l.append(c, document.createTextNode(" " + label));
      return l;
    };
    extras.append(ex("font", "Pixel font", "VT323, the bundled terminal font, set larger so it reads"), ex("glow", "CRT glow", "Phosphor glow and faint scanlines"));

    pane.append(bar, grid, extras, sample());
    refresh();
  }

  /** A little file list in the theme's colours, beside the real window behind. */
  function sample() {
    const s = el("div", "tm-sample"); s.setAttribute("aria-hidden", "true");
    const side = el("div", "tm-s-side");
    ["Home", "Documents", "Downloads"].forEach((n, i) => side.append(el("div", "tm-s-place" + (i === 1 ? " on" : ""), n)));
    const list = el("div", "tm-s-list");
    const row = (cls, icon, n, d) => { const r = el("div", "tm-s-row " + cls); r.append(el("span", "tm-s-ic " + icon), el("span", "tm-s-n", n), el("span", "tm-s-d", d)); return r; };
    list.append(row("", "dir", "Projects", "Today, 09:41"), row("hover", "dir", "Photos", "Yesterday"), row("sel", "doc", "Notes.md", "12 Nov"), row("", "doc", "Budget.xlsx", "3 Nov"));
    const chips = el("div", "tm-s-chips");
    chips.append(el("span", "tm-s-chip ok", "Copied"), el("span", "tm-s-chip warn", "Busy"), el("span", "tm-s-chip err", "Failed"), el("span", "tm-s-btn", "Button"));
    list.append(chips);
    s.append(side, list);
    return s;
  }

  // ---- export ----
  const built = () => {
    const out = { name: nameIn.value.trim() || "My Theme" };
    MODES.forEach(([m]) => { if (pal[m]) out[m] = clean(pal[m]); });
    return out;
  };
  exportBtn.addEventListener("click", async () => {
    const problem = check(); if (problem) { status.textContent = "⚠ " + problem; return; }
    const th = built();
    if (!dialog) return;
    const path = await dialog.save({ title: "Export Theme", defaultPath: th.name.replace(/[/:]/g, "-") + ".json", filters: [{ name: "Fathom theme", extensions: ["json"] }] });
    if (!path) return;
    try { await invoke("write_text_file", { path, text: themeFile(th) }); status.textContent = `Exported to ${path}`; }
    catch (e) { status.textContent = "⚠ " + e; }
  });

  function check() {
    if (!nameIn.value.trim()) return "Give the theme a name.";
    if (!pal.light && !pal.dark) return "A theme needs a light or a dark version.";
    for (const [m, l] of MODES) {
      const p = pal[m]; if (!p) continue;
      if (!parseHex(p.background) || !parseHex(p.text)) return `The ${l.toLowerCase()} version needs a background and a text colour.`;
    }
    return null;
  }

  draw();
  const ok = await modal({
    title: mine ? `Edit “${src.name}”` : "New Theme", body, wide: true, enterSubmits: false, focus: nameIn,
    buttons: [{ label: "Cancel", value: null }, { label: "Save", value: true, primary: true }],
    onSubmit: () => check(),
  });
  if (!ok) { applyAppearance(); return null; }

  const th = built();
  const savedId = mine ? updateTheme(src.id, th) : addTheme(th);
  // A new theme (or a version you just added) is put to use; edits keep your choices.
  MODES.forEach(([m]) => {
    const key = m === "dark" ? "darkTheme" : "lightTheme";
    if (th[m] && (!mine || !src[m])) prefs[key] = savedId;
    else if (!th[m] && prefs[key] === savedId) prefs[key] = ""; // that version was removed
  });
  saveSettings();
  applyAppearance();
  return savedId;
}

/** Only the colours (valid hex) and extras a theme file needs. */
function clean(p) {
  const out = {};
  FIELDS.forEach(([k]) => { const h = parseHex(p[k]); if (h) out[k] = p[k].startsWith("#") ? p[k].toLowerCase() : "#" + p[k].toLowerCase(); });
  EXTRAS.forEach((k) => { if (p[k]) out[k] = p[k]; });
  return out;
}
