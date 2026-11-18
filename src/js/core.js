// Shared plumbing: the Tauri bridge, tiny DOM/format helpers, icons, storage,
// and the one `app` object every module reads and writes.

const T = window.__TAURI__;
export const invoke = T ? T.core.invoke : null;
export const dialog = T ? T.dialog : null;
export const listen = T && T.event ? T.event.listen : null;

/** Global UI state. Panes live inside tabs; `active` is the focused pane of the current tab. */
export const app = {
  home: "",
  tabs: [],          // [{ id, view: "single"|"twin", panes: [Pane, Pane], active: Pane }]
  tab: null,         // current tab
  active: null,      // active pane (always one of app.tab.panes)
  clip: null,        // { paths, cut }
  dragData: null,    // { paths, dirs, source }
  showHidden: false,
  folderShelf: true, // sub-folders as a horizontal strip above the files
  sidebar: true,
  dockPreview: false,
  previewOpen: false,
  // Wired up by main.js so modules can notify without importing each other in circles.
  hooks: {
    changed: () => {},   // a pane's selection/contents changed
    navigated: () => {}, // a pane moved to another folder
    save: () => {},      // something worth persisting changed
  },
};

export const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

export const fmtSize = (b, isDir) => {
  if (isDir) return "—";
  if (b < 1024) return b + " B";
  const u = ["KB", "MB", "GB", "TB"];
  let n = b / 1024, i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (n >= 10 ? n.toFixed(0) : n.toFixed(1)) + " " + u[i];
};

export const fmtDate = (secs) => {
  if (!secs) return "—";
  const d = new Date(secs * 1000), p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const baseName = (p) => (p === "/" ? "/" : p.replace(/\/+$/, "").split("/").pop());
export const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** localStorage that never throws (private mode, blocked storage…). */
export const store = {
  get(k, d) {
    try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
  },
};

// 20×20 line icons, stroked with currentColor.
const ICONS = {
  home: '<path d="M3.5 9.5L10 4l6.5 5.5"/><path d="M5.5 8v7.75h9V8"/>',
  desktop: '<rect x="2.75" y="3.75" width="14.5" height="10" rx="1.5"/><path d="M7 16.75h6M10 13.75v3"/>',
  documents: '<path d="M5.5 2.75h6l3 3v11.5h-9z"/><path d="M11.5 2.75v3h3M7.75 10h4.5M7.75 13h4.5"/>',
  downloads: '<path d="M10 3v10M6 9.5l4 4 4-4"/><path d="M4 16.5h12"/>',
  pictures: '<rect x="2.75" y="4" width="14.5" height="12" rx="2"/><circle cx="7.5" cy="8.5" r="1.4"/><path d="M3 14l4.5-3.5 3 2.5 2.5-2 4 3"/>',
  applications: '<rect x="3" y="3" width="5.5" height="5.5" rx="1.3"/><rect x="11.5" y="3" width="5.5" height="5.5" rx="1.3"/><rect x="3" y="11.5" width="5.5" height="5.5" rx="1.3"/><rect x="11.5" y="11.5" width="5.5" height="5.5" rx="1.3"/>',
  folder: '<path d="M2.75 5.5A1.5 1.5 0 0 1 4.25 4h3.5l1.75 2h6.25a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H4.25a1.5 1.5 0 0 1-1.5-1.5z"/>',
  drive: '<rect x="2.75" y="6" width="14.5" height="8" rx="2"/><path d="M5.5 11h4"/><circle cx="14" cy="10" r="0.9" fill="currentColor"/>',
  eject: '<path d="M10 4.5l5 6H5z"/><path d="M5 14.75h10"/>',
  cloud: '<path d="M6 15.5h8.5a3.25 3.25 0 0 0 .3-6.49A4.75 4.75 0 0 0 5.6 8.6 3.45 3.45 0 0 0 6 15.5z"/>',
  folderFill: '<path d="M2 5.4A1.9 1.9 0 0 1 3.9 3.5h3.9l2 2.1h6.3A1.9 1.9 0 0 1 18 7.5v7.6a1.9 1.9 0 0 1-1.9 1.9H3.9A1.9 1.9 0 0 1 2 15.1z" fill="currentColor" stroke="none"/><path d="M2.6 8.1h14.8" stroke="rgba(0,0,0,0.22)" stroke-width="1"/>',
  shelf: '<rect x="3" y="3.5" width="4" height="4" rx="1"/><rect x="8" y="3.5" width="4" height="4" rx="1"/><rect x="13" y="3.5" width="4" height="4" rx="1"/><path d="M3 11.5h14M3 15h14"/>',
  plus: '<path d="M10 4v12M4 10h12"/>',
  close: '<path d="M5 5l10 10M15 5L5 15"/>',
};

export function icon(name) {
  const NS = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", "0 0 20 20");
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "1.5");
  s.setAttribute("stroke-linecap", "round");
  s.setAttribute("stroke-linejoin", "round");
  s.innerHTML = ICONS[name] || ICONS.folder;
  return s;
}
