// Colour themes. Preferences picks one for light mode and one for dark mode
// (Fathom keeps following macOS's light / dark switch), from the built-ins
// below or themes you import:
//
//   • Fathom theme JSON
//       { "name": "My Theme",
//         "dark":  { "background": "#1e1e2e", "text": "#cdd6f4", "accent": "#cba6f7", … },
//         "light": { … } }                         ← either or both
//     Colours: background, window, hover, text, text2, text3, separator,
//     accent, success, warning, danger, folder. Only background and text are
//     needed; the rest are worked out from them.
//     Extras: "font": "vt323" (the bundled pixel-terminal font, set larger so
//     it reads) and "glow": true (CRT phosphor glow and faint scanlines).
//   • base16 schemes (YAML or JSON with base00 … base0F) — Solarized,
//     Tomorrow, Monokai, Ocean… there are hundreds.
//   • VS Code colour themes (the .json in an extension's themes/ folder).
//
// A theme only sets colour tokens from theme.css on <html>; everything else
// (sizes, fonts, glass) stays Fathom's — apart from the two extras above.

import { prefs, saveSettings } from "./settings.js";

// ---- colour maths ----
const hexRe = /^#?([0-9a-f]{3,8})$/i;
export function parseHex(c) {
  const m = hexRe.exec(String(c || "").trim()); if (!m) return null;
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join("");
  if (h.length !== 6 && h.length !== 8) return null;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
const toHex = (rgb) => "#" + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t); // t = share of b
const rgba = (rgb, a) => `rgba(${rgb.map(Math.round).join(", ")}, ${a})`;
const lum = (rgb) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; const [r, g, b] = rgb.map(f); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
export const isDark = (rgb) => lum(rgb) < 0.2;
/** Text colour that reads on a fill of colour c. */
export const onColour = (c) => (contrast(c, [255, 255, 255]) >= contrast(c, [20, 22, 26]) ? "#FFFFFF" : "#14161A");

