// Entry point: shared styles on the document, the app shell, and the store.
import "./lib/styles.js";
import "./components/moss-app.js";
import { store } from "./lib/store.js";

store.init().catch((e) => {
  console.error(e);
  window.dispatchEvent(new CustomEvent("moss-toast", { detail: { message: `Couldn't load app state: ${e.message}`, kind: "error" } }));
});

window.mossStore = store; // handy from the devtools console
