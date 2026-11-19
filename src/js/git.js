// Git: coloured rows + badges for the folder on screen, the branch chip in
// the status bar, and a simple Commit… / Push. Anything fancier stays in
// the user's own git tools.

import { app, invoke, el, plural, baseName } from "./core.js";
import { showMenu } from "./menu.js";
import { modal } from "./dialog.js";
import { busyCard } from "./jobs.js";
import { visiblePanes } from "./tabs.js";

const BADGE = { modified: "M", staged: "S", new: "U", conflict: "!", ignored: "" };
const WORD = { modified: "Modified", staged: "Staged", new: "Untracked (new)", conflict: "Conflict", ignored: "Ignored by git" };
const STATES = Object.keys(BADGE);

/** Fetch git status for P's folder, then badge its rows and status bar. */
export async function loadGit(P) {
  const seq = (P.gitSeq = (P.gitSeq || 0) + 1);
  if (!invoke || !P.cwd || P.mode !== "browse") { P.git = null; return; }
  const dir = P.cwd;
  let g = null;
  try { g = await invoke("git_status", { dir }); } catch { g = null; }
  if (seq !== P.gitSeq || dir !== P.cwd) return; // navigated meanwhile
  const had = !!P.git;
  P.git = g;
  applyGit(P);
  if (g || had) P.renderStatus();
}

export const refreshGitAll = () => visiblePanes().forEach(loadGit);

const stateOf = (P, e) => (P.git ? P.git.all || P.git.files[e.name] || null : null);

/** Colour + badge each visible row (cheap; also run after every re-render). */
export function applyGit(P) {
  const on = P.git && P.mode === "browse";
  P.els.listing.querySelectorAll(".row").forEach((r) => {
    const e = P.entries[+r.dataset.i]; if (!e) return;
    const s = on ? stateOf(P, e) : null;
    STATES.forEach((k) => r.classList.toggle("g-" + k, s === k));
    let b = r.querySelector(".gb");
    if (!s || !BADGE[s]) { if (b) b.remove(); return; }
    if (!b) {
      b = el("span", "gb");
      const host = r.querySelector(".c-name") || r;
      const nm = host.querySelector(".nm");
      nm ? nm.after(b) : host.append(b);
    }
    b.textContent = BADGE[s];
    b.title = WORD[s];
  });
}

/** "⎇ main ↑2 ↓1 · 3 changed" for the status bar (null outside a repo). */
export function gitChip(P) {
  const g = P.git; if (!g || P.mode !== "browse") return null;
  const c = el("button", "gchip"); c.type = "button";
  c.append(el("span", "gbr", `⎇ ${g.branch || g.oid || "no commits"}`));
  if (g.ahead) c.append(el("span", "gup", ` ↑${g.ahead}`));
  if (g.behind) c.append(el("span", "gdn", ` ↓${g.behind}`));
  if (g.changes) c.append(el("span", "gch", ` · ${g.changes} changed`));
  c.title = `${g.root}${g.upstream ? `\nTracking ${g.upstream}` : "\nNo upstream yet — Push sets it"}${g.ahead ? `\n${plural(g.ahead, "commit")} to push` : ""}${g.behind ? `\n${plural(g.behind, "commit")} to pull` : ""}`;
  c.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const r = c.getBoundingClientRect();
    showMenu(gitMenu(P), r.left, r.top - 150);
  });
  return c;
}

/** Entries for the Git ▸ sub-menu and the status-bar chip. */
export function gitMenu(P) {
  const g = P.git; if (!g) return [];
  return [
    { heading: `${g.branch || g.oid || "no commits"} · ${baseName(g.root)}` },
    { label: g.changes ? `Commit… (${g.changes} changed)` : "Commit…", fn: () => commitDialog(P), disabled: !g.changes },
    { label: g.ahead ? `Push ${plural(g.ahead, "commit")}` : g.upstream ? "Push" : "Push (sets upstream)", fn: () => push(P) },
    "sep",
    { label: "Refresh git status", fn: () => loadGit(P) },
  ];
}