// ---- built-in themes ----
export const BUILTIN = [
  { id: "solarized", name: "Solarized",
    dark: { background: "#002b36", window: "#00212b", hover: "#073642", text: "#93a1a1", text2: "#839496", text3: "#748a8e", accent: "#268bd2", success: "#859900", warning: "#b58900", danger: "#dc322f", folder: "#268bd2" },
    light: { background: "#fdf6e3", window: "#eee8d5", hover: "#f3ecd8", text: "#073642", text2: "#586e75", text3: "#5f747a", accent: "#1f6fa8", success: "#5f6e00", warning: "#8a6800", danger: "#b8221f", folder: "#268bd2" } },
  { id: "nord", name: "Nord",
    dark: { background: "#2e3440", window: "#242933", hover: "#3b4252", text: "#eceff4", text2: "#d8dee9", text3: "#a3acbe", accent: "#88c0d0", success: "#a3be8c", warning: "#ebcb8b", danger: "#bf616a", folder: "#81a1c1" },
    light: { background: "#eceff4", window: "#e5e9f0", hover: "#e2e7ef", text: "#2e3440", text2: "#3b4252", text3: "#4c566a", accent: "#5e81ac", success: "#4f6e3a", warning: "#8a6a1f", danger: "#a5464f", folder: "#5e81ac" } },
  { id: "dracula", name: "Dracula",
    dark: { background: "#282a36", window: "#21222c", hover: "#343746", text: "#f8f8f2", text2: "#c9cbd6", text3: "#a4a9c6", accent: "#bd93f9", success: "#50fa7b", warning: "#f1fa8c", danger: "#ff5555", folder: "#8be9fd" } },
  { id: "gruvbox", name: "Gruvbox",
    dark: { background: "#282828", window: "#1d2021", hover: "#3c3836", text: "#ebdbb2", text2: "#d5c4a1", text3: "#a89984", accent: "#fe8019", success: "#b8bb26", warning: "#fabd2f", danger: "#fb4934", folder: "#83a598" },
    light: { background: "#fbf1c7", window: "#f2e5bc", hover: "#f2e5bc", text: "#3c3836", text2: "#504945", text3: "#665c54", accent: "#af3a03", success: "#79740e", warning: "#b57614", danger: "#9d0006", folder: "#076678" } },
  { id: "catppuccin", name: "Catppuccin (Latte / Mocha)",
    dark: { background: "#1e1e2e", window: "#181825", hover: "#313244", text: "#cdd6f4", text2: "#bac2de", text3: "#a6adc8", accent: "#cba6f7", success: "#a6e3a1", warning: "#f9e2af", danger: "#f38ba8", folder: "#89b4fa" },
    light: { background: "#eff1f5", window: "#e6e9ef", hover: "#e6e9ef", text: "#4c4f69", text2: "#5c5f77", text3: "#6c6f85", accent: "#8839ef", success: "#40a02b", warning: "#df8e1d", danger: "#d20f39", folder: "#1e66f5" } },
  // ---- Fathom originals (every text colour checked for contrast, hover rows too) ----
  { id: "graphite", name: "Graphite",
    dark: { background: "#1f2124", window: "#17181a", hover: "#2a2d31", text: "#e6e8eb", text2: "#b9bec5", text3: "#9399a2", accent: "#5b9cf5", success: "#6cc48a", warning: "#e3b45a", danger: "#f0716b", folder: "#6fa8f7" },
    light: { background: "#f4f5f6", window: "#e9ebed", hover: "#e8eaed", text: "#1d1f22", text2: "#41464d", text3: "#5d636b", accent: "#2f6fd6", success: "#2e7d4a", warning: "#8a6410", danger: "#c0362f", folder: "#3d7ddb" } },
  { id: "midnight-ink", name: "Midnight Ink",
    dark: { background: "#141a26", window: "#0e131c", hover: "#1e2636", text: "#dde4f0", text2: "#aab5c8", text3: "#8692a8", accent: "#4fc3e8", success: "#5fd3a0", warning: "#f2c35b", danger: "#ff7a85", folder: "#5aa9f0" } },
  { id: "ember", name: "Ember",
    dark: { background: "#1f1a17", window: "#171310", hover: "#2b2420", text: "#efe4d8", text2: "#c9b9a8", text3: "#a5937f", accent: "#f0a04b", success: "#a9c46c", warning: "#f2c45a", danger: "#f07560", folder: "#e8a85c" } },
  { id: "evergreen", name: "Evergreen",
    dark: { background: "#18201c", window: "#111814", hover: "#222c27", text: "#dfe9e2", text2: "#afc0b5", text3: "#8ba093", accent: "#5fd0a0", success: "#7fd48a", warning: "#e6c565", danger: "#f07a74", folder: "#6cc6a8" } },
  // An old green-phosphor terminal: near-black glass, everything in greens
  // (selection becomes inverse video: dark text on bright green).
  { id: "phosphor", name: "Phosphor (green screen)",
    dark: { background: "#040b06", window: "#020503", hover: "#0b1a0f", separator: "#1f5a30", text: "#8dffa6", text2: "#4fdc78", text3: "#36b45d", accent: "#39ff6e", success: "#9dff7a", warning: "#d8ff5a", danger: "#ff6b57", folder: "#39ff6e", font: "vt323", glow: true } },
  { id: "amber", name: "Amber (amber screen)",
    dark: { background: "#0c0702", window: "#060301", hover: "#1c1206", separator: "#5a3a10", text: "#ffc670", text2: "#f0a53a", text3: "#c9862b", accent: "#ffb000", success: "#e6d36a", warning: "#ffe27a", danger: "#ff6a45", folder: "#ffb000", font: "vt323", glow: true } },
  { id: "aubergine", name: "Aubergine",
    dark: { background: "#211a26", window: "#19131d", hover: "#2c2333", text: "#ece3f1", text2: "#c4b6cf", text3: "#a090ad", accent: "#f07ab8", success: "#8fd49a", warning: "#f0c76a", danger: "#ff7b7b", folder: "#c39af2" } },
  { id: "harbour", name: "Harbour",
    dark: { background: "#1c2529", window: "#151c1f", hover: "#263136", text: "#e0eaed", text2: "#adbec4", text3: "#8a9da4", accent: "#3fc1c0", success: "#7ccf8e", warning: "#e8c160", danger: "#f27b72", folder: "#58b8d6" } },
  { id: "obsidian", name: "Obsidian (deep black)",
    dark: { background: "#0b0b0d", window: "#000000", hover: "#18181c", text: "#e8e8ec", text2: "#b4b4bd", text3: "#8c8c97", accent: "#a68cff", success: "#6fd68f", warning: "#f2c25c", danger: "#ff6b6b", folder: "#9d8cff" } },
  // ---- mid tones: easier on the eyes than light, less cave-like than dark ----
  { id: "dusk", name: "Dusk (mid, light text)",
    dark: { background: "#474d57", window: "#3c414a", hover: "#4f5560", text: "#f8f9fb", text2: "#dce0e6", text3: "#c9ced6", accent: "#8cc4ff", success: "#9fe0a8", warning: "#f5d27a", danger: "#ffaaa5", folder: "#9ccbff" } },
  { id: "stone", name: "Stone (mid, warm, light text)",
    dark: { background: "#4f4a45", window: "#43403b", hover: "#57524c", text: "#f8f4ee", text2: "#e2dbd1", text3: "#d2c9bd", accent: "#f2b872", success: "#b5dd8f", warning: "#f6d77f", danger: "#ffab9c", folder: "#f0bf7d" } },
  { id: "overcast", name: "Overcast (mid, dark text)",
    light: { background: "#b8bec7", window: "#aab1bb", hover: "#aeb5bf", text: "#15181d", text2: "#2b3038", text3: "#3a4049", accent: "#1d4f9e", success: "#1f5e33", warning: "#5c4307", danger: "#8f1f1a", folder: "#234f94" } },
  { id: "parchment-dim", name: "Parchment Dim (mid, warm, dark text)",
    light: { background: "#d3cbbd", window: "#c7bead", hover: "#c9c0b1", text: "#221d16", text2: "#3e372d", text3: "#52493d", accent: "#8a3f12", success: "#3d5a18", warning: "#6b4c06", danger: "#9a2318", folder: "#7a4a1c" } },
  { id: "sage-mist", name: "Sage Mist (soft light)",
    light: { background: "#e3e8e2", window: "#d8ded6", hover: "#d9dfd7", text: "#1b211c", text2: "#38423a", text3: "#4c574e", accent: "#2f7a55", success: "#2f7a40", warning: "#7d5b0c", danger: "#ad3127", folder: "#3a7f6a" } },
];

