// Preview data: raster thumbnails via the backend, SVG natively, video via
// macOS Quick Look. Results are cached per (size, path).

import { invoke, fmtSize } from "./core.js";

const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const VIDEO_RE = /\.(mov|mp4|m4v|avi|mkv|webm|mpg|mpeg|3gp|wmv|flv)$/i;
export const isImage = (name) => IMG_RE.test(name);
export const isSvg = (name) => /\.svg$/i.test(name);
export const isVideo = (name) => VIDEO_RE.test(name);
export const isPreviewable = (name) => isImage(name) || isVideo(name);

const thumbCache = new Map(); // "max|path" -> Promise<{data,w,h}|null>
const svgCache = new Map();   // path -> Promise<{data,w,h}|null>
const qlCache = new Map();    // "max|path" -> Promise<{data,w,h}|null>

function getThumb(path, max) {
  const key = max + "|" + path;
  if (!thumbCache.has(key)) thumbCache.set(key, invoke("thumbnail", { path, maxEdge: max }).catch(() => null));
  return thumbCache.get(key);
}
function getSvg(path) {
  if (!svgCache.has(path)) svgCache.set(path, invoke("svg_data_uri", { path }).then((d) => ({ data: d, w: null, h: null })).catch(() => null));
  return svgCache.get(path);
}
function getQL(path, max) {
  const key = max + "|" + path;
  if (!qlCache.has(key)) qlCache.set(key, invoke("ql_thumbnail", { path, maxEdge: max }).catch(() => null));
  return qlCache.get(key);
}

/** SVG bypasses the rasterizer (vector); video goes through Quick Look; else a thumbnail. */
export const getPreview = (path, name, max) => (isSvg(name) ? getSvg(path) : isVideo(name) ? getQL(path, max) : getThumb(path, max));
export const dimText = (t, size) => (t.w ? `${t.w} × ${t.h} · ` : "") + fmtSize(size, false);
