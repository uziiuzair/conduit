import { useStore } from "../store";
import type { TerminalRenderer } from "../terminalRenderer";
import { Dropdown } from "./Dropdown";

/** Settings → Terminal: how terminal panes are drawn. */
export function TerminalSettings() {
  const terminalRenderer = useStore((s) => s.terminalRenderer);
  const setTerminalRenderer = useStore((s) => s.setTerminalRenderer);

  return (
    <div className="usage-prefs">
      <div className="usage-prefs-section">
        <div className="usage-prefs-title">Renderer</div>
        <Dropdown
          className="dd-settings"
          value={terminalRenderer}
          options={[
            { value: "webgl", label: "WebGL (default)" },
            { value: "canvas", label: "Canvas" },
          ]}
          onChange={(v) => setTerminalRenderer(v as TerminalRenderer)}
        />
        <em className="dialog-hint">
          WebGL draws each pane in one GPU pass, which keeps heavy output and fast scrolling
          smooth. It costs one GPU context per open pane, and the system caps how many can exist
          at once — with a great many panes open, the oldest lose their context and fall back to
          canvas on their own. Choose Canvas to rasterize on the CPU instead: steadier with a
          large fleet of sessions, slower under a flood of output. Changing this repaints every
          open pane; sessions and scrollback are unaffected.
        </em>
      </div>
    </div>
  );
}
