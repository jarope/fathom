// Servers (SFTP): the saved list in the sidebar, which are connected, and
// ssh's questions (password, new host key, key passphrase) as dialogs.
// Browsing itself goes through list_dir with sftp:// locations (loc.js).

import { app, invoke, listen, el, store } from "./core.js";
import { modal } from "./dialog.js";
import { remoteUrl, connOf, serverLabel, isRemote } from "./loc.js";

const KEY = "fathom-sftp-servers";
const connected = new Set();
let onChange = () => {};

/** Saved servers: [{ conn }] in the order added. */
export const servers = () => store.get(KEY, []);
export const isConnected = (conn) => connected.has(conn);

export function addServer(conn) {
  if (servers().some((s) => s.conn === conn)) return;
  store.set(KEY, [...servers(), { conn }]);
  onChange();
}

/** Open a server in pane P (logging in, with prompts if needed). */
export async function openServer(conn, P = app.active) {
  addServer(conn);
  if (P) return P.navigate(remoteUrl(conn));
}

const panesOn = (conn) => app.tabs.flatMap((t) => t.panes).filter((p) => p.cwd && connOf(p.cwd) === conn);

export async function disconnectServer(conn) {
  await invoke("sftp_disconnect", { conn }).catch(() => {});
  panesOn(conn).forEach((p) => p.offline(p.cwd, null));
}

export async function forgetServer(conn) {
  const ok = await modal({
    title: `Forget ${serverLabel(conn)}?`,
    body: el("div", "modal-lead", "It leaves the sidebar, and a password saved in the Keychain for it is deleted. Your ~/.ssh/config isn't touched."),
    buttons: [{ label: "Cancel", value: null }, { label: "Forget", value: true, primary: true, danger: true }],
  });
  if (!ok) return;
  await invoke("sftp_forget", { conn }).catch(() => {});
  connected.delete(conn);
  store.set(KEY, servers().filter((s) => s.conn !== conn));
  panesOn(conn).forEach((p) => p.navigate(app.home));
  onChange();
}

/** Hosts in ~/.ssh/config not yet in the sidebar. */
export async function configHosts() {
  const have = new Set(servers().map((s) => s.conn));
  try { return (await invoke("sftp_config_hosts")).filter((h) => !have.has(h)); } catch { return []; }
}

// ---- ssh's questions ----

const TITLES = { host: "New server", password: "Password", passphrase: "Key passphrase", text: "Server question" };

async function answerPrompt(p) {
  const name = serverLabel(p.conn);
  if (p.kind === "notice") { if (app.active) app.active.flash(p.prompt.split("\n")[0]); return; }
  const body = el("div", "sftp-ask");
  let input = null, remember = null;
  if (p.kind === "host") {
    body.append(el("div", "modal-lead", `Fathom hasn't connected to ${name} before. Check the fingerprint with whoever runs the server if you can; once you trust it, ssh remembers it in ~/.ssh/known_hosts.`));
    const pre = el("pre", "sftp-fp", p.prompt.replace(/\s*Are you sure you want to continue connecting.*$/s, "").trim());
    body.append(pre);
  } else {
    body.append(el("div", "modal-lead", p.prompt));
    input = el("input", "sftp-in");
    input.type = p.kind === "text" ? "text" : "password";
    input.autocomplete = "off"; input.spellcheck = false;
    body.append(input);
    if (p.kind === "password") {
      const l = el("label", "pf-check"); remember = el("input"); remember.type = "checkbox";
      l.append(remember, document.createTextNode(" Remember in Keychain"));
      body.append(l);
    }
  }
  const ok = await modal({
    title: `${TITLES[p.kind] || "Server"} — ${name}`,
    body, focus: input,
    buttons: [{ label: "Cancel", value: null }, { label: p.kind === "host" ? "Trust and Connect" : "OK", value: true, primary: true }],
  });
  const answer = !ok ? null : p.kind === "host" ? "yes" : input.value;
  invoke("sftp_prompt_reply", { id: p.id, answer, remember: !!(remember && remember.checked) }).catch(() => {});
}

// Prompts arrive one at a time per server, but two servers could ask at once.
let chain = Promise.resolve();

export async function initRemote(changed) {
  onChange = changed || onChange;
  if (!listen) return;
  try { (await invoke("sftp_connected")).forEach((c) => connected.add(c)); } catch {}
  await listen("sftp-prompt", (e) => { chain = chain.then(() => answerPrompt(e.payload)).catch(() => {}); });
  await listen("sftp-state", (e) => {
    const { conn, state } = e.payload;
    const was = connected.has(conn);
    if (state === "ready") connected.add(conn); else if (state !== "connecting") connected.delete(conn);
    if (was !== connected.has(conn)) onChange();
  });
}

/** For menus: "Servers" destinations etc. */
export const serverEntries = (fn) => servers().map((s) => ({ label: serverLabel(s.conn), icon: "network", fn: () => fn(s.conn) }));
export { isRemote };