export const allThemes = () => [...BUILTIN, ...(Array.isArray(prefs.themes) ? prefs.themes : [])];
export const themeById = (id) => allThemes().find((t) => t.id === id) || null;
/** Themes that have a variant for this mode, as [id, name]. */
export const themesFor = (mode) => allThemes().filter((t) => t[mode]).map((t) => [t.id, t.name]);

// ---- turning a palette into theme.css tokens ----
const SET = new Set(); // tokens currently set inline on <html>

/** Token values for palette p in mode ("light" | "dark"), or null if unusable. */
export function tokens(p, mode) {
  const bg = parseHex(p.background), fg = parseHex(p.text);
  if (!bg || !fg) return null;
  const dark = mode === "dark";
  const c = (k, fallback) => { const v = parseHex(p[k]); return v ? toHex(v) : fallback; };
  const win = parseHex(p.window) || mix(bg, dark ? [0, 0, 0] : [0, 0, 0], dark ? 0.22 : 0.035);
  const accent = c("accent", null);
  const t = {
    "--content": toHex(bg),
    "--window": toHex(win),
    "--row-hover": c("hover", toHex(mix(bg, fg, 0.07))),
    "--text": toHex(fg),
    "--text2": c("text2", toHex(mix(fg, bg, 0.28))),
    "--text3": c("text3", toHex(mix(fg, bg, 0.38))),
    "--disabled": toHex(mix(fg, bg, 0.62)),
    "--separator": p.separator && parseHex(p.separator) ? rgba(parseHex(p.separator), 0.5) : rgba(fg, dark ? 0.09 : 0.08),
    "--edge": rgba(fg, dark ? 0.16 : 0.15),
    "--sel-quiet": rgba(fg, dark ? 0.12 : 0.09),
    "--glass-rgb": mix(win, bg, 0.3).map(Math.round).join(" "),
    "--cap-fill": dark ? rgba(fg, 0.07) : rgba(mix(bg, [255, 255, 255], 0.6), 0.75),
    "--cap-hi": dark ? rgba(fg, 0.10) : "rgba(255, 255, 255, 0.85)",
  };
  ["success", "warning", "danger"].forEach((k) => { const v = c(k, null); if (v) t["--" + k] = v; });
  const folder = c("folder", null); if (folder) t["--k-folder"] = folder;
  return { t, accent };
}

