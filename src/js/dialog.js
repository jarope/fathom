// Modal dialogs: a small generic modal, the "item already exists" conflict
// dialog, and the batch-rename dialog with live preview.

import { app, el, fmtSize, fmtDate, baseName, plural } from "./core.js";

/**
 * Generic modal. `buttons`: [{ label, value, primary?, danger? }].
 * `onSubmit(value)` may return an error string to keep the dialog open.
 * Resolves with the chosen value, or null on Esc / Cancel.
 */
export function modal({ title, body, buttons, wide = false, onSubmit = null, focus = null, enterSubmits = true }) {
  return new Promise((resolve) => {
    const wrap = el("div", "modal-wrap");
    const box = el("div", "modal" + (wide ? " wide" : ""));
    const err = el("div", "modal-err");
    const btns = el("div", "modal-btns");
    const h = el("h2", null, title); h.id = "mt" + Math.random().toString(36).slice(2, 8);
    box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); box.setAttribute("aria-labelledby", h.id);
    err.setAttribute("role", "alert");
    box.append(h, body, err, btns);
    wrap.append(box);
    document.body.append(wrap);
    app.modalOpen = true;

    const close = (v) => {
      document.removeEventListener("keydown", onKey, true);
      wrap.remove();
      app.modalOpen = false;
      resolve(v);
    };
    const choose = async (b) => {
      if (b.value == null) return close(null);
      if (onSubmit) {
        const problem = await onSubmit(b.value);
        if (problem) { err.textContent = "⚠ " + problem; return; }
      }
      close(b.value);
    };
    buttons.forEach((b) => {
      const n = el("button", "mbtn" + (b.primary ? " primary" : "") + (b.danger ? " danger" : ""), b.label);
      n.type = "button";
      n.addEventListener("click", () => choose(b));
      b.node = n;
      btns.append(n);
    });
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(null); }
      else if (e.key === "Enter" && !(e.target && e.target.tagName === "TEXTAREA") && (enterSubmits || !/^(INPUT|SELECT)$/.test(e.target.tagName))) {
        const p = buttons.find((b) => b.primary);
        if (p && !p.node.disabled) { e.preventDefault(); e.stopPropagation(); choose(p); }
      }
    };
    document.addEventListener("keydown", onKey, true);
    wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) close(null); });
    (focus ? focus : btns.querySelector(".primary") || btns.lastChild)?.focus();
    modal.setEnabled = (on) => { const p = buttons.find((b) => b.primary); if (p) p.node.disabled = !on; };
  });
}

// ---------------------------------------------------------------------------
// "Item already exists" — per-item choice, plus apply-to-all.
// ---------------------------------------------------------------------------

const LABELS = { keep: "Keep both", replace: "Replace", skip: "Skip", merge: "Merge" };

