// Locations: a local path ("/Users/me") or a server folder
// ("sftp://<conn>/<absolute path>", where <conn> is an ~/.ssh/config alias or
// user@host[:port]; "sftp://<conn>" alone is your login folder there).
// Pure string helpers, mirroring src-tauri/src/remote/mod.rs.

export const SCHEME = "sftp://";

export const isRemote = (p) => typeof p === "string" && p.startsWith(SCHEME);

/** "sftp://box/home/me" → { conn: "box", path: "/home/me" } (path null = login folder). */
export function parseRemote(p) {
  if (!isRemote(p)) return null;
  const rest = p.slice(SCHEME.length), i = rest.indexOf("/");
  const conn = i < 0 ? rest : rest.slice(0, i);
  return conn ? { conn, path: i < 0 ? null : rest.slice(i) } : null;
}

export const connOf = (p) => (parseRemote(p) || {}).conn || null;
export const remoteUrl = (conn, path = "") => SCHEME + conn + path;

/** The top of p's file system: "/" or "sftp://conn/". */
export const rootOf = (p) => (isRemote(p) ? remoteUrl(connOf(p), "/") : "/");

/** Parent location, or null at the top. */
export function parentOf(p) {
  const r = parseRemote(p);
  const path = r ? r.path || "/" : p;
  if (path === "/") return null;
  const t = path.replace(/\/+$/, ""), i = t.lastIndexOf("/");
  const up = i <= 0 ? "/" : t.slice(0, i);
  return r ? remoteUrl(r.conn, up) : up;
}

export const join = (dir, name) => (dir.endsWith("/") ? dir + name : dir + "/" + name);

/** Is p inside (or equal to) dir? */
export const isUnder = (p, dir) => p === dir || p.startsWith(dir.endsWith("/") ? dir : dir + "/");

/** Same file system (same server, or both local)? */
export const sameFs = (a, b) => connOf(a) === connOf(b);

/** A server's name as shown: the alias, or "host" for user@host[:port]. */
export function serverLabel(conn) {
  const at = conn.lastIndexOf("@");
  const h = at >= 0 ? conn.slice(at + 1) : conn;
  return h.replace(/:\d+$/, "");
}

/** Breadcrumbs: [{ path, label }] from the top down. */
export function crumbs(p) {
  const r = parseRemote(p);
  const path = r ? r.path || "/" : p;
  const parts = path.split("/").filter(Boolean);
  const mk = (sub) => (r ? remoteUrl(r.conn, sub) : sub);
  const out = [{ path: mk("/"), label: r ? serverLabel(r.conn) : "/" }];
  parts.forEach((name, i) => out.push({ path: mk("/" + parts.slice(0, i + 1).join("/")), label: name }));
  return out;
}

/** Display name of a folder (window title, tab, menus). */
export function displayName(p) {
  const r = parseRemote(p);
  if (r) { const path = r.path || "/"; return path === "/" ? serverLabel(r.conn) : path.split("/").filter(Boolean).pop(); }
  return p === "/" ? "Macintosh HD" : p.split("/").filter(Boolean).pop() || p;
}

/** What works here. Servers have no Bin, Spotlight, Quick Look, tags, git… */
export function caps(p) {
  const local = !isRemote(p);
  return {
    trash: local, quickLook: local, thumbs: local, spotlight: local, search: local, git: local,
    terminal: local, tags: local, usage: local, infoExtras: local, pasteboard: local,
    nativeDrag: local, openWith: local, reveal: local, share: local, actions: local,
    archive: local, duplicate: local, templates: local,
    write: true, open: true,
  };
}

/** Something the user typed in ⌘L or Connect to Server → a location, or null.
 *  Accepts sftp://…, ssh://…, user@host:path and user@host. */
export function fromTyped(v) {
  v = v.trim();
  let m = v.match(/^(?:sftp|ssh):\/\/([^/]+)(\/.*)?$/i);
  if (m) return remoteUrl(m[1], m[2] || "");
  m = v.match(/^([^\s/@:]+@[^\s/:]+)(?::(\/.*|~.*|))?$/); // user@host or user@host:/path
  if (m) { const p = m[2] || ""; return remoteUrl(m[1], p.startsWith("/") ? p : ""); }
  return null;
}
