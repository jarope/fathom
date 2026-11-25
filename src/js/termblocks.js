// Command blocks in the terminal panel (Warp-style, via OSC 133 marks from
// the shell integration in src-tauri/shell): a rule above each prompt, failed
// commands marked with their exit status (and in the scrollbar), ⌘↑ / ⌘↓ to
// jump between commands, and Copy Command / Copy Output / Select Output for
// the block under the pointer (right-click) or the last one (⇧⌘C).
//
// Each block holds xterm markers, which track their line as output scrolls
// and are disposed when it falls out of the scrollback.

let term = null, blocks = [], cur = null;

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const live = (m) => m && !m.isDisposed && m.line >= 0;

export const hasBlocks = () => prune().length > 0;

function prune() {
  blocks = blocks.filter((b) => live(b.a));
  return blocks;
}

/** Hook the OSC 133 marks. Call once per Terminal. */
export function attachBlocks(t) {
  term = t; blocks = []; cur = null;
  term.parser.registerOscHandler(133, (data) => {
    const [kind, arg] = data.split(";");
    const buf = term.buffer.active;
    if (kind === "A") {
      cur = { a: term.registerMarker(0) };
      if (!cur.a) { cur = null; return true; }
      blocks.push(cur);
      rule(cur);
    } else if (cur && kind === "B") {
      cur.b = term.registerMarker(0); cur.bx = buf.cursorX;
    } else if (cur && kind === "C") {
      cur.c = term.registerMarker(0);
    } else if (cur && kind === "D" && cur.c) {
      cur.d = term.registerMarker(0); cur.dx = buf.cursorX;
      cur.exit = Number(arg) || 0;
      if (cur.exit) failed(cur);
    }
    return true;
  });
}

/** The shell was restarted: forget everything. */
export function resetBlocks() { blocks = []; cur = null; }

// A hairline above each prompt, so each command and its output read as one block.
function rule(b) {
  if (blocks.length < 2) return; // nothing above the first prompt
  const d = term.registerDecoration({ marker: b.a, layer: "bottom", overviewRulerOptions: { color: css("--text3") || "#888", position: "left" } });
  d?.onRender((el) => { el.classList.add("tb-rule"); el.style.width = "100%"; });
}

// A failed command: its prompt line gets a red edge and an "exit n" tag, and a red tick in the scrollbar.
function failed(b) {
  const red = css("--danger") || css("--red") || "#e5534b";
  const d = term.registerDecoration({ marker: b.a, layer: "top", overviewRulerOptions: { color: red, position: "full" } });
  d?.onRender((el) => {
    el.classList.add("tb-fail"); el.style.width = "100%";
    if (!el.firstChild) { const tag = document.createElement("span"); tag.className = "tb-exit"; tag.textContent = `exit ${b.exit}`; el.append(tag); }
  });
}

// ── reading text back ──────────────────────────────────────────────────────

function text(y0, x0, y1, x1) {
  const buf = term.buffer.active, out = [];
  for (let y = y0; y <= y1; y++) {
    const line = buf.getLine(y); if (!line) continue;
    const s = line.translateToString(true, y === y0 ? x0 : 0, y === y1 && x1 != null ? x1 : undefined);
    if (line.isWrapped && out.length) out[out.length - 1] += s; else out.push(s);
  }
  return out.map((l) => l.trimEnd()).join("\n");
}

/** Line range of a block's output, or null (still running / nothing printed). */
function outputRange(b) {
  if (!live(b.c)) return null;
  const buf = term.buffer.active;
  let end;
  if (live(b.d)) end = b.dx > 0 ? b.d.line : b.d.line - 1;
  else end = buf.baseY + buf.cursorY - (buf.cursorX > 0 ? 0 : 1); // still running: up to the cursor
  return end >= b.c.line ? [b.c.line, end] : null;
}

export function commandText(b) {
  if (!b) return "";
  const end = live(b.c) ? b.c.line - 1 : b.a.line;
  if (live(b.b)) return text(b.b.line, b.bx, Math.max(b.b.line, end)).trim();
  return text(b.a.line, 0, Math.max(b.a.line, end)).trim(); // no B mark: the whole prompt line
}

export function outputText(b) {
  const r = b && outputRange(b);
  return r ? text(r[0], 0, r[1]).replace(/\n+$/, "") : "";
}

export function selectOutput(b) {
  const r = b && outputRange(b); if (!r) return false;
  term.selectLines(r[0], r[1]);
  return true;
}

/** The block containing buffer line `y` (or the last finished one when y is omitted). */
export function blockAt(y) {
  const list = prune();
  if (y == null) { for (let i = list.length - 1; i >= 0; i--) if (live(list[i].c)) return list[i]; return null; }
  let hit = null;
  for (const b of list) { if (b.a.line <= y) hit = b; else break; }
  return hit;
}

/** Buffer line under a mouse event in the terminal. */
export function lineAt(ev) {
  const scr = term.element?.querySelector(".xterm-screen"); if (!scr) return null;
  const r = scr.getBoundingClientRect();
  const row = Math.floor((ev.clientY - r.top) / (r.height / term.rows));
  return term.buffer.active.viewportY + Math.max(0, Math.min(term.rows - 1, row));
}

// ── jumping ────────────────────────────────────────────────────────────────

/** ⌘↑ / ⌘↓: put the previous / next prompt at the top of the panel. */
export function jump(dir) {
  const list = prune(); if (!list.length) return false;
  const top = term.buffer.active.viewportY;
  let target = null;
  if (dir < 0) { for (const b of list) if (b.a.line < top) target = b; }
  else target = list.find((b) => b.a.line > top) || null;
  if (!target) { if (dir > 0) term.scrollToBottom(); return true; }
  term.scrollToLine(target.a.line);
  flash(target);
  return true;
}

function flash(b) {
  const d = term.registerDecoration({ marker: b.a, layer: "bottom" });
  d?.onRender((el) => { el.classList.add("tb-flash"); el.style.width = "100%"; });
  setTimeout(() => d?.dispose(), 700);
}