/** Resolves to { [srcPath]: policy } or null if cancelled. */
export async function resolveConflicts(conflicts, destDir, copy) {
  const choice = new Map(conflicts.map((c) => [c.src, c.src_is_dir && c.dst_is_dir ? "merge" : "keep"]));
  const body = el("div", "cf");
  body.append(el("p", "modal-lead",
    `${conflicts.length === 1 ? "An item" : conflicts.length + " items"} with the same name already exist${conflicts.length === 1 ? "s" : ""} in “${baseName(destDir)}”.`));

  const list = el("div", "cf-list");
  const segs = [];
  const side = (label, size, mod, isDir, newer) => {
    const s = el("span", "cf-side" + (newer ? " newer" : ""));
    s.append(el("b", null, label + " "), el("span", null, (isDir ? "folder" : fmtSize(size, false)) + " · " + fmtDate(mod)));
    if (newer) s.append(el("em", null, " newer"));
    return s;
  };
  conflicts.forEach((c) => {
    const row = el("div", "cf-row");
    const info = el("div", "cf-info");
    info.append(el("div", "cf-name", c.name));
    const meta = el("div", "cf-meta");
    meta.append(
      side("Existing", c.dst_size, c.dst_modified, c.dst_is_dir, (c.dst_modified || 0) > (c.src_modified || 0)),
      side(copy ? "Copying" : "Moving", c.src_size, c.src_modified, c.src_is_dir, (c.src_modified || 0) > (c.dst_modified || 0)),
    );
    info.append(meta);
    const seg = el("div", "seg");
    const opts = c.src_is_dir && c.dst_is_dir ? ["merge", "keep", "replace", "skip"] : ["keep", "replace", "skip"];
    opts.forEach((o) => {
      const b = el("button", "seg-b", LABELS[o]); b.type = "button"; b.dataset.v = o;
      b.addEventListener("click", () => { choice.set(c.src, o); paint(); });
      seg.append(b);
    });
    segs.push([c, seg]);
    row.append(info, seg);
    list.append(row);
  });
  const paint = () => segs.forEach(([c, seg]) => seg.querySelectorAll(".seg-b").forEach((b) => b.classList.toggle("on", b.dataset.v === choice.get(c.src))));
  paint();
  body.append(list);

  if (conflicts.length > 1) {
    const all = el("div", "cf-all");
    all.append(el("span", null, "Apply to all:"));
    ["keep", "replace", "skip"].forEach((o) => {
      const b = el("button", "mbtn small", LABELS[o]); b.type = "button";
      b.addEventListener("click", () => { conflicts.forEach((c) => choice.set(c.src, o === "keep" && c.src_is_dir && c.dst_is_dir ? "merge" : o)); paint(); });
      all.append(b);
    });
    body.append(all);
  }
  body.append(el("p", "modal-note", "Replaced items go to the Bin — nothing is deleted. Merge combines folders; clashing files inside are kept as “… copy”."));

  const ok = await modal({
    title: copy ? "Copy — items already exist" : "Move — items already exist",
    body, wide: true,
    buttons: [{ label: "Cancel", value: null }, { label: "Continue", value: "go", primary: true }],
  });
  return ok ? Object.fromEntries(choice) : null;
}

// ---------------------------------------------------------------------------
// Batch rename — Replace · Add · Number · Case, with a live preview.
// ---------------------------------------------------------------------------

const splitExt = (name, isDir) => {
  const i = name.lastIndexOf(".");
  return !isDir && i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ""];
};
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s_\-.(\[])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());

/**
 * entries: selected entries in on-screen order. `apply(items)` performs the
 * rename and returns an error string or null. Resolves true when done.
 */
