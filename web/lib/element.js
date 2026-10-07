// Base class for moss-ui components: open shadow root with the shared sheets, a per-connection
// AbortSignal for listeners (removed automatically on disconnect), and small conveniences.
import { adopt } from "./styles.js";
import { frag } from "./dom.js";

export class MossElement extends HTMLElement {
  /** Override: extra CSSStyleSheets for this component. */
  static styles = [];

  constructor() {
    super();
    this.attachShadow({ mode: "open", delegatesFocus: this.constructor.delegatesFocus ?? false });
    adopt(this.shadowRoot, ...this.constructor.styles);
    this._rendered = false;
  }

  connectedCallback() {
    this._abort = new AbortController();
    if (!this._rendered) {
      this._rendered = true;
      this.render();
    }
    this.connected?.();
  }

  disconnectedCallback() {
    this._abort?.abort();
    this.disconnected?.();
  }

  /** AbortSignal that fires on disconnect: pass to addEventListener / store.on. */
  get signal() {
    return this._abort?.signal;
  }

  /** Listen on any EventTarget until disconnect. */
  on(target, type, fn, opts = {}) {
    target.addEventListener(type, fn, { ...opts, signal: this.signal });
  }

  /** Override: build the shadow DOM once (first connect). */
  render() {}

  /** Replace the shadow content with markup (string or html`` result), keeping adopted sheets. */
  setHTML(markup) {
    this.shadowRoot.replaceChildren(frag(markup));
  }

  $(sel) {
    return this.shadowRoot.querySelector(sel);
  }

  $$(sel) {
    return [...this.shadowRoot.querySelectorAll(sel)];
  }
}

/** Define a custom element once (safe to import modules twice). */
export function define(name, cls) {
  if (!customElements.get(name)) customElements.define(name, cls);
}
