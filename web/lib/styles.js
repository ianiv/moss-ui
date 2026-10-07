// Shared constructable stylesheets, adopted by the document and every shadow root.
// tokens: design tokens (custom properties, light + dark). base: element defaults. forms: controls, buttons, cards.

const sheet = (css) => {
  const s = new CSSStyleSheet();
  s.replaceSync(css);
  return s;
};

export const tokens = sheet(/* css */ `
@layer tokens {
  :root, :host {
    color-scheme: light dark;
    --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    --mono: ui-monospace, "SF Mono", Menlo, monospace;
    --fs-xs: 0.75rem; --fs-sm: 0.8125rem; --fs-md: 0.9375rem; --fs-lg: 1.125rem; --fs-xl: 1.375rem;
    --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 24px; --sp-6: 32px;
    --radius-sm: 6px; --radius: 10px; --radius-lg: 14px; --radius-pill: 999px;
    --shadow: 0 1px 2px rgb(0 0 0 / .06), 0 4px 16px rgb(0 0 0 / .06);
    --shadow-lg: 0 8px 40px rgb(0 0 0 / .18);
    --dur: 140ms;

    --bg: #f6f6f3;
    --surface: #ffffff;
    --surface-2: #f0f0ec;
    --surface-3: #e6e6e1;
    --border: #dcdcd5;
    --border-strong: #c3c3ba;
    --text: #1d1d1b;
    --text-2: #5c5c56;
    --text-3: #8a8a83;
    --accent: #2f6f5e;
    --accent-hover: #255a4c;
    --accent-text: #ffffff;
    --accent-soft: #e2efe9;
    --danger: #b3261e;
    --danger-soft: #fbe9e7;
    --warn: #9a6700;
    --warn-soft: #fff4d6;
    --ok: #2e7d32;
    --wave: #9db8ae;
    --wave-played: var(--accent);
    --region: rgb(47 111 94 / .16);
    --focus: 0 0 0 3px rgb(47 111 94 / .35);
  }
  @media (prefers-color-scheme: dark) {
    :root, :host {
      --bg: #141513;
      --surface: #1c1d1b;
      --surface-2: #242522;
      --surface-3: #2e2f2b;
      --border: #353631;
      --border-strong: #4a4b45;
      --text: #ecece7;
      --text-2: #b0b0a8;
      --text-3: #84847d;
      --accent: #6cc3a6;
      --accent-hover: #86d3b9;
      --accent-text: #0e1f19;
      --accent-soft: #1f3a31;
      --danger: #f2827a;
      --danger-soft: #3a1f1d;
      --warn: #e6b450;
      --warn-soft: #3a3020;
      --ok: #7fcf86;
      --wave: #4d6b60;
      --region: rgb(108 195 166 / .18);
      --focus: 0 0 0 3px rgb(108 195 166 / .4);
      --shadow: 0 1px 2px rgb(0 0 0 / .4), 0 4px 16px rgb(0 0 0 / .3);
    }
  }
}
`);

export const base = sheet(/* css */ `
@layer base {
  :host { font-family: var(--font); color: var(--text); box-sizing: border-box; }
  *, *::before, *::after { box-sizing: border-box; }
  [hidden] { display: none !important; }
  h1, h2, h3, h4 { margin: 0; font-weight: 600; line-height: 1.25; }
  h2 { font-size: var(--fs-xl); }
  h3 { font-size: var(--fs-lg); }
  h4 { font-size: var(--fs-md); }
  p { margin: 0; line-height: 1.5; }
  a { color: var(--accent); }
  code, kbd { font-family: var(--mono); font-size: .9em; }
  kbd { border: 1px solid var(--border-strong); border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; background: var(--surface-2); }
  .muted { color: var(--text-2); }
  .faint { color: var(--text-3); }
  .small { font-size: var(--fs-sm); }
  .xs { font-size: var(--fs-xs); }
  .mono { font-family: var(--mono); }
  .row { display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; }
  .row.end { justify-content: flex-end; }
  .row.between { justify-content: space-between; }
  .stack { display: grid; gap: var(--sp-3); align-content: start; }
  .stack.tight { gap: var(--sp-2); }
  .stack.loose { gap: var(--sp-4); }
  .grow { flex: 1 1 auto; min-width: 0; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--sp-4); box-shadow: var(--shadow); }
  .badge { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-xs); padding: 2px 8px; border-radius: var(--radius-pill); background: var(--surface-2); color: var(--text-2); border: 1px solid var(--border); white-space: nowrap; }
  .badge.accent { background: var(--accent-soft); color: var(--accent); border-color: transparent; }
  .badge.warn { background: var(--warn-soft); color: var(--warn); border-color: transparent; }
  .badge.danger { background: var(--danger-soft); color: var(--danger); border-color: transparent; }
  .empty { text-align: center; color: var(--text-3); padding: var(--sp-6) var(--sp-4); border: 1px dashed var(--border-strong); border-radius: var(--radius-lg); }
  .error { color: var(--danger); background: var(--danger-soft); border-radius: var(--radius); padding: var(--sp-2) var(--sp-3); font-size: var(--fs-sm); }
  .notice { color: var(--warn); background: var(--warn-soft); border-radius: var(--radius); padding: var(--sp-2) var(--sp-3); font-size: var(--fs-sm); }
  .spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; display: inline-block; animation: spin .8s linear infinite; vertical-align: -2px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes pulse { 50% { opacity: .45; } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2.4s; } }
}
`);