// ---- Commit ----
export async function commitDialog(P) {
  const g = P.git; if (!g) return;
  let changes;
  try { changes = await invoke("git_changes", { root: g.root }); }
  catch (e) { P.flash("⚠ " + e, "warn"); return; }
  if (!changes.length) { P.flash("Nothing to commit"); loadGit(P); return; }

  // Pre-tick what's selected (files, or changes inside selected folders); else everything.
  const prefix = g.prefix || "";
  const sel = P.selectedEntries().map((e) => prefix + e.name);
  const picked = (c) => sel.some((s) => c.path === s || c.path.startsWith(s + "/") || c.orig === s);
  const any = sel.length && changes.some(picked);

  const body = el("div", "gc");
  body.append(el("div", "modal-lead", `On ${g.branch ? `branch “${g.branch}”` : "a detached HEAD"} in ${g.root}`));
  const bar = el("div", "gc-bar");
  const count = el("span", "gc-count");
  const all = el("button", "mbtn small", "All"), none = el("button", "mbtn small", "None");
  all.type = none.type = "button";
  bar.append(count, all, none);
  const list = el("div", "gc-list");
  const boxes = changes.map((c) => {
    const row = el("label", "gc-row g-" + c.state);
    const cb = el("input"); cb.type = "checkbox"; cb.checked = any ? picked(c) : true;
    const slash = c.path.lastIndexOf("/");
    const p = el("span", "gc-path");
    if (slash >= 0) p.append(el("span", "gc-dir", c.path.slice(0, slash + 1)));
    p.append(el("span", null, c.path.slice(slash + 1)));
    if (c.orig) p.append(el("span", "gc-dir", `  ← ${c.orig}`));
    const b = el("span", "gb", BADGE[c.state] || "?"); b.title = WORD[c.state] || c.xy;
    row.append(cb, b, p);
    row.title = `${WORD[c.state] || ""} (${c.xy})`;
    list.append(row);
    return cb;
  });
  const msg = el("textarea", "gc-msg"); msg.placeholder = "Commit message"; msg.rows = 3; msg.spellcheck = true;
  body.append(bar, list, msg, el("div", "modal-note", "Only the ticked files are committed. ⌘⏎ commits."));
  const update = () => { const n = boxes.filter((b) => b.checked).length; count.textContent = `${n} of ${plural(changes.length, "file")}`; };
  boxes.forEach((b) => b.addEventListener("change", update));
  all.addEventListener("click", () => { boxes.forEach((b) => (b.checked = true)); update(); });
  none.addEventListener("click", () => { boxes.forEach((b) => (b.checked = false)); update(); });
  update();

  let result = null;
  const buttons = [{ label: "Cancel", value: null }, { label: "Commit & Push", value: "push" }, { label: "Commit", value: "commit", primary: true }];
  msg.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.metaKey) { e.preventDefault(); buttons[2].node.click(); }
  });
  const choice = await modal({
    title: "Commit", body, wide: true, focus: msg, buttons,
    onSubmit: async () => {
      const paths = [];
      changes.forEach((c, i) => { if (boxes[i].checked) { paths.push(c.path); if (c.orig) paths.push(c.orig); } });
      if (!paths.length) return "Tick at least one file";
      if (!msg.value.trim()) { msg.focus(); return "Write a commit message"; }
      buttons.forEach((b) => (b.node.disabled = true));
      try { result = await invoke("git_commit", { root: g.root, paths, message: msg.value.trim() }); }
      catch (e) { buttons.forEach((b) => (b.node.disabled = false)); return String(e); }
      return null;
    },
  });
  if (!choice) return;
  P.flash(`Committed ${result}`);
  await Promise.all(visiblePanes().map(loadGit));
  if (choice === "push") push(P);
}

// ---- Push ----
export async function push(P) {
  const g = P.git; if (!g) return;
  const close = busyCard(`Pushing ${g.branch || "HEAD"}`, g.upstream ? `to ${g.upstream}` : baseName(g.root));
  let out, err = null;
  try { out = await invoke("git_push", { root: g.root }); } catch (e) { err = String(e); }
  close();
  if (err) {
    const body = el("div");
    body.append(el("div", "modal-lead", `git push in ${g.root} said:`), el("pre", "gc-out", err));
    modal({ title: "Push failed", body, wide: true, buttons: [{ label: "OK", value: true, primary: true }] });
  } else {
    const line = (out || "").split("\n").map((l) => l.trim()).find((l) => l.includes("->")) || (out || "").split("\n").pop() || "";
    P.flash(/up-to-date/i.test(out) ? "Already up to date" : `Pushed${line ? " · " + line : ""}`);
  }
  await Promise.all(visiblePanes().map(loadGit));
}

export function initGit() {
  // Commits made in a terminal or editor show up when you come back.
  window.addEventListener("focus", refreshGitAll);
}
