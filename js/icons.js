// Central icon set — one glyph per semantic action across the whole app.
// Feather-style outline SVGs (matches the dominant existing style). Replaces the
// previous mix of inline SVG / emoji / HTML entities / text glyphs.
//
// Usage:  import { icon } from "./icons.js";
//         `<button>${icon("edit")}</button>`
//         icon("edit", { size: 14 })          // override size
//         icon("edit", { cls: "my-class" })   // extra class on the <svg>
//
// All icons inherit color via `currentColor` and size via the `size` option
// (default 16). Add new actions here — never inline an emoji/entity again.

const PATHS = {
  edit:    `<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>`,
  add:     `<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>`,
  delete:  `<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>`,
  close:   `<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`,
  more:    `<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>`,
  back:    `<polyline points="15 18 9 12 15 6"/>`,
  forward: `<polyline points="9 6 15 12 9 18"/>`,
  filter:  `<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>`,
  search:  `<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>`,
  share:   `<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>`,
  help:    `<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>`,
  home:    `<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>`,
  refresh: `<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>`,
  chevronDown: `<polyline points="6 9 12 15 18 9"/>`,
};

export function icon(name, { size = 16, cls = "", strokeWidth = 2 } = {}) {
  const path = PATHS[name];
  if (!path) {
    console.warn(`icon(): unknown icon "${name}"`);
    return "";
  }
  const classAttr = cls ? ` class="${cls}"` : "";
  return `<svg${classAttr} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" width="${size}" height="${size}" aria-hidden="true">${path}</svg>`;
}

export function hasIcon(name) {
  return Object.prototype.hasOwnProperty.call(PATHS, name);
}
