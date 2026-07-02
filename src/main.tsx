import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useStore } from "./store";
import { applyTheme, resolveThemeId, readStoredPref, systemPrefersDark, watchSystemTheme } from "./themes";
import { initMonaco } from "./monaco/setup";
import "@xterm/xterm/css/xterm.css";
import "./theme.css";

// Apply the saved theme BEFORE the first paint so there is no flash of the
// default palette when launching into a non-default theme.
applyTheme(resolveThemeId(readStoredPref(), systemPrefersDark()));

// Boot Monaco once: worker wiring, Monarch languages, themes, model factory.
// (applyTheme above ran first; its Monaco recolor was a no-op until this registers the setter.)
initMonaco();

// Keep Auto mode in sync with the macOS light/dark appearance.
watchSystemTheme((dark) => useStore.getState().applySystemDark(dark));

// No StrictMode: its dev-only double-invocation of effects would double-spawn PTYs
// and dispose/recreate xterm instances, fighting the keep-alive design.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