/** Put theme `id` (or none) on <html> for this mode; returns the theme's accent or null. */
export function applyTheme(root, id, mode) {
  const th = id ? themeById(id) : null;
  return applyPalette(root, th && th[mode], mode);
}

/** Put palette p (or none) on <html> for this mode; returns its accent or null.
 *  The theme maker uses this directly for its live preview. */
export function applyPalette(root, p, mode) {
  SET.forEach((k) => root.style.removeProperty(k)); SET.clear();
  const r = p ? tokens(p, mode) : null;
  root.toggleAttribute("data-color-theme", !!r);
  const font = r && p.font === "vt323" ? "vt323" : null;
  if (font) root.dataset.themeFont = font; else delete root.dataset.themeFont;
  root.toggleAttribute("data-theme-glow", !!(r && p.glow));
  try { localStorage.setItem("fathom-look-extras", JSON.stringify({ font, glow: !!(r && p.glow) })); } catch {}
  if (!r) return null;
  Object.entries(r.t).forEach(([k, v]) => { root.style.setProperty(k, v); SET.add(k); });
  return r.accent;
}

/** The theme / accent colours currently on <html>, as CSS text (painted early at the next launch). */
export const themeStyle = (root) => [...SET, "--accent", "--on-accent"].map((k) => [k, root.style.getPropertyValue(k)]).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("; ");

/** Set --accent (and the text on it) inline; null clears back to theme.css. */
export function setAccentInline(root, hex) {
  ["--accent", "--on-accent"].forEach((k) => root.style.removeProperty(k));
  const rgb = hex && parseHex(hex);
  if (!rgb) return;
  root.style.setProperty("--accent", toHex(rgb));
  root.style.setProperty("--on-accent", onColour(rgb));
}

// ---- importing ----
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "theme";
const stripJsonc = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/.*$/gm, "$1").replace(/,\s*([}\]])/g, "$1");

/** base16 palette (base00…base0F as hex) → our palette for its own mode. */
function fromBase16(b, name) {
  const lower = {}; Object.keys(b).forEach((k) => { lower[k.toLowerCase()] = b[k]; });
  const g = (k) => { const v = lower[k.toLowerCase()]; return v && parseHex(v) ? toHex(parseHex(v)) : null; };
  const bg = parseHex(g("base00")); if (!bg) throw new Error("No base00 colour found.");
  const mode = isDark(bg) ? "dark" : "light";
  const pal = { background: g("base00"), window: toHex(mix(bg, [0, 0, 0], mode === "dark" ? 0.22 : 0.035)), hover: g("base01"), text: g("base05"), text2: g("base04"), accent: g("base0D"), success: g("base0B"), warning: g("base0A"), danger: g("base08"), folder: g("base0D") };
  Object.keys(pal).forEach((k) => pal[k] == null && delete pal[k]);
  return { name: name || "base16 theme", [mode]: pal };
}

