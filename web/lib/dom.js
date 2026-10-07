// Small DOM helpers shared by components. No framework: templates are strings parsed once into <template>s.
export { css } from "./styles.js";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape text for interpolation into HTML strings. */
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

/**
 * Tagged template that escapes interpolations unless wrapped in raw().
 * Returns a string; pass it to frag() or assign to innerHTML.
 */
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => {
    if (Array.isArray(v)) out += v.map((x) => (x instanceof Raw ? x.s : esc(x))).join("");
    else out += v instanceof Raw ? v.s : esc(v);
    out += strings[i + 1];
  });
  return new Raw(out);
}
class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
/** Mark a string as trusted HTML for html``. */
export const raw = (s) => new Raw(String(s));

/** Parse an HTML string (or html`` result) into a DocumentFragment. */
export function frag(markup) {
  const t = document.createElement("template");
  t.innerHTML = String(markup);
  return t.content;
}

/** Cached <template> from a static string: define once per component, clone per instance. */
export function template(markup) {
  const t = document.createElement("template");
  t.innerHTML = String(markup);
  return t;
}

export const $ = (root, sel) => root.querySelector(sel);
export const $$ = (root, sel) => [...root.querySelectorAll(sel)];

/** 75.3 -> "1:15", 3.25 -> "0:03" */
export function fmtClock(s) {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** 2.345 -> "2.3 s", 75 -> "1:15" */
export function fmtSeconds(s) {
  if (s == null || !Number.isFinite(+s)) return "–";
  s = +s;
  return s < 60 ? `${s.toFixed(1)} s` : fmtClock(s);
}

/** ISO timestamp -> "14:02" today, else "Oct 3, 14:02". */
export function fmtWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === today.toDateString()
    ? time
    : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

/** Rough spoken length used for counters and ETAs (same as moss_core.estimate_seconds). */
export function estimateSeconds(text) {
  if (!text) return 0;
  let pauses = 0;
  for (const m of text.matchAll(/\[pause\s+([\d.]+)\s*s?\]/g)) pauses += parseFloat(m[1]) || 0;
  const plain = text.replace(/\[[^\]]*\]/g, " ").trim();
  return Math.round((plain.length / 15 + pauses) * 10) / 10;
}

/** Fire a bubbling, composed CustomEvent from a component. */
export function emit(el, type, detail = {}) {
  return el.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}

/** Show a transient message (handled by <moss-app>). kind: "info" | "error" | "ok". */
export function toast(message, kind = "info") {
  window.dispatchEvent(new CustomEvent("moss-toast", { detail: { message, kind } }));
}

/** Small inline SVG icons (stroke = currentColor). */
const ICONS = {
  play: '<path d="M7 5l12 7-12 7z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>',
  star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9 6.8 19.6l1-5.8L3.5 9.7l5.9-.8z"/>',
  starFill: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9 6.8 19.6l1-5.8L3.5 9.7l5.9-.8z" fill="currentColor"/>',
  download: '<path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21"/>',
  upload: '<path d="M12 16V5m0 0l-4 4m4-4l4 4M5 19h14"/>',
  trash: '<path d="M5 7h14M10 11v6M14 11v6M7 7l1 12h8l1-12M9 7V4h6v3"/>',
  refresh: '<path d="M20 12a8 8 0 11-2.3-5.7M20 4v5h-5"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 017.5-2"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.2" fill="currentColor"/><circle cx="15" cy="15" r="1.2" fill="currentColor"/><circle cx="15" cy="9" r="1.2" fill="currentColor"/><circle cx="9" cy="15" r="1.2" fill="currentColor"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  wave: '<path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 7v10"/>',
  loop: '<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 014-4h12M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 01-4 4H4"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5H5V6h5"/>',
  queue: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  up: '<path d="M12 19V5m0 0l-6 6m6-6l6 6"/>',
  down: '<path d="M12 5v14m0 0l-6-6m6 6l6-6"/>',
  pauseMark: '<path d="M8 6v12M16 6v12"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
};
export function icon(name, size = 16) {
  return raw(
    `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`,
  );
}