export async function batchRenameDialog(entries, apply) {
  const st = { mode: "replace", find: "", repl: "", regex: false, matchCase: false, text: "", where: "after", base: "", start: 1, digits: 0, kase: "lower" };
  const body = el("div", "br");

  const tabs = el("div", "seg wide");
  [["replace", "Replace text"], ["add", "Add text"], ["number", "Number"], ["case", "Change case"]].forEach(([v, l]) => {
    const b = el("button", "seg-b", l); b.type = "button"; b.dataset.v = v;
    b.addEventListener("click", () => { st.mode = v; paintTabs(); fields(); update(); });
    tabs.append(b);
  });
  const paintTabs = () => tabs.querySelectorAll(".seg-b").forEach((b) => b.classList.toggle("on", b.dataset.v === st.mode));
  const form = el("div", "br-form");
  const preview = el("div", "br-preview");
  const summary = el("div", "br-sum");
  body.append(tabs, form, summary, preview);

  const input = (label, key, opts = {}) => {
    const w = el("label", "br-field");
    w.append(el("span", null, label));
    const i = el("input"); i.type = opts.type || "text"; i.spellcheck = false; i.value = st[key];
    if (opts.placeholder) i.placeholder = opts.placeholder;
    if (opts.min != null) i.min = opts.min;
    i.addEventListener("input", () => { st[key] = opts.type === "number" ? +i.value || 0 : i.value; update(); });
    w.append(i);
    return w;
  };
  const check = (label, key) => {
    const w = el("label", "br-check");
    const i = el("input"); i.type = "checkbox"; i.checked = st[key];
    i.addEventListener("change", () => { st[key] = i.checked; update(); });
    w.append(i, el("span", null, label));
    return w;
  };
  const select = (label, key, options) => {
    const w = el("label", "br-field");
    w.append(el("span", null, label));
    const s = el("select");
    options.forEach(([v, l]) => { const o = el("option", null, l); o.value = v; if (st[key] === v) o.selected = true; s.append(o); });
    s.addEventListener("change", () => { st[key] = s.value; update(); });
    w.append(s);
    return w;
  };
  let firstInput = null;
  function fields() {
    form.innerHTML = "";
    if (st.mode === "replace") {
      form.append(input("Find", "find", { placeholder: "text to find" }), input("Replace with", "repl", { placeholder: "(nothing)" }));
      const row = el("div", "br-row"); row.append(check("Regular expression", "regex"), check("Match case", "matchCase"));
      form.append(row);
    } else if (st.mode === "add") {
      form.append(input("Text", "text", { placeholder: "e.g. 2026-11 " }), select("Where", "where", [["before", "Before the name"], ["after", "After the name"]]));
    } else if (st.mode === "number") {
      form.append(input("Name", "base", { placeholder: "e.g. Photo (blank keeps each name)" }), input("Start at", "start", { type: "number", min: 0 }), input("Digits", "digits", { type: "number", min: 0, placeholder: "auto" }));
    } else {
      form.append(select("Case", "kase", [["lower", "lowercase"], ["upper", "UPPERCASE"], ["title", "Title Case"]]));
    }
    firstInput = form.querySelector("input, select");
    if (firstInput) setTimeout(() => firstInput.focus(), 0);
  }

  const compute = () => {
    let re = null, reErr = null;
    if (st.mode === "replace" && st.find) {
      try { re = st.regex ? new RegExp(st.find, st.matchCase ? "g" : "gi") : new RegExp(st.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), st.matchCase ? "g" : "gi"); }
      catch (e) { reErr = "Bad pattern: " + e.message; }
    }
    const pad = st.digits > 0 ? st.digits : String(st.start + entries.length - 1).length;
    const out = entries.map((e, idx) => {
      const [stem, ext] = splitExt(e.name, e.is_dir);
      let n = e.name;
      if (st.mode === "replace") n = re ? e.name.replace(re, st.repl) : e.name;
      else if (st.mode === "add") n = st.where === "before" ? st.text + e.name : stem + st.text + ext;
      else if (st.mode === "number") {
        const num = String(st.start + idx).padStart(pad, "0");
        n = (st.base.trim() ? st.base.trim() + " " : stem + " ") + num + ext;
      } else n = (st.kase === "upper" ? stem.toUpperCase() : st.kase === "title" ? titleCase(stem) : stem.toLowerCase()) + ext;
      return { e, n: n.trim() };
    });
    const counts = new Map();
    out.forEach((o) => counts.set(o.n.toLowerCase(), (counts.get(o.n.toLowerCase()) || 0) + 1));
    out.forEach((o) => {
      if (!o.n) o.err = "empty name";
      else if (o.n.includes("/")) o.err = "contains “/”";
      else if (o.n === "." || o.n === "..") o.err = "reserved";
      else if (counts.get(o.n.toLowerCase()) > 1) o.err = "duplicate";
    });
    return { out, reErr };
  };

  let last = [];
  function update() {
    const { out, reErr } = compute();
    last = out;
    preview.innerHTML = "";
    out.slice(0, 300).forEach((o) => {
      const r = el("div", "br-item" + (o.err ? " bad" : o.n === o.e.name ? " same" : ""));
      r.append(el("span", "br-old", o.e.name), el("span", "br-arrow", "→"), el("span", "br-new", o.n || "∅"));
      if (o.err) r.append(el("span", "br-err", o.err));
      preview.append(r);
    });
    const changed = out.filter((o) => o.n !== o.e.name && !o.err).length;
    const bad = out.filter((o) => o.err).length;
    summary.textContent = reErr || (bad ? `${plural(bad, "problem")} to fix` : `${plural(changed, "item")} will be renamed`);
    summary.className = "br-sum" + (reErr || bad ? " bad" : "");
    modal.setEnabled && modal.setEnabled(!reErr && !bad && changed > 0);
  }

  paintTabs(); fields();
  const p = modal({
    title: `Rename ${plural(entries.length, "item")}`,
    body, wide: true,
    buttons: [{ label: "Cancel", value: null }, { label: "Rename", value: "go", primary: true }],
    onSubmit: () => apply(last.filter((o) => o.n !== o.e.name).map((o) => [o.e.path, o.n])),
  });
  update();
  return !!(await p);
}
