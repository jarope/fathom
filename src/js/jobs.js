// Background jobs (copy, move, duplicate, compress, extract): the backend
// streams `job-progress` and finishes with `job-done`. Jobs that take more
// than a moment get a card (bottom-right) with progress, speed, time left
// and Cancel. Quick ones never flash a card.

import { invoke, listen, el, fmtSize } from "./core.js";

const running = new Map(); // id -> job
const early = new Map();   // job-done that arrived before we started waiting
let box;

export async function initJobs() {
  box = document.getElementById("jobs");
  if (!listen) return;
  await listen("job-progress", (e) => {
    const j = running.get(e.payload.id); if (!j) return;
    if (!j.last || j.last.phase !== e.payload.phase) { j.phaseStart = performance.now(); j.phaseBytes = e.payload.done_bytes; }
    j.last = e.payload;
    if (j.card) render(j);
  });
  await listen("job-done", (e) => {
    const d = e.payload, j = running.get(d.id);
    if (!j) { early.set(d.id, d); return; }
    finish(j, d);
  });
}

/**
 * Start a backend job command and wait for it to finish.
 * Resolves to { report, cancelled }.
 */
export async function runJob(cmd, args, label) {
  const id = await invoke(cmd, args);
  return new Promise((resolve) => {
    if (early.has(id)) { const d = early.get(id); early.delete(id); resolve(d); return; }
    const j = { id, label, resolve, card: null, last: null, phaseStart: performance.now(), phaseBytes: 0, cancelling: false };
    running.set(id, j);
    j.timer = setTimeout(() => show(j), 350);
  });
}

function finish(j, d) {
  running.delete(j.id);
  clearTimeout(j.timer);
  if (j.card) j.card.remove();
  box.classList.toggle("show", box.childElementCount > 0);
  j.resolve(d);
}

function show(j) {
  if (!running.has(j.id)) return;
  const c = el("div", "job");
  const top = el("div", "job-top");
  const x = el("button", "job-x", "✕"); x.type = "button"; x.title = "Cancel";
  x.addEventListener("click", () => { j.cancelling = true; render(j); invoke("cancel_job", { id: j.id }).catch(() => {}); });
  top.append(el("span", "job-label", j.label), x);
  const bar = el("div", "job-bar"); bar.append(el("i"));
  c.append(top, bar, el("div", "job-meta"), el("div", "job-cur"));
  j.card = c;
  box.append(c); box.classList.add("show");
  render(j);
}

const fmtTime = (s) => (s < 60 ? `${Math.max(1, Math.round(s))} s` : s < 3600 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);

function render(j) {
  const p = j.last, c = j.card;
  const bar = c.querySelector(".job-bar"), fill = bar.querySelector("i");
  const meta = c.querySelector(".job-meta"), cur = c.querySelector(".job-cur");
  if (j.cancelling) { meta.textContent = "Cancelling…"; bar.classList.add("indet"); return; }
  if (!p || p.phase === "scan") { meta.textContent = "Preparing…"; bar.classList.add("indet"); cur.textContent = ""; return; }

  let frac = null;
  if (p.total_bytes > 0) frac = p.done_bytes / p.total_bytes;
  else if (p.total_items > 0 && p.phase !== "zip" && p.phase !== "unzip") frac = p.done_items / p.total_items;
  bar.classList.toggle("indet", frac == null);
  if (frac != null) fill.style.width = (Math.min(1, frac) * 100).toFixed(1) + "%";

  const secs = (performance.now() - j.phaseStart) / 1000;
  const rate = secs > 0.5 ? (p.done_bytes - j.phaseBytes) / secs : 0;
  const parts = [];
  if (p.total_bytes > 0) {
    parts.push(`${fmtSize(p.done_bytes, false)} of ${fmtSize(p.total_bytes, false)}`);
    if (rate > 0) {
      parts.push(`${fmtSize(rate, false)}/s`);
      parts.push(`about ${fmtTime((p.total_bytes - p.done_bytes) / rate)} left`);
    }
  } else if (p.phase === "zip") {
    parts.push(`${fmtSize(p.done_bytes, false)} written`);
  } else if (p.total_items > 0) {
    parts.push(`${Math.min(p.done_items, p.total_items).toLocaleString()} of ${p.total_items.toLocaleString()} items`);
  } else {
    parts.push("Working…");
  }
  meta.textContent = parts.join(" · ");
  cur.textContent = p.current || "";
}

/** A card with an indeterminate bar for work without progress (git push…). Returns close(). */
export function busyCard(label, detail = "", onCancel = null) {
  const c = el("div", "job");
  const top = el("div", "job-top"); top.append(el("span", "job-label", label));
  if (onCancel) {
    const x = el("button", "job-x", "✕"); x.type = "button"; x.title = "Cancel";
    x.addEventListener("click", () => { x.disabled = true; c.querySelector(".job-meta").textContent = "Cancelling…"; onCancel(); });
    top.append(x);
  }
  const bar = el("div", "job-bar indet"); bar.append(el("i"));
  c.append(top, bar, el("div", "job-meta", detail));
  box.append(c); box.classList.add("show");
  return () => { c.remove(); box.classList.toggle("show", box.childElementCount > 0); };
}
