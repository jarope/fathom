// Preferences, kept in ~/.config/fathom/settings.json (hand-editable).
// Window toggles that predate this file (hidden files, shelf, sidebar, zoom)
// stay where they were; Preferences just shows them too.

import { app, invoke } from "./core.js";

export const DEFAULTS = {
  startup: "restore",   // "restore" the last tabs, or open "folder"
  startFolder: "",      // used when startup = "folder" ("" = Home)
  dateFormat: "iso",    // "iso" | "locale" | "relative"
  terminal: "Terminal", // Terminal | iTerm | Ghostty | Warp
  theme: "",            // "system" | "light" | "dark" ("" until first run picks one)
  accent: "system",     // "system" (macOS accent) | orange | indigo | teal | graphite
  glass: 80,            // glass opacity, 50–100 (100 = solid)
  columns: { show: ["size", "modified"], widths: {} }, // details view columns (Name is always on)
  shortcuts: {},        // command id -> ["Cmd+KeyT", …] (only the ones you changed)
};

export const prefs = { ...DEFAULTS, shortcuts: {} };
export let settingsProblem = null; // shown in Preferences if the file is broken

export async function loadSettings() {
  if (!invoke) return;
  try {
    const text = await invoke("config_read", { name: "settings.json" });
    if (text) {
      const s = JSON.parse(text);
      Object.keys(DEFAULTS).forEach((k) => { if (s[k] !== undefined) prefs[k] = s[k]; });
      if (!prefs.shortcuts || typeof prefs.shortcuts !== "object") prefs.shortcuts = {};
    }
  } catch (e) {
    settingsProblem = `settings.json couldn't be read (${e}). Using defaults; saving a change will rewrite it.`;
  }
  app.dateFormat = prefs.dateFormat;
}

let saving = Promise.resolve();
/** Write the whole file (queued, so quick changes never interleave). */
export function saveSettings() {
  app.dateFormat = prefs.dateFormat;
  settingsProblem = null;
  saving = saving.then(() => invoke && invoke("config_write", { name: "settings.json", text: JSON.stringify(prefs, null, 2) + "\n" })).catch((e) => {
    app.active && app.active.flash("⚠ Couldn't save settings: " + e, "warn");
  });
  return saving;
}
