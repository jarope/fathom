// Appearance: light/dark, the accent colour, glass opacity, and the macOS
// accessibility settings (Reduce Transparency, Increase Contrast). Resolves
// Preferences → macOS → defaults and puts the result on <html> for theme.css.

import { app, invoke } from "./core.js";
import { prefs, saveSettings } from "./settings.js";
import { applyTheme, setAccentInline, themeById, themeStyle } from "./themes.js";

export const ACCENTS = ["orange", "indigo", "teal", "graphite"]; // the in-app choices
// macOS AppleAccentColor → our tuned palette (see theme.css). No value = Multicolour → Orange.
const MAC_ACCENT = { "-1": "graphite", 0: "red", 1: "orange", 2: "yellow", 3: "green", 4: "blue", 5: "purple", 6: "pink" };

let sys = { accent: null, reduce_transparency: false, increase_contrast: false };
const darkMQ = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
let osDark = darkMQ ? darkMQ.matches : true;
const win = () => window.__TAURI__?.window?.getCurrentWindow?.();

export const systemAccent = () => (sys.accent == null ? "orange" : MAC_ACCENT[sys.accent] || "orange");
export const resolvedTheme = () => (prefs.theme === "light" || prefs.theme === "dark" ? prefs.theme : osDark ? "dark" : "light");

let lastWinTheme;
export function applyAppearance() {
  const root = document.documentElement;
  const theme = resolvedTheme();
  const named = ACCENTS.includes(prefs.accent), custom = /^#[0-9a-f]{6}$/i.test(prefs.accent || "");
  const accent = named ? prefs.accent : systemAccent();
  root.setAttribute("data-theme", theme);
  root.setAttribute("data-accent", accent);
  // Colour theme for this mode, then the accent: a colour you picked wins,
  // else the theme's own accent, else macOS's.
  const themeAccent = applyTheme(root, theme === "dark" ? prefs.darkTheme : prefs.lightTheme, theme);
  setAccentInline(root, custom ? prefs.accent : !named && themeAccent ? themeAccent : null);
  try { localStorage.setItem("fathom-look", theme + " " + accent); } catch {}
  // Reduce Transparency / Increase Contrast (System Settings) make it solid whatever the slider says.
  const g = sys.reduce_transparency || sys.increase_contrast ? 100 : Math.min(100, Math.max(20, Number(prefs.glass) || 80));
  root.style.setProperty("--glass-a", String(g / 100));
  try { localStorage.setItem("fathom-look-style", themeStyle(root)); } catch {}
  root.classList.toggle("rt", !!sys.reduce_transparency);
  root.classList.toggle("hc", !!sys.increase_contrast);
  // Keep the native window (sidebar vibrancy, traffic lights) in the same
  // appearance. "system" hands control back to macOS.
  const wt = prefs.theme === "light" || prefs.theme === "dark" ? prefs.theme : null;
  if (wt !== lastWinTheme) {
    lastWinTheme = wt;
    const w = win();
    if (w && w.setTheme) w.setTheme(wt).catch(() => {});
  }
}

async function readSystem() {
  if (!invoke) return;
  try { sys = await invoke("appearance"); } catch {}
}

export async function initAppearance() {
  // The pre-Preferences theme lived in localStorage; carry it over once.
  if (!prefs.theme) {
    let old = null;
    try { old = localStorage.getItem("fathom-theme"); } catch {}
    prefs.theme = old === "light" || old === "dark" ? old : "system";
    if (old) { try { localStorage.removeItem("fathom-theme"); } catch {} saveSettings(); }
  }
  await readSystem();
  applyAppearance();
  if (darkMQ) darkMQ.addEventListener("change", (e) => {
    // While the window is pinned to light/dark, this reports that, not macOS.
    if (prefs.theme === "system") { osDark = e.matches; applyAppearance(); }
  });
  // Accent and accessibility changes happen in System Settings, so look
  // again whenever Fathom comes back to the front.
  window.addEventListener("focus", async () => { await readSystem(); applyAppearance(); });
}

/** Header button: flip between light and dark (pins the choice). */
export function toggleTheme() {
  prefs.theme = resolvedTheme() === "dark" ? "light" : "dark";
  saveSettings();
  applyAppearance();
}

/** Called when Preferences switches back to "Match the system". */
export function followSystem() {
  prefs.theme = "system";
  // matchMedia is stale while the window was pinned; ask again once macOS has the window back.
  applyAppearance();
  setTimeout(() => { if (darkMQ) osDark = darkMQ.matches; applyAppearance(); }, 120);
}

// Paint the last look straight away, before settings load, so there's no flash.
{
  let look = null;
  try { look = localStorage.getItem("fathom-look"); } catch {}
  const [t, a] = (look || "").split(" ");
  document.documentElement.setAttribute("data-theme", t === "light" || t === "dark" ? t : osDark ? "dark" : "light");
  if (a) document.documentElement.setAttribute("data-accent", a);
  let st = null;
  try { st = localStorage.getItem("fathom-look-style"); } catch {}
  if (st) st.split(";").forEach((d) => { const i = d.indexOf(":"); if (i > 0) document.documentElement.style.setProperty(d.slice(0, i).trim(), d.slice(i + 1).trim()); }); // theme colours, custom accent
  let ex = null;
  try { ex = JSON.parse(localStorage.getItem("fathom-look-extras") || "null"); } catch {}
  if (ex && ex.font) document.documentElement.dataset.themeFont = ex.font; // theme font / glow
  if (ex && ex.glow) document.documentElement.setAttribute("data-theme-glow", "");
}

/** What the accent currently follows, for Preferences. */
export function accentSource() {
  if (/^#[0-9a-f]{6}$/i.test(prefs.accent || "")) return "custom";
  if (ACCENTS.includes(prefs.accent)) return "named";
  const th = themeById(resolvedTheme() === "dark" ? prefs.darkTheme : prefs.lightTheme);
  const p = th && th[resolvedTheme()];
  return p && p.accent ? "theme:" + th.name : "system";
}
