import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "@xterm/xterm/css/xterm.css";
import "./theme.css";

// No StrictMode: its dev-only double-invocation of effects would double-spawn PTYs
// and dispose/recreate xterm instances, fighting the keep-alive design.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
