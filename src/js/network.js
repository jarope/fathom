// Recent places (the last folders you were in, from the sidebar's Recent
// item) and Connect to Server (⌘K): smb:// afp:// nfs:// or WebDAV, mounted
// by macOS with its own login prompt and Keychain, then opened in the pane.

import { app, invoke, el, store, baseName } from "./core.js";
import { modal } from "./dialog.js";
import { showMenu } from "./menu.js";
import { openTab } from "./tabs.js";
import { fromTyped, parseRemote } from "./loc.js";
import { addServer, configHosts } from "./remote.js";

const MAX_RECENT = 15, MAX_SERVERS = 10;
const tidy = (p) => (p === "/" ? "Macintosh HD" : app.home && (p === app.home || p.startsWith(app.home + "/")) ? "~" + p.slice(app.home.length) : p);

// ---- Recent places ----
export function recordRecent(P) {
  if (!P || !P.cwd || P.mode !== "browse") return;
  const list = store.get("fathom-recent-places", []).filter((p) => p !== P.cwd);
  list.unshift(P.cwd);
  store.set("fathom-recent-places", list.slice(0, MAX_RECENT));
}

/** The Recent menu (from the sidebar). ⌘-click opens in a new tab. */
export function recentMenu(x, y) {
  const P = app.active;
  const list = store.get("fathom-recent-places", []).filter((p) => !P || p !== P.cwd);
  showMenu(list.length ? [
    { heading: "Recent folders" },
    ...list.map((p) => ({ label: p === "/" ? "Macintosh HD" : baseName(p), icon: "folder", key: tidy(p.slice(0, p.lastIndexOf("/")) || "/"),
      fn: (ev) => (ev && ev.metaKey ? openTab(p) : P && P.navigate(p)) })),
    "sep",
    { label: "Clear Recent", fn: () => store.set("fathom-recent-places", []) },
  ] : [{ heading: "No recent folders yet" }], x, y);
}

// ---- Connect to Server ----
export async function connectToServer() {
  const P = app.active;
  const servers = store.get("fathom-servers", []);
  const body = el("div", "srv");
  const input = el("input", "srv-url");
  input.placeholder = "smb://server/share"; input.spellcheck = false; input.autocomplete = "off";
  input.value = servers[0] || "";
  body.append(el("div", "modal-lead", "SFTP (sftp://host, user@host, or a host from ~/.ssh/config), SMB (Windows, NAS), AFP, NFS or WebDAV (https://). You'll be asked for a password if the server needs one."), input);
  // Hosts from ~/.ssh/config, one click to fill in.
  configHosts().then((hosts) => {
    if (!hosts.length) return;
    const row = el("div", "srv-hosts");
    row.append(el("span", "srv-h", "From ~/.ssh/config"));
    hosts.slice(0, 20).forEach((h) => { const b = el("button", "chip", h); b.type = "button"; b.addEventListener("click", () => { input.value = "sftp://" + h; input.focus(); }); row.append(b); });
    input.after(row);
  });
  if (servers.length) {
    const list = el("div", "srv-list");
    servers.forEach((s) => {
      const row = el("div", "srv-row");
      const go = el("button", "srv-go", s); go.type = "button";
      go.addEventListener("click", () => { input.value = s; input.focus(); });
      const x = el("button", "srv-x", "✕"); x.type = "button"; x.title = "Forget";
      x.addEventListener("click", () => { store.set("fathom-servers", store.get("fathom-servers", []).filter((v) => v !== s)); row.remove(); });
      row.append(go, x); list.append(row);
    });
    body.append(el("div", "srv-h", "Recent servers"), list);
  }
  const status = el("div", "srv-status");
  body.append(status);
  let mounted = null, sftp = null;
  const ok = await modal({
    title: "Connect to Server",
    body,
    focus: input,
    buttons: [{ label: "Cancel", value: null }, { label: "Connect", value: true, primary: true }],
    onSubmit: async () => {
      const url = input.value.trim();
      if (!url) return "Type a server address.";
      // SFTP: log in from the pane (its own prompts), not inside this dialog.
      const r = fromTyped(url);
      if (r) { sftp = r; store.set("fathom-servers", [url, ...store.get("fathom-servers", []).filter((v) => v !== url)].slice(0, MAX_SERVERS)); return null; }
      status.textContent = "Connecting…"; modal.setEnabled(false);
      try { mounted = await invoke("connect_server", { url }); }
      catch (e) { status.textContent = ""; modal.setEnabled(true); return String(e); }
      store.set("fathom-servers", [url, ...store.get("fathom-servers", []).filter((v) => v !== url)].slice(0, MAX_SERVERS));
      return null;
    },
  });
  if (ok && sftp) {
    const { conn } = parseRemote(sftp);
    addServer(conn);
    if (P && (await P.navigate(sftp))) P.flash(`Connected · ${conn}`);
    return;
  }
  if (!ok || !mounted) return;
  const { loadPlaces } = await import("./sidebar.js");
  await loadPlaces();
  if (P) { await P.navigate(mounted); P.flash(`Connected · ${baseName(mounted)}`); }
}
