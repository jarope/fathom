// Terminal panel (F4, Dolphin's Konsole panel): your login shell under the
// files, drawn by xterm.js (src/vendor/xterm). It follows the active pane:
// moving to a folder types `cd` into the shell when it's waiting at its
// prompt, and a `cd` typed in the shell moves the pane. Height is
// remembered; drag the top edge to resize.

import { app, invoke, listen, store } from "./core.js";

let term = null, fit = null, id = 0, panel = null, host = null;
let lastShellDir = "", followTimer = 0, exited = false, ro = null;
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

export const terminalOpen = () => !!panel && !panel.hidden;
/** The terminal's text (what's on screen plus scrollback), for tests and copying. */
export const terminalText = () => { if (!term) return ""; const b = term.buffer.active, out = []; for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true)); return out.join("\n").trimEnd(); };

function theme() {
  const bg = css("--content") || "#1e1e1e", fg = css("--text") || "#ddd";
  return { background: bg, foreground: fg, cursor: css("--accent") || fg, cursorAccent: bg, selectionBackground: css("--sel-quiet") || "rgba(128,128,128,0.35)" };
}

async function start() {
  const { Terminal } = await import("../vendor/xterm/xterm.js");
  const { FitAddon } = await import("../vendor/xterm/addon-fit.js");
  // xterm measures the font once, so make sure Fathom's bundled one has loaded.
  try { await document.fonts.load('12px "JetBrains Mono"'); } catch {}
  term = new Terminal({
    fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace', fontSize: 12, lineHeight: 1.15,
    cursorBlink: true, allowProposedApi: false, scrollback: 5000, macOptionIsMeta: true,
    minimumContrastRatio: 3, // ANSI colours stay readable on light themes too
    theme: theme(),
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  fit.fit();
  // ⌘K clears, as in Terminal.app; Fathom's own shortcuts don't fire while typing here.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === "keydown" && e.metaKey && e.code === "KeyK") { term.clear(); return false; }
    // Hand the panel's own toggle (⌃` / F4) and ⌘-shortcuts back to Fathom.
    if ((e.ctrlKey && e.code === "Backquote") || e.code === "F4") return false;
    return true;
  });
  term.onData((d) => {
    if (exited) { exited = false; term.reset(); spawn(); return; }
    if (id) invoke("term_write", { id, data: d }).catch(() => {});
  });
  term.onResize(({ cols, rows }) => { if (id) invoke("term_resize", { id, cols, rows }).catch(() => {}); });
  if (listen) {
    const dec = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await listen("term-data", (e) => {
      if (e.payload.id !== id) return;
      term.write(dec(e.payload.data));
      clearTimeout(followTimer); followTimer = setTimeout(followShell, 250);
    });
    await listen("term-exit", (e) => {
      if (e.payload !== id) return;
      id = 0; exited = true;
      term.write("\r\n\x1b[2m[The shell ended. Press any key for a new one.]\x1b[0m\r\n");
    });
  }
  // Re-colour when the theme changes (appearance sets inline tokens on <html>).
  new MutationObserver(() => { if (term) term.options.theme = theme(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
  ro = new ResizeObserver(() => { if (terminalOpen()) { try { fit.fit(); } catch {} } });
  ro.observe(host);
  await spawn();
}

async function spawn() {
  const P = app.active;
  const cwd = (P && P.cwd) || app.home;
  try { id = await invoke("term_open", { cwd, cols: term.cols, rows: term.rows }); lastShellDir = cwd; }
  catch (e) { term.write(`\r\n\x1b[31m${e}\x1b[0m\r\n`); }
}

/** A `cd` typed in the shell: take the active pane there too. */
async function followShell() {
  if (!id || !terminalOpen()) return;
  let dir = null;
  try { dir = await invoke("term_cwd", { id }); } catch {}
  if (!dir || dir === lastShellDir) return;
  lastShellDir = dir;
  const P = app.active;
  if (P && P.cwd !== dir) P.navigate(dir);
}

/** The active pane moved: `cd` the shell there (only if it's at its prompt). */
export async function followPane(P) {
  if (!id || !terminalOpen() || !P || P !== app.active || !P.cwd || P.mode !== "browse") return;
  if (P.cwd === lastShellDir) return;
  let did = false;
  try { did = await invoke("term_cd", { id, path: P.cwd }); } catch {}
  if (did) lastShellDir = P.cwd;
}

/** F4: show / hide (the shell keeps running while hidden). */
export async function toggleTerminal(force) {
  if (!panel) init();
  const show = force === undefined ? panel.hidden : force;
  panel.hidden = !show;
  store.set("fathom-terminal", show);
  if (!show) { if (app.active) app.active.els.listing.focus(); return; }
  if (!term) await start();
  else { try { fit.fit(); } catch {} followPane(app.active); }
  term.focus();
}

function init() {
  panel = document.getElementById("termPanel");
  host = panel.querySelector(".term-host");
  const h = +store.get("fathom-terminal-h", 220);
  panel.style.height = Math.max(90, h) + "px";
  // Drag the top edge to resize.
  panel.querySelector(".term-grip").addEventListener("mousedown", (e) => {
    e.preventDefault();
    const y0 = e.clientY, h0 = panel.offsetHeight;
    const move = (ev) => { panel.style.height = Math.min(window.innerHeight * 0.75, Math.max(90, h0 + (y0 - ev.clientY))) + "px"; };
    const up = () => { removeEventListener("mousemove", move); removeEventListener("mouseup", up); store.set("fathom-terminal-h", panel.offsetHeight); };
    addEventListener("mousemove", move); addEventListener("mouseup", up);
  });
}

/** On launch: reopen if it was open last time. */
export function initTerminal() {
  if (store.get("fathom-terminal", false)) toggleTerminal(true);
}