/** VS Code colour theme JSON → our palette. */
function fromVSCode(j) {
  const c = j.colors || {};
  const pick = (...ks) => { for (const k of ks) if (c[k] && parseHex(c[k])) return toHex(parseHex(c[k])); return null; };
  const background = pick("editor.background", "sideBar.background");
  if (!background) throw new Error("This VS Code theme has no editor colours (only syntax colours), so there's nothing to take.");
  const type = j.type === "light" || j.type === "hcLight" ? "light" : j.type === "dark" || j.type === "hc" || j.type === "hcDark" ? "dark" : isDark(parseHex(background)) ? "dark" : "light";
  const pal = {
    background, window: pick("sideBar.background", "activityBar.background", "editorGroupHeader.tabsBackground"),
    hover: pick("list.hoverBackground", "editor.lineHighlightBackground"),
    text: pick("editor.foreground", "foreground", "sideBar.foreground") || (type === "dark" ? "#d4d4d4" : "#333333"),
    text2: pick("descriptionForeground", "sideBarSectionHeader.foreground"),
    // The first candidate that stands out from the background (focusBorder is often a dull grey).
    accent: ["button.background", "activityBarBadge.background", "textLink.foreground", "focusBorder", "progressBar.background"]
      .map((k) => pick(k)).find((v) => v && contrast(parseHex(v), parseHex(background)) >= 2.5) || null,
    success: pick("terminal.ansiGreen", "gitDecoration.addedResourceForeground"),
    warning: pick("terminal.ansiYellow", "editorWarning.foreground"),
    danger: pick("terminal.ansiRed", "errorForeground", "editorError.foreground"),
    folder: pick("terminal.ansiBlue", "symbolIcon.folderForeground"),
  };
  Object.keys(pal).forEach((k) => pal[k] == null && delete pal[k]);
  return { name: j.name || "VS Code theme", [type]: pal };
}

