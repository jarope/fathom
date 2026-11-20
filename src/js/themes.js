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
//   • base16 schemes (YAML or JSON with base00 … base0F) — Solarized,
//     Tomorrow, Monokai, Ocean… there are hundreds.
//   • VS Code colour themes (the .json in an extension's themes/ folder).
//
// A theme only sets colour tokens from theme.css on <html>; everything else
// (sizes, fonts, glass) stays Fathom's.

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
  SET.forEach((k) => root.style.removeProperty(k)); SET.clear();
  const th = id ? themeById(id) : null;
  const p = th && th[mode];
  const r = p ? tokens(p, mode) : null;
  root.toggleAttribute("data-color-theme", !!r);
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
export function removeTheme(id) {
  prefs.themes = (prefs.themes || []).filter((t) => t.id !== id);
  if (prefs.lightTheme === id) prefs.lightTheme = "";
  if (prefs.darkTheme === id) prefs.darkTheme = "";
  saveSettings();
}