export const forms = sheet(/* css */ `
@layer forms {
  label, .label { font-size: var(--fs-sm); font-weight: 500; color: var(--text-2); display: block; }
  .field { display: grid; gap: 6px; align-content: start; }
  .hint { font-size: var(--fs-xs); color: var(--text-3); }
  input:not([type=checkbox], [type=radio], [type=range], [type=file]), select, textarea {
    font: inherit; font-size: var(--fs-md); color: var(--text); background: var(--surface);
    border: 1px solid var(--border-strong); border-radius: var(--radius); padding: 8px 10px; width: 100%;
    transition: border-color var(--dur), box-shadow var(--dur);
  }
  textarea { resize: vertical; line-height: 1.5; min-height: 4.5em; }
  input:focus-visible, select:focus-visible, textarea:focus-visible { outline: none; border-color: var(--accent); box-shadow: var(--focus); }
  input:disabled, select:disabled, textarea:disabled { opacity: .55; cursor: not-allowed; }
  input[type=checkbox], input[type=radio], input[type=range] { accent-color: var(--accent); }
  .check { display: inline-flex; gap: 8px; align-items: center; font-size: var(--fs-sm); color: var(--text); font-weight: 400; cursor: pointer; }
  button, .btn {
    font: inherit; font-size: var(--fs-sm); font-weight: 500; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    padding: 7px 12px; border-radius: var(--radius); border: 1px solid var(--border-strong); background: var(--surface);
    color: var(--text); cursor: pointer; text-decoration: none; white-space: nowrap; line-height: 1.2;
    transition: background var(--dur), border-color var(--dur), color var(--dur);
  }
  button:hover:not(:disabled), .btn:hover { background: var(--surface-2); }
  button:focus-visible, .btn:focus-visible { outline: none; box-shadow: var(--focus); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  button.primary, .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
  button.primary:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); }
  button.danger { color: var(--danger); }
  button.danger:hover:not(:disabled) { background: var(--danger-soft); }
  button.ghost, .btn.ghost { border-color: transparent; background: transparent; }
  button.ghost:hover:not(:disabled), .btn.ghost:hover { background: var(--surface-2); }
  button.icon { padding: 6px; min-width: 32px; min-height: 32px; }
  button.small, .btn.small { padding: 4px 8px; font-size: var(--fs-xs); }
  button.big { padding: 10px 18px; font-size: var(--fs-md); }
  button[aria-pressed=true] { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
  .seg { display: inline-flex; border: 1px solid var(--border-strong); border-radius: var(--radius); overflow: hidden; }
  .seg > label { margin: 0; }
  .seg input { position: absolute; opacity: 0; pointer-events: none; }
  .seg span { display: block; padding: 6px 12px; font-size: var(--fs-sm); cursor: pointer; color: var(--text-2); }
  .seg input:checked + span { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
  .seg input:focus-visible + span { box-shadow: inset var(--focus); }
  .seg input:disabled + span { opacity: .45; cursor: not-allowed; }
  dialog { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); color: var(--text); padding: var(--sp-5); box-shadow: var(--shadow-lg); max-width: min(560px, calc(100vw - 32px)); width: 100%; }
  dialog::backdrop { background: rgb(0 0 0 / .35); }
  [popover] { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--text); box-shadow: var(--shadow-lg); padding: var(--sp-2); }
  details > summary { cursor: pointer; font-size: var(--fs-sm); font-weight: 600; color: var(--text-2); user-select: none; }
  fieldset { border: 1px solid var(--border); border-radius: var(--radius); padding: var(--sp-3); margin: 0; min-width: 0; }
  legend { font-size: var(--fs-sm); color: var(--text-2); padding: 0 4px; }
}
`);

/** Layout helpers for workflow views: form column + results column, switching on container width. */
export const viewLayout = sheet(/* css */ `
@layer view {
  :host { display: block; container-type: inline-size; }
  .view-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-3); margin-bottom: var(--sp-4); flex-wrap: wrap; }
  .view-head p { color: var(--text-2); font-size: var(--fs-sm); max-width: 70ch; }
  .layout { display: grid; gap: var(--sp-5); grid-template-columns: minmax(0, 1fr); align-items: start; }
  @container (min-width: 900px) {
    .layout { grid-template-columns: minmax(340px, 5fr) minmax(0, 6fr); }
    .layout > .results { position: sticky; top: var(--sp-4); }
  }
  form.stack { gap: var(--sp-4); }
  .actions { display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; }
}
`);

export const shared = [tokens, base, forms];

/** Adopt the shared sheets (plus extras) into a shadow root. */
export function adopt(root, ...extra) {
  root.adoptedStyleSheets = [...shared, ...extra];
}

/** Make a one-off sheet for a component (create once at module level). */
export const css = (strings, ...vals) => sheet(String.raw({ raw: strings }, ...vals));

document.adoptedStyleSheets = [...document.adoptedStyleSheets, tokens];