/** Parse a theme file's text (any supported format). Returns { name, light?, dark? }. */
export function parseTheme(text, fileName = "") {
  const src = String(text || "").trim();
  if (!src) throw new Error("The theme is empty.");
  const baseName = fileName.replace(/^.*\//, "").replace(/\.(json|ya?ml|jsonc)$/i, "");
  let j = null;
  try { j = JSON.parse(stripJsonc(src)); } catch { j = null; }
  if (!j) {
    // base16 YAML: lines like  base00: "002b36"  (scheme: "Name")
    const b = {};
    src.split(/\r?\n/).forEach((l) => {
      const m = /^\s*["']?([A-Za-z0-9_-]+)["']?\s*:\s*(.*)$/.exec(l); if (!m) return;
      const k = m[1].toLowerCase(); let v = m[2].trim();
      const q = /^(["'])(.*?)\1/.exec(v); v = q ? q[2] : v.replace(/\s+#.*$/, "").trim();
      if (/^base0[0-9a-f]$/.test(k) || k === "scheme" || k === "name") b[k] = v;
    });
    if (b.base00) return fromBase16(b, b.scheme || b.name || baseName);
    throw new Error("That isn't a theme Fathom can read (Fathom JSON, base16 YAML / JSON, or a VS Code colour theme).");
  }
  if (j.palette && (j.palette.base00 || j.palette.base0D)) return fromBase16(j.palette, j.name || baseName);
  if (j.base00) return fromBase16(j, j.scheme || j.name || baseName);
  if (j.colors && typeof j.colors === "object" && (j.colors["editor.background"] || j.colors["sideBar.background"] || j.tokenColors)) return fromVSCode(j);
  if (j.light || j.dark) {
    const out = { name: j.name || baseName || "Imported theme" };
    ["light", "dark"].forEach((m) => { if (j[m] && j[m].background && j[m].text) out[m] = j[m]; });
    if (!out.light && !out.dark) throw new Error("A Fathom theme needs at least a background and text colour for light or dark.");
    return out;
  }
  if (j.background && j.text) { const m = isDark(parseHex(j.background) || [255, 255, 255]) ? "dark" : "light"; return { name: j.name || baseName || "Imported theme", [m]: j }; }
  throw new Error("That isn't a theme Fathom can read (Fathom JSON, base16 YAML / JSON, or a VS Code colour theme).");
}

/** Keep an imported theme (in settings.json). Returns its id. */
export function addTheme(th) {
  const list = Array.isArray(prefs.themes) ? prefs.themes : (prefs.themes = []);
  let id = "user-" + slug(th.name), n = 2;
  while (allThemes().some((t) => t.id === id)) id = "user-" + slug(th.name) + "-" + n++;
  list.push({ id, name: th.name, ...(th.light ? { light: th.light } : {}), ...(th.dark ? { dark: th.dark } : {}) });
  saveSettings();
  return id;
}
/** Replace a theme you made or imported (same id, so Preferences keeps pointing at it). */
export function updateTheme(id, th) {
  const list = Array.isArray(prefs.themes) ? prefs.themes : [];
  const i = list.findIndex((t) => t.id === id);
  if (i < 0) return addTheme(th);
  list[i] = { id, name: th.name, ...(th.light ? { light: th.light } : {}), ...(th.dark ? { dark: th.dark } : {}) };
  saveSettings();
  return id;
}

/** A theme as a Fathom theme file (what Import Theme reads back). */
export const themeFile = (th) => JSON.stringify({ name: th.name, ...(th.light ? { light: th.light } : {}), ...(th.dark ? { dark: th.dark } : {}) }, null, 2) + "\n";

// ---- palette fields (the theme maker's rows) ----
/** Palette keys, the token each becomes, and whether Fathom works it out when left empty. */
export const FIELDS = [
  ["background", "--content", "Background", "File lists, dialogs"],
  ["window", "--window", "Window", "Sidebar and toolbars, under the glass"],
  ["hover", "--row-hover", "Hover row", "The row under the pointer"],
  ["text", "--text", "Text", "Names and most text"],
  ["text2", "--text2", "Secondary text", "Labels, sizes, sidebar"],
  ["text3", "--text3", "Tertiary text", "Dates, notes, hints"],
  ["separator", "--separator", "Separator", "Lines between things"],
  ["accent", "--accent", "Accent", "Selection, buttons, focus"],
  ["folder", "--k-folder", "Folders", "Folder icons"],
  ["success", "--success", "Success", "Done, added, git clean"],
  ["warning", "--warning", "Warning", "Caution messages"],
  ["danger", "--danger", "Danger", "Errors, delete"],
];
export const REQUIRED = new Set(["background", "text"]);

/** A colour as #rrggbb, whatever CSS form it's in; rgba is laid over `under`. */
export function cssHex(v, under = [128, 128, 128]) {
  v = String(v || "").trim();
  const h = parseHex(v); if (h) return toHex(h);
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(v);
  if (!m) return null;
  let a = m[4] == null ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : +m[4];
  return toHex(mix(under, [+m[1], +m[2], +m[3]], a));
}

/** What every field looks like right now on <html> (theme, derived or Fathom's own). */
export function currentColours(root) {
  const cs = getComputedStyle(root);
  const bg = parseHex(cssHex(cs.getPropertyValue("--content"))) || [128, 128, 128];
  const out = {};
  FIELDS.forEach(([k, v]) => { out[k] = cssHex(cs.getPropertyValue(v), bg); });
  return out;
}

export function removeTheme(id) {
  prefs.themes = (prefs.themes || []).filter((t) => t.id !== id);
  if (prefs.lightTheme === id) prefs.lightTheme = "";
  if (prefs.darkTheme === id) prefs.darkTheme = "";
  saveSettings();
}
